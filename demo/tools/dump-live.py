"""Snapshot the DEPLOYED database for the video's proof scene.

SCOPED TO account_id = 'self', deliberately. A second, real AWS account
belonging to someone else was connected on 2026-10-13 and its ingest now
succeeds, which put ~$1.8k of THEIR spend -- service by service, Bedrock
models included -- into the same table. None of that belongs in a video.
The deployment's own account is also the only one whose bill we can
honestly narrate as "it bills itself".

The one exception is `lastFailure`: the historical failed ingest, kept
because the two-stage verdict is the scene's whole point. Its account id
and display name are masked at render time (see S06Proof.tsx).

Everything in scene 5 is read from here, so nothing on screen about the
real account is typed by hand. Read-only: four SELECTs.

    cd backend
    AWS_PROFILE=costhub \
    DATABASE_URL="$(terraform -chdir=../terraform output -raw database_url)" \
    python ../demo/tools/dump-live.py
"""
from __future__ import annotations

import json
import os
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

import psycopg

OUT = Path(__file__).resolve().parent.parent / "src" / "data" / "live.json"


def plain(v):
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    return v


def rows(cur, sql):
    cur.execute(sql)
    cols = [d.name for d in cur.description]
    return [{c: plain(v) for c, v in zip(cols, r)} for r in cur.fetchall()]


def public_failure(run: dict) -> dict:
    """The failed run with the other account's identity removed.

    The ingest error reads "<display name> (<12-digit id>): <message>".
    Both halves of that prefix identify someone else's AWS account, and
    this file is committed, so the prefix is dropped HERE rather than at
    render time. What is kept is the operator-facing message, which is
    the only part the video is about.
    """
    message = str(run.get("error") or "")
    # Two prefix shapes have been seen: "<name> (<id>): <message>" and
    # "<name>: <message>". Both are dropped; if neither matches, the
    # message is kept whole rather than guessed at.
    for sep in ("): ", ": "):
        head, found, tail = message.partition(sep)
        if found and len(head) < 60:
            message = tail
            break
    return {
        **run,
        "account_id": "a second AWS account",
        "error": message,
    }


with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
    totals = rows(
        cur,
        """
        SELECT count(*) AS row_count,
               coalesce(sum(effective_cost), 0) AS total_cost,
               min(usage_date) AS first_day,
               max(usage_date) AS last_day,
               count(DISTINCT service_name) AS services,
               count(DISTINCT account_id) AS accounts
        FROM fact_cost_daily WHERE deleted_at IS NULL AND account_id = 'self'
        """,
    )[0]
    services = rows(
        cur,
        """
        SELECT service_name, round(sum(effective_cost), 6) AS cost, count(*) AS days
        FROM fact_cost_daily WHERE deleted_at IS NULL AND account_id = 'self'
        GROUP BY service_name ORDER BY sum(effective_cost) DESC, service_name
        """,
    )
    ingest = rows(
        cur,
        """
        SELECT account_id, status, rows_written, error, started_at
        FROM ingest_runs WHERE account_id = 'self'
        ORDER BY started_at DESC LIMIT 4
        """,
    )
    # The most recent run that got as far as the COST CALL and was
    # refused. Not just the latest failure: "could not load profile
    # 'default'" is also a failed run, and it is a local credential
    # problem rather than the two-stage verdict scene 6 is about.
    failure = rows(
        cur,
        """
        SELECT account_id, status, rows_written, error, started_at
        FROM ingest_runs
        WHERE status = 'failed' AND error ILIKE '%Cost Explorer access denied%'
        ORDER BY started_at DESC LIMIT 1
        """,
    )
    tests = rows(
        cur,
        """
        SELECT at, actor, action, after
        FROM audit_log WHERE action = 'connection.test' ORDER BY at
        """,
    )
    audit_mix = rows(
        cur,
        "SELECT action, count(*) AS n FROM audit_log GROUP BY action ORDER BY n DESC",
    )

payload = {
    "capturedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
    "source": "deployed RDS (costhub-dev-db, AWS account 997916278551, us-east-1)",
    "totals": totals,
    "services": services,
    "ingestRuns": ingest,
    "lastFailure": public_failure(failure[0]) if failure else None,
    "connectionTests": tests,
    "auditMix": audit_mix,
}

OUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
print(f"wrote {OUT}")
print(
    f"rows={totals['row_count']} total=${totals['total_cost']} "
    f"services={totals['services']} span={totals['first_day']}..{totals['last_day']}"
)
