"""Closing ingest runs whose process died before it could.

`runner._start_run` commits an `ingest_runs` row as `running` BEFORE
fetching, so that a crash leaves something visible rather than nothing.
That was only half a design. When the process is killed mid-fetch --
API Gateway cuts an on-demand import at 29s, the Lambda at 30 --
`_write` never commits, so there are no partial cost rows; that part was
always sound. But `_finish_run` never executes either: the run stayed
`running` forever, nothing reconciled it, and the connection kept
showing its PREVIOUS outcome, a "success" from before the attempt that
died.

A killed process cannot close its own row, so something else has to.
`reap_stale_runs` is called before every ingest and before everything
that displays these columns: the two admin listings, and the CLI's
`list-connections` and `status`.

It bounds the lie rather than removing it. For `STALE_RUN_MINUTES`
after a timeout the run still reads `running` and the connection still
shows its earlier result -- which is also exactly what a slow run that
is genuinely alive looks like, and the two cannot be told apart sooner.

Its own module rather than part of runner.py for the line limit
(NFR-18), and because it is the one piece of ingest the API calls
without ingesting anything.
"""
from __future__ import annotations

import logging

from costhub.config import settings
from costhub.db import connect

log = logging.getLogger(__name__)

# How long a run may sit in `running` before it is declared dead.
#
# 15 minutes is the longest any Lambda can live at all (ours are
# configured for 30s on the API and 600s on the scheduled ingest), so a
# Lambda-started run older than this did not finish and never will. The
# CLI has no such ceiling, but one run is one connection, and the
# longest on record here -- a four-month backfill of the busiest
# account -- took 14 seconds. If a slow backfill is ever reaped while
# still alive it corrects itself: `_finish_run` updates by id and
# overwrites the verdict, and `record_ingest` restamps the connection.
STALE_RUN_MINUTES = 15
# "Almost certainly", not "no rows": the fetch and write are one
# transaction that a kill rolls back, but a process that dies in the few
# milliseconds between that commit and `_finish_run` leaves saved rows
# behind a run this closes as failed.
STALE_RUN_ERROR = (
    "Did not finish: the process running this import stopped before it could "
    "record a result (most likely a timeout). Almost certainly no cost rows "
    "from it were saved; the next import re-fetches the same days either way."
)

# One statement, so a reaped run and the connection it belongs to cannot
# disagree. The connection is stamped only when nothing has reported on
# it since the dead run started -- a later result is the truer status.
REAP = """
WITH reaped AS (
  UPDATE ingest_runs
     SET status = 'failed', rows_written = 0, error = %(err)s,
         finished_at = now(), updated_at = now(), updated_by = %(actor)s,
         revision = revision + 1
   WHERE status = 'running'
     AND started_at < now() - make_interval(mins => %(mins)s)
  RETURNING connection_id, started_at
), latest AS (
  SELECT connection_id, max(started_at) AS started_at
    FROM reaped
   WHERE connection_id IS NOT NULL
   GROUP BY connection_id
), stamped AS (
  UPDATE cloud_connections c
     SET last_ingest_at = latest.started_at, last_ingest_status = 'failed'
    FROM latest
   WHERE c.id = latest.connection_id
     AND c.deleted_at IS NULL
     AND (c.last_ingest_at IS NULL OR c.last_ingest_at < latest.started_at)
  RETURNING c.id
)
SELECT (SELECT count(*) FROM reaped) AS n
"""


def reap_stale_runs() -> int:
    """Mark `running` rows that can no longer be running as `failed`.

    Returns how many it closed. Idempotent, and a no-op in the normal
    case: one indexed-by-nothing scan of a table that gains two rows a
    day.
    """
    with connect() as db, db.cursor() as cur:
        cur.execute(
            REAP,
            {
                "mins": STALE_RUN_MINUTES,
                "err": STALE_RUN_ERROR,
                "actor": settings().system_actor,
            },
        )
        row = cur.fetchone()
    n = int(row["n"]) if row else 0
    if n:
        log.warning("closed %d ingest run(s) left in 'running' by a dead process", n)
    return n
