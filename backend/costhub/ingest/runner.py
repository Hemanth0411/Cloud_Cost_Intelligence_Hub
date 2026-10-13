"""Ingest orchestration.

One `ingest_runs` row per connection per window, written *before* fetching
so a crash leaves a visibly stuck `running` row rather than silently
nothing -- and `stale.reap_stale_runs` later closes it, since a killed
process cannot. A failure on one connection never aborts the others.

Writes are idempotent: AWS restates cost as it finalises, so recent days
are re-fetched on every run and land via ON CONFLICT DO UPDATE against the
fact table's natural key.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date
from typing import Callable, Iterable, Sequence

from costhub.connections import store
from costhub.connections.credentials import Connection, CredentialError
from costhub.db import connect
from costhub.ingest.errors import ExpectedIngestError
from costhub.ingest.ports import CostRow
from costhub.ingest.stale import reap_stale_runs

log = logging.getLogger(__name__)

BATCH = 500

# The natural key is what makes re-ingestion safe. `source` is deliberately
# NOT part of it: a given account/service/day has one true cost, whichever
# adapter fetched it.
UPSERT = """
INSERT INTO fact_cost_daily
  (provider, account_id, service_name, region, charge_category, usage_date,
   billed_cost, effective_cost, currency, ingest_run_id, source,
   created_by, updated_by)
VALUES (%(provider)s, %(account_id)s, %(service_name)s, %(region)s,
        %(charge_category)s, %(usage_date)s, %(billed_cost)s,
        %(effective_cost)s, %(currency)s, %(run_id)s, %(source)s,
        %(actor)s, %(actor)s)
ON CONFLICT (provider, account_id, service_name, region,
             charge_category, usage_date, currency)
DO UPDATE SET
  billed_cost    = EXCLUDED.billed_cost,
  effective_cost = EXCLUDED.effective_cost,
  ingest_run_id  = EXCLUDED.ingest_run_id,
  source         = EXCLUDED.source,
  updated_at     = now(),
  updated_by     = EXCLUDED.updated_by,
  revision       = fact_cost_daily.revision + 1
"""

DIM_ACCOUNT = """
INSERT INTO dim_account (provider, account_id, account_name, created_by, updated_by)
VALUES (%(provider)s, %(account_id)s, %(name)s, %(actor)s, %(actor)s)
ON CONFLICT (provider, account_id) DO UPDATE SET
  account_name = EXCLUDED.account_name,
  updated_at = now(), updated_by = EXCLUDED.updated_by,
  revision = dim_account.revision + 1
"""

DIM_SERVICE = """
INSERT INTO dim_service (provider, service_name, created_by, updated_by)
VALUES (%(provider)s, %(service_name)s, %(actor)s, %(actor)s)
ON CONFLICT (provider, service_name) DO NOTHING
"""


@dataclass
class RunResult:
    connection: str
    account_id: str
    status: str
    rows: int = 0
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.status == "success"


SourceFactory = Callable[[Connection], object]


def ingest(
    *,
    source_factory: SourceFactory,
    start: date,
    end: date,
    triggered_by: str,
    connections: Sequence[Connection] | None = None,
) -> list[RunResult]:
    """Fetch and store cost for every enabled connection.

    `source_factory` turns a Connection into something with `.name` and
    `.fetch(account_id=, start=, end=)` -- the CostSource port. That is the
    seam that makes mock, Cost Explorer and Azure interchangeable.
    """
    reap_stale_runs()
    targets = list(connections if connections is not None else store.enabled())
    if not targets:
        log.warning("no enabled connections; nothing to ingest")
        return []

    results: list[RunResult] = []
    for conn in targets:
        results.append(
            _ingest_one(
                conn=conn,
                source_factory=source_factory,
                start=start,
                end=end,
                triggered_by=triggered_by,
            )
        )
    return results


def _ingest_one(
    *,
    conn: Connection,
    source_factory: SourceFactory,
    start: date,
    end: date,
    triggered_by: str,
) -> RunResult:
    try:
        source = source_factory(conn)
    except (CredentialError, ExpectedIngestError) as exc:
        # A missing adapter or an unusable credential is configuration.
        # Report it and carry on to the next connection.
        log.error("%s: %s", conn.display_name, exc)
        # Stamp the connection too, even though no run row exists yet:
        # otherwise the connections screen shows "never attempted" for
        # something that just failed, which is worse than saying nothing.
        store.record_ingest(connection_id=conn.id, status="failed")
        return RunResult(conn.display_name, conn.account_id, "failed", error=str(exc))

    source_name = getattr(source, "name", "unknown")
    run_id = _start_run(conn, source_name, start, end, triggered_by)

    try:
        rows = source.fetch(account_id=conn.account_id, start=start, end=end)  # type: ignore[attr-defined]
        written = _write(conn, run_id, source_name, rows, triggered_by)
    except ExpectedIngestError as exc:
        # Missing permissions are configuration, not a defect. Report the
        # fix; a traceback here is noise that hides the actionable line.
        finally_close(source)
        log.error("%s: %s", conn.display_name, exc)
        _finish_run(run_id, "failed", 0, str(exc)[:2000], triggered_by)
        store.record_ingest(connection_id=conn.id, status="failed")
        return RunResult(conn.display_name, conn.account_id, "failed", error=str(exc))
    except Exception as exc:  # one bad account must not stop the rest
        finally_close(source)
        log.exception("%s: ingest failed", conn.display_name)
        _finish_run(run_id, "failed", 0, str(exc)[:2000], triggered_by)
        store.record_ingest(connection_id=conn.id, status="failed")
        return RunResult(conn.display_name, conn.account_id, "failed", error=str(exc))

    finally_close(source)
    _finish_run(run_id, "success", written, None, triggered_by)
    store.record_ingest(connection_id=conn.id, status="success")
    log.info("%s: %d rows", conn.display_name, written)
    return RunResult(conn.display_name, conn.account_id, "success", rows=written)


def finally_close(source: object) -> None:
    """Release an adapter's transport if it has one.

    `AzureCostManagementSource.close()` was added to stop a warm Lambda
    container accumulating one httpx pool per connection per
    invocation -- but nothing ever called it, so the leak it was written
    for was still live.
    """
    close = getattr(source, "close", None)
    if callable(close):
        try:
            close()
        except Exception:  # never fail an otherwise-good run on cleanup
            log.warning("failed to close source transport", exc_info=True)


def _start_run(
    conn: Connection, source: str, start: date, end: date, actor: str
) -> str:
    with connect() as db, db.cursor() as cur:
        cur.execute(
            """
            INSERT INTO ingest_runs
              (source, provider, account_id, connection_id,
               period_start, period_end, status, triggered_by,
               created_by, updated_by)
            VALUES (%(src)s, %(p)s, %(a)s, %(c)s, %(s)s, %(e)s,
                    'running', %(actor)s, %(actor)s, %(actor)s)
            RETURNING id
            """,
            {
                "src": source, "p": conn.provider, "a": conn.account_id,
                "c": conn.id, "s": start, "e": end, "actor": actor,
            },
        )
        row = cur.fetchone()
        assert row is not None
        return str(row["id"])


def _finish_run(
    run_id: str, status: str, rows: int, error: str | None, actor: str
) -> None:
    with connect() as db, db.cursor() as cur:
        cur.execute(
            """
            UPDATE ingest_runs
               SET status = %(st)s, rows_written = %(n)s, error = %(err)s,
                   finished_at = now(), updated_at = now(), updated_by = %(actor)s,
                   revision = revision + 1
             WHERE id = %(id)s
            """,
            {"id": run_id, "st": status, "n": rows, "err": error, "actor": actor},
        )


def _write(
    conn: Connection,
    run_id: str,
    source: str,
    rows: Iterable[CostRow],
    actor: str,
) -> int:
    """Upsert in batches, keeping dimensions in step."""
    written = 0
    services: set[str] = set()
    batch: list[dict] = []

    with connect() as db, db.cursor() as cur:
        cur.execute(
            DIM_ACCOUNT,
            {
                "provider": conn.provider,
                "account_id": conn.account_id,
                "name": conn.display_name,
                "actor": actor,
            },
        )

        for row in rows:
            batch.append(
                {
                    "provider": row.provider,
                    "account_id": row.account_id,
                    "service_name": row.service_name,
                    "region": row.region,
                    "charge_category": row.charge_category,
                    "usage_date": row.usage_date,
                    "billed_cost": row.billed_cost,
                    "effective_cost": row.effective_cost,
                    "currency": row.currency,
                    "run_id": run_id,
                    "source": source,
                    "actor": actor,
                }
            )
            services.add(row.service_name)

            if len(batch) >= BATCH:
                cur.executemany(UPSERT, batch)
                written += len(batch)
                batch.clear()

        if batch:
            cur.executemany(UPSERT, batch)
            written += len(batch)

        if services:
            cur.executemany(
                DIM_SERVICE,
                [
                    {"provider": conn.provider, "service_name": s, "actor": actor}
                    for s in sorted(services)
                ],
            )

    return written
