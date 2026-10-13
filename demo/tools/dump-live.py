"""Snapshot the DEPLOYED database for the video's proof scene.

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
        FROM fact_cost_daily WHERE deleted_at IS NULL
        """,
    )[0]
    services = rows(
        cur,
        """
        SELECT service_name, round(sum(effective_cost), 6) AS cost, count(*) AS days
        FROM fact_cost_daily WHERE deleted_at IS NULL
        GROUP BY service_name ORDER BY sum(effective_cost) DESC, service_name
        """,
    )
    ingest = rows(
        cur,
        """
        SELECT account_id, status, rows_written, error, started_at
        FROM ingest_runs ORDER BY started_at DESC LIMIT 6
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
    "connectionTests": tests,
    "auditMix": audit_mix,
}

OUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
print(f"wrote {OUT}")
print(
    f"rows={totals['row_count']} total=${totals['total_cost']} "
    f"services={totals['services']} span={totals['first_day']}..{totals['last_day']}"
)
