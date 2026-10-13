"""Superadmin: import from one cloud account, now.

Split out of routes/connections.py on the 300-line limit (NFR-18), the
same way that file was split out of routes/admin.py. It is the one
connection route that does real work -- an ingest, then a detection
pass -- rather than reading or editing a row, and the one with a time
budget to defend.

Mounted by routes/connections.py, so the path and the `admin` tag are
unchanged and main.py does not need to know this file exists.
"""
from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status

from costhub.api.deps import SuperAdmin
from costhub.audit import log as audit_log
from costhub.connections import store
from costhub.db import connect

log = logging.getLogger(__name__)

router = APIRouter()


@router.post("/connections/{connection_id}/import", summary="Import from this account now")
def import_now(
    who: SuperAdmin,
    connection_id: str,
    days: Annotated[int, Query(ge=1, le=31)] = 7,
) -> dict:
    """Run the ingest for ONE connection, inline, and return the result.

    Imports previously happened only on the EventBridge schedule at
    06:00 UTC. So registering an account, or fixing a role, told you
    nothing until the next morning -- and "I just connected it, show me"
    is the obvious next click.

    INLINE RATHER THAN INVOKING THE INGEST LAMBDA, for two reasons. The
    ingest function has no notion of a single connection: it loops over
    `store.enabled()`, so triggering it would import every account to
    answer a question about one. And an asynchronous invoke returns
    nothing useful -- the caller would poll /admin/ingest-runs and the
    immediate verdict, which is the entire point, would be gone.

    No new permission is needed: every Lambda here shares one execution
    role, so this function already holds the `ce:*` and `sts:AssumeRole`
    it needs.

    THE TIMEOUT IS REAL: API Gateway cuts the request at 29s, the Lambda
    dies at 30. `days` <= 31 bounds this at THREE Cost Explorer calls
    plus pagination, not one -- one call per calendar month touched, and
    31 always touches two, sometimes three (arithmetic: `default_window`).
    At a measured ~3.4s a call that is about 10s for the FETCH; the
    detection pass further down adds its own few seconds on top, and it
    reads every account's series, so it grows with the estate. Roughly
    half the budget today -- fine, not guaranteed.
    On a timeout no cost rows are half-written, and the `running` row is
    later closed as failed by `reap_stale_runs` (ingest/stale.py).
    """
    from costhub.ingest import runner
    from costhub.ingest.cost_explorer import default_window
    from costhub.ingest.sources import source_for

    conn = store.get(connection_id)
    if conn is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such connection")

    # BEFORE spending any Cost Explorer calls. `store.get` filters on
    # deleted_at only, and `runner.ingest` skips `store.enabled()`
    # entirely when given an explicit connection list -- so without this
    # a disabled account was imported, billed for, and stamped
    # `last_ingest_status='success'` while the screen drew it greyed out
    # as disabled. The "disabled" branch further down was unreachable.
    if not conn.enabled:
        return {
            "ok": False,
            "rows": 0,
            "window": None,
            "detail": "This connection is disabled, so nothing was imported. Enable it first.",
        }

    start, end = default_window(days)
    results = runner.ingest(
        source_factory=source_for,
        start=start,
        end=end,
        triggered_by=who.email,
        connections=[conn],
    )

    # One connection in, one result out. The guard above is what handles
    # the disabled case; this used to be a second attempt at it that
    # could never run, because `ingest` only returns an empty list when
    # it had to consult `store.enabled()` itself.
    result = results[0]

    # DETECT ON WHAT WE JUST IMPORTED, scoped to this account.
    #
    # The schedule runs ingest at 06:00 and detection at 06:30, so a
    # newly connected account showed no anomalies until the following
    # morning even though its history had just arrived. Running it here
    # closes that gap.
    #
    # Scoped to the one account, and only when rows actually landed:
    # re-scanning untouched series would be work nobody asked for, and
    # this has to fit the same 29-second budget as the import. Measured
    # locally at ~3s to load 28 series; a warm Lambda reads RDS in-region
    # and pays neither interpreter start-up nor a cross-continent hop.
    #
    # A detection failure must NOT fail the import. The rows are already
    # committed and useful; the scheduled 06:30 run will pick the series
    # up regardless, so the honest answer is to report the import and say
    # detection did not run.
    findings: int | None = None
    if result.ok and result.rows:
        try:
            from costhub.anomaly import runner as anomaly_runner

            scan = anomaly_runner.scan(actor=who.email, account_id=conn.account_id)
            findings = scan.findings
        except Exception:
            log.exception("detection after import failed for %s", conn.account_id)

    with connect() as db, db.cursor() as cur:
        audit_log(
            cur,
            actor=who.email,
            action="connection.import",
            entity_type="cloud_connection",
            entity_id=connection_id,
            after={"ok": result.ok, "rows": result.rows, "days": days,
                   "findings": findings},
        )

    return {
        "ok": result.ok,
        "rows": result.rows,
        # null means detection did not run (import failed, no new rows,
        # or the scan itself errored) -- distinct from 0, which means it
        # ran and found nothing.
        "findings": findings,
        "window": [start.isoformat(), end.isoformat()],
        # On failure, point at Test connection. The ingest path cannot
        # tell the two AccessDenied cases apart -- a failed AssumeRole
        # surfaces through the same handler as a refused Cost Explorer
        # call, so its message names the billing toggle even when the
        # real problem is that the role does not exist. That sends
        # someone to ask root for a setting they do not need. The probe
        # distinguishes them; this says so rather than repeating a guess.
        "detail": (
            f"Imported {result.rows} row(s) for {start} to {end}."
            if result.ok
            else f"{result.error or 'The import failed.'} "
            "Use Test connection for which stage actually failed -- this "
            "message cannot tell a missing role from a missing permission."
        ),
    }
