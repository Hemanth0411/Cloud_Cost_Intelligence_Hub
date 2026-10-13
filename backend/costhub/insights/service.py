"""The order things happen in, and every way narration degrades.

    1. figures     facts.summarize -- always, through query/scoped
    2. candidates  frames.candidates -- the sentences that may be shown
    3. cache       a stored set of choices for exactly these candidates
    4. budget      refuse to spend past the daily allowance
    5. reserve     write the ledger row BEFORE calling
    6. model       one Bedrock call, hard-timed
    7. select      apply the choices; anything invalid leaves no sentence

Steps 3-6 can each fail. None of them can fail the request: the caller
always gets the figures, and `narration.status` / `narration.reason`
say truthfully what happened to the prose. There is no fallback text --
a card with `text: null` is a card whose sentence was not chosen.
"""
from __future__ import annotations

import logging
import os
import time
from datetime import datetime
from typing import Any

from costhub.insights import cache, facts, frames, narrate
from costhub.insights.cards import Card
from costhub.insights.facts import Summary
from costhub.query.scoped import Filters, Principal

log = logging.getLogger(__name__)

# After a failed call, do not try again from this container for a while.
# A timeout costs the user seconds and may still be billed, and an
# outage would otherwise be re-discovered by every page load.
BREAKER_SECONDS = 60.0
_breaker: tuple[float, str] = (0.0, "")     # (skip until, why) -- one atomic value

# An answer that chose for fewer than half the cards is kept for an
# hour, not a day: long enough that a reload does not pay again, short
# enough that one bad draw does not leave a view bare until tomorrow.
POOR_REPLY_TTL_HOURS = 1


def enabled() -> bool:
    return os.environ.get("INSIGHTS_ENABLED", "true").strip().lower() not in (
        "0", "false", "no", "off",
    )


def reset_breaker() -> None:
    global _breaker
    _breaker = (0.0, "")


def _trip(reason: str) -> None:
    global _breaker
    _breaker = (time.monotonic() + BREAKER_SECONDS, reason)


def _choices(
    who: Principal, current: Filters, previous: Filters, as_of: datetime | None,
    cards: list[Card], candidates: dict[str, list[str]],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """The choices for these cards -- cached, or from one model call --
    and how they were obtained. Raises `narrate.Unavailable` otherwise.
    """
    model = narrate.model_id()
    version = f"{narrate.PROMPT_VERSION}.{frames.FRAMES_VERSION}"
    cache_key = cache.key(who, current, previous, as_of, cards, candidates, model, version)
    try:
        row = cache.get(cache_key, who)
        if row is not None and isinstance(row["result"], dict):
            return row["result"], {
                "cached": True, "model": row["model_id"],
                "generated_at": row["created_at"], "expires_at": row["expires_at"],
            }
        until, why = _breaker
        if time.monotonic() < until:
            # The cause is still the earlier failure; say that no new
            # attempt was made rather than implying one just failed.
            log.info("insights: skipping bedrock, breaker open (%s)", why)
            raise narrate.Unavailable(why, "recent failure, not retried")
        everyone, mine = cache.calls_in_last_day(who)
        budget, own = cache.daily_call_budget(), cache.user_daily_call_budget()
        if (budget and everyone >= budget) or (own and mine >= own):
            log.warning("insights: call budget reached (all=%d/%d user=%d/%d)",
                        everyone, budget, mine, own)
            raise narrate.Unavailable("budget")
        # Written before the call: proves the ledger is writable before
        # any money is spent, counts the attempt whatever happens next,
        # and stops a second identical request paying for the same thing.
        reservation = cache.reserve(cache_key, who, model)
    except cache.CacheUnavailable:
        raise narrate.Unavailable("cache_unavailable")
    if reservation is None:
        raise narrate.Unavailable("in_progress")

    try:
        result = narrate.choose(cards, candidates)
    except narrate.Unavailable as exc:
        _trip(exc.reason)
        cache.fail(reservation)
        raise
    except BaseException:
        cache.fail(reservation)
        raise

    texts, _, kept = frames.select(cards, result.choices)
    # Only valid choices are stored: card ids we issued, integers in range.
    entry = {"choices": kept, "lead": frames.lead(cards, result.lead, texts)}
    answerable = sum(1 for c in cards if candidates.get(c.id))
    hours = POOR_REPLY_TTL_HOURS if len(kept) * 2 < answerable else cache.ttl_hours()
    how = {"cached": False, "model": model, "generated_at": None, "expires_at": None}
    try:
        row = cache.complete(reservation, entry, result.input_tokens,
                             result.output_tokens, hours=hours)
    except cache.CacheUnavailable:
        row = None
    if row is None:
        # Paid for and not remembered. The reservation still counts it;
        # pause so this container does not pay again a moment later.
        _trip("cache_unavailable")
        return entry, {**how, "stored": False}
    cache.prune()
    return entry, {**how, "generated_at": row["created_at"],
                   "expires_at": row["expires_at"]}


def _card_json(card: Card, text: str | None) -> dict[str, Any]:
    return {
        "id": card.id,
        "kind": card.kind,
        "title": card.title,
        "direction": card.direction,
        "subject": card.subject,
        "figures": card.figures,
        "display": card.display,
        "text": text,
    }


def build(
    who: Principal, current: Filters, previous: Filters,
    findings: list[dict], as_of: datetime | None, *, want_narration: bool = True,
    findings_complete: bool = True,
) -> tuple[list[dict], Summary, dict[str, Any]]:
    """Cards (figures always, a sentence when one was chosen) and the report."""
    summary = facts.summarize(who, current, previous, findings,
                              findings_complete=findings_complete)
    cards = summary.cards
    report: dict[str, Any] = {
        "status": "unavailable", "reason": None, "model": None,
        "cached": False, "stored": True,
        "generated_at": None, "expires_at": None,
        "narrated": 0, "withheld": 0,
        # card id -> why it has no sentence. Our own constants only.
        "refused": {},
        # The card the model would show first. Editorial, not a claim.
        "lead": None,
    }

    texts: dict[str, str] = {}
    if not cards:
        report.update(status="no_data")
    elif not want_narration:
        report.update(status="off", reason="not_requested")
    elif not enabled():
        report.update(status="off", reason="disabled")
    else:
        try:
            candidates = {c.id: frames.candidates(c) for c in cards}
            entry, how = {}, {}
            if any(candidates.values()):        # else nothing to choose between
                entry, how = _choices(who, current, previous, as_of, cards, candidates)
            texts, refused, _ = frames.select(cards, entry.get("choices"))
            report.update(how, narrated=len(texts), withheld=len(refused),
                          refused=refused,
                          lead=frames.lead(cards, entry.get("lead"), texts))
            if not refused:
                report.update(status="ok")
            elif texts:
                report.update(status="partial")
            else:
                report.update(reason="no_valid_choice")
        except narrate.Unavailable as exc:
            report.update(reason=exc.reason)
        except Exception:
            # Narration is optional; the figures are not. Whatever went
            # wrong in here must not take them down with it.
            log.exception("insights: narration failed unexpectedly")
            _trip("internal_error")
            texts = {}
            report.update(status="unavailable", reason="internal_error",
                          narrated=0, withheld=0, refused={}, lead=None)

    return [_card_json(c, texts.get(c.id)) for c in cards], summary, report
