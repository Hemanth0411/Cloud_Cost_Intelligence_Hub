"""The narration ledger: the cache, the meter, and the lock.

`/insights` is a page load and every uncached load is a Bedrock call,
so the cache is not an optimisation: without it the endpoint is a bill.
It lives in Postgres rather than in memory because the API runs on
Lambda -- a per-container dict is lost on every cold start and is not
shared between the containers serving one dashboard.

One row per call ATTEMPT, never updated in place except to record how
it ended:

    reserve()   INSERT 'pending'   before Bedrock is called
    complete()  -> 'done'          with the model's choices
    fail()      -> 'failed'

Three things follow from writing the row first:

  * if the table cannot be written, that is discovered BEFORE spending
  * every attempt is counted, including one that timed out, crashed, or
    was never recorded as finished -- so the meter cannot undercount
  * a second identical request finds the reservation and does not pay
    for the same answer again

What is stored is the model's CHOICES -- card ids and integers. Never a
figure, a name or a sentence. Figures are recomputed through
`query/scoped` on every request, so a revoked grant takes effect at
once whatever is stored here.

Lifetime: `INSIGHTS_CACHE_TTL_HOURS` (default 24), or sooner if anything
in the key changes -- a new ingest (`as_of`), a filter, a figure, the
model, the prompt, or the candidate sentences.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import datetime
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from costhub.db import connect, execute, fetch_one
from costhub.insights.cards import Card
from costhub.query.scoped import Filters, Principal

log = logging.getLogger(__name__)

# A reservation older than this belongs to a request that died (the
# Lambda was killed, the container recycled). It stops blocking others,
# and still counts as a call.
STALE_PENDING_SECONDS = 45
PRUNE_AFTER_DAYS = 8


class CacheUnavailable(Exception):
    pass


def _env_int(name: str, default: int, low: int, high: int) -> int:
    """A setting that cannot take the endpoint down by being mistyped."""
    try:
        return max(low, min(high, int(os.environ.get(name, "").strip() or default)))
    except ValueError:
        log.warning("insights: %s is not a whole number; using %d", name, default)
        return default


def ttl_hours() -> int:
    # Floor of 1: at 0 every load would be a miss, and a bill.
    return _env_int("INSIGHTS_CACHE_TTL_HOURS", 24, 1, 720)


def daily_call_budget() -> int:
    """Model calls allowed per rolling 24h, across all users. 0 disables."""
    return _env_int("INSIGHTS_DAILY_CALL_BUDGET", 500, 0, 1_000_000)


def user_daily_call_budget() -> int:
    """... and by any one user, so a single caller cycling through date
    ranges cannot spend the whole allowance and turn prose off for
    everyone else. 0 disables."""
    return _env_int("INSIGHTS_USER_DAILY_CALL_BUDGET", 100, 0, 1_000_000)


def key(
    who: Principal, current: Filters, previous: Filters, as_of: datetime | None,
    cards: list[Card], candidates: dict[str, list[str]], model_id: str, version: str,
) -> str:
    """Per (principal, filters, as_of) -- and per figure, model and wording.

    The candidate sentences are in the key because a stored choice is an
    index into them: it must never be applied to a different list.
    """
    payload = {
        "user": who.user_id,
        "model": model_id,
        "version": version,
        "as_of": as_of.isoformat() if as_of else None,
        "filters": [
            str(current.start), str(current.end),
            str(previous.start), str(previous.end),
            current.provider, current.account_id, current.service_name,
            current.metric,
        ],
        "cards": [[c.id, c.kind, c.direction, sorted(c.display.items()),
                   candidates.get(c.id, [])] for c in cards],
    }
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _guard(what: str):
    """Turn any database failure into CacheUnavailable, loudly."""
    def wrap(fn):
        def inner(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except psycopg.Error as exc:
                log.error("insights: ledger %s failed: %s", what, exc)
                raise CacheUnavailable(str(exc))
        return inner
    return wrap


@_guard("read")
def get(cache_key: str, who: Principal) -> dict[str, Any] | None:
    """The newest finished, unexpired entry for this key, or None.

    The caller's id is already inside the key's hash. It is matched
    again here as a column, so isolation between users does not rest on
    the key construction alone.
    """
    return fetch_one(
        """
        SELECT result, model_id, created_at, expires_at
        FROM insight_narrations
        WHERE cache_key = %(k)s AND user_id = %(u)s
          AND status = 'done' AND expires_at > now()
        ORDER BY created_at DESC
        LIMIT 1
        """,
        {"k": cache_key, "u": who.user_id},
    )


@_guard("meter")
def calls_in_last_day(who: Principal) -> tuple[int, int]:
    """(all users, this user). Every row is an attempt, whatever became of it."""
    row = fetch_one(
        """
        SELECT count(*) AS everyone,
               count(*) FILTER (WHERE user_id = %(u)s) AS mine
        FROM insight_narrations
        WHERE created_at > now() - interval '24 hours'
        """,
        {"u": who.user_id},
    )
    return (int(row["everyone"]), int(row["mine"])) if row else (0, 0)


@_guard("reserve")
def reserve(cache_key: str, who: Principal, model_id: str) -> str | None:
    """Claim the right to make one call for this key.

    Returns the reservation id, or None when another request already
    holds one -- in which case this request must not call the model.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE insight_narrations SET status = 'failed'
            WHERE cache_key = %(k)s AND status = 'pending'
              AND created_at < now() - make_interval(secs => %(stale)s)
            """,
            {"k": cache_key, "stale": STALE_PENDING_SECONDS},
        )
        cur.execute(
            """
            INSERT INTO insight_narrations (cache_key, user_id, model_id)
            VALUES (%(k)s, %(u)s, %(m)s)
            ON CONFLICT (cache_key) WHERE status = 'pending' DO NOTHING
            RETURNING id
            """,
            {"k": cache_key, "u": who.user_id, "m": model_id},
        )
        row = cur.fetchone()
    return str(row["id"]) if row else None


@_guard("write")
def complete(
    reservation: str, result: dict[str, Any], input_tokens: int, output_tokens: int,
    *, hours: int,
) -> dict[str, Any] | None:
    """Record what the call returned. The stored row, or None if it vanished."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE insight_narrations
               SET status = 'done', result = %(r)s,
                   input_tokens = %(i)s, output_tokens = %(o)s,
                   expires_at = now() + make_interval(hours => %(ttl)s)
             WHERE id = %(id)s
            RETURNING created_at, expires_at
            """,
            {"id": reservation, "r": Jsonb(result), "i": input_tokens,
             "o": output_tokens, "ttl": hours},
        )
        return cur.fetchone()


def fail(reservation: str) -> None:
    """Release a reservation after a failed call. Best effort: a row left
    'pending' goes stale on its own and is counted either way."""
    try:
        execute(
            "UPDATE insight_narrations SET status = 'failed' "
            "WHERE id = %(id)s AND status = 'pending'",
            {"id": reservation},
        )
    except psycopg.Error as exc:
        log.warning("insights: could not release reservation: %s", exc)


def prune() -> None:
    """Drop rows past any use. Its own statement, so it can never undo a write."""
    try:
        execute(
            "DELETE FROM insight_narrations "
            "WHERE created_at < now() - make_interval(days => %(d)s)",
            {"d": PRUNE_AFTER_DAYS},
        )
    except psycopg.Error as exc:
        log.warning("insights: prune failed: %s", exc)
