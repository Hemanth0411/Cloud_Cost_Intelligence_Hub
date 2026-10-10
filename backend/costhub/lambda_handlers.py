"""Lambda entry points.

All five functions ship in **one** zip with different handlers -- the code
is small, and one artifact means one build and no chance of the API and
the jobs drifting apart.

    api      -> handler_api       (Function URL)
    ingest   -> handler_ingest    (EventBridge, daily)
    anomaly  -> handler_anomaly   (EventBridge, daily)
    alerts   -> handler_alerts    (EventBridge, daily)
    presignup-> handler_presignup (Cognito trigger)
"""
from __future__ import annotations

import logging
import os
from datetime import date, timedelta

logging.getLogger().setLevel(logging.INFO)
log = logging.getLogger(__name__)


# ------------------------------------------------------------------- api

def handler_api(event, context):
    """FastAPI behind a Lambda Function URL, via Mangum."""
    from mangum import Mangum

    from costhub.api.main import app

    return Mangum(app, lifespan="off")(event, context)


# ------------------------------------------------------------------ jobs

def handler_ingest(event, context):
    """Fetch recent cost for every enabled connection.

    Re-fetches a trailing window rather than just yesterday, because AWS
    restates cost as it finalises. The fact table's natural key makes
    that idempotent.
    """
    from costhub.config import settings
    from costhub.ingest import runner
    from costhub.ingest.cost_explorer import CostExplorerSource, default_window

    days = int((event or {}).get("days") or os.environ.get("INGEST_DAYS", "7"))
    start, end = default_window(days)

    results = runner.ingest(
        source_factory=lambda c: CostExplorerSource(c),
        start=start,
        end=end,
        triggered_by=settings().system_actor,
    )
    summary = runner.summarize(results)
    log.info("ingest %s..%s\n%s", start, end, summary)

    failed = [r for r in results if not r.ok]
    return {
        "window": [str(start), str(end)],
        "rows": sum(r.rows for r in results),
        "failed": [{"connection": r.connection, "error": r.error} for r in failed],
        # Surfaced, not raised: a silent ingest failure looks exactly like
        # "costs went to zero", so the schedule must report it.
        "ok": not failed,
    }


def handler_anomaly(event, context):
    from costhub.anomaly import runner

    lookback = int((event or {}).get("lookback_days") or 120)
    result = runner.scan(lookback_days=lookback)
    log.info("anomaly scan: %s", result)
    return {
        "series_scanned": result.series_scanned,
        "findings": result.findings,
        "created": result.created,
        "by_kind": result.by_kind,
    }


def handler_alerts(event, context):
    from costhub.alerts import runner

    result = runner.run()
    log.info("alerts: %s", result)
    return {
        "evaluated": result.evaluated,
        "fired": result.fired,
        "delivered": result.delivered,
        "suppressed_no_access": result.suppressed_no_access,
        "delivery_failures": result.delivery_failures,
    }


# ------------------------------------------------------- cognito trigger

def handler_presignup(event, context):
    """Reject sign-ups outside the allowed email domain.

    One of two places this is enforced -- the API re-checks the token's
    email claim -- because either alone is a single point of failure.
    """
    allowed = os.environ.get("ALLOWED_EMAIL_DOMAIN", "").strip().lower()
    email = (
        (event.get("request", {}).get("userAttributes", {}) or {})
        .get("email", "")
        .strip()
        .lower()
    )

    if allowed and not email.endswith(f"@{allowed}"):
        log.warning("rejected sign-up for %r", email)
        raise Exception(f"Only @{allowed} addresses may sign up.")

    # Invite-only: the superadmin creates users with AdminCreateUser, so
    # auto-confirming here keeps them out of FORCE_CHANGE_PASSWORD and
    # straight into passwordless sign-in.
    event["response"]["autoConfirmUser"] = True
    event["response"]["autoVerifyEmail"] = True
    return event
