"""Run the SHIPPED grant predicate against the DEPLOYED database.

NOTE ON WHAT THIS DOES NOT MEASURE: the deployed fact table holds rows
for ONE account, so the cases below exercise the service-level narrowing
and the revoke, not the account-level exclusion. The predicate joins
`g.account_id = f.account_id` either way; that half is sound by
construction and unproven at runtime here. The video says so.

The video's central claim is that access narrowing happens in SQL, so
the video should not illustrate it -- it should measure it. This imports
`GRANT_PREDICATE` and `SUPERADMIN_BYPASS` from
`costhub/query/scoped.py`, the module the API reads through, and runs
them as four different principals against the live fact table.

The two test principals are created inside a transaction that is ALWAYS
rolled back, so the deployed database is unchanged when this exits: no
user row, no grant row, nothing to clean up. Verified by re-reading the
counts afterwards on a fresh connection.

    cd backend
    AWS_PROFILE=costhub \
    DATABASE_URL="$(terraform -chdir=../terraform output -raw database_url)" \
    python ../demo/tools/rbac-proof.py
"""
from __future__ import annotations

import json
import os
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

import psycopg

from costhub.query.scoped import GRANT_PREDICATE, SUPERADMIN_BYPASS

OUT = Path(__file__).resolve().parent.parent / "src" / "data" / "rbac.json"

COUNT = """
SELECT count(*) AS rows,
       count(DISTINCT f.account_id) AS accounts,
       count(DISTINCT f.service_name) AS services,
       coalesce(sum(f.effective_cost), 0) AS cost
FROM fact_cost_daily f
WHERE f.deleted_at IS NULL
  AND f.usage_date >= %(start)s
  AND f.usage_date <= %(end)s
  AND ({scope})
"""

WINDOW = {"start": date(2026, 1, 1), "end": date(2026, 12, 31)}


def run(cur, scope: str, user_id: str | None) -> dict:
    params = dict(WINDOW)
    if user_id is not None:
        params["user_id"] = user_id
    cur.execute(COUNT.format(scope=scope), params)
    rows, accounts, services, cost = cur.fetchone()
    return {"rows": rows, "accounts": accounts, "services": services, "cost": float(cost)}


conn = psycopg.connect(os.environ["DATABASE_URL"])
cur = conn.cursor()

# Baseline: who already exists, so the rollback can be proven.
cur.execute("SELECT count(*) FROM users"); users_before = cur.fetchone()[0]
cur.execute("SELECT count(*) FROM access_grants"); grants_before = cur.fetchone()[0]

cur.execute(
    """
    INSERT INTO users (email, display_name, role, status, created_by)
    VALUES ('rbac.proof@costhub.demo', 'Grant Holder', 'user', 'active', 'demo-video-proof')
    RETURNING id
    """
)
granted_id = str(cur.fetchone()[0])

cur.execute(
    """
    INSERT INTO users (email, display_name, role, status, created_by)
    VALUES ('no.grant@costhub.demo', 'No Grants', 'user', 'active', 'demo-video-proof')
    RETURNING id
    """
)
ungranted_id = str(cur.fetchone()[0])

# One account-wide grant for the first user, on the account that actually
# has rows. NULL service_name = every service in that account.
cur.execute(
    """
    INSERT INTO access_grants (user_id, provider, account_id, service_name, reason, created_by)
    VALUES (%s, 'aws', 'self', NULL, 'demo video proof', 'demo-video-proof')
    """,
    (granted_id,),
)

superadmin = run(cur, SUPERADMIN_BYPASS, None)
granted = run(cur, GRANT_PREDICATE, granted_id)
ungranted = run(cur, GRANT_PREDICATE, ungranted_id)

# Narrow the same grant to ONE service: a grant is not all-or-nothing.
cur.execute(
    "UPDATE access_grants SET service_name = 'Amazon Simple Storage Service' WHERE user_id = %s",
    (granted_id,),
)
narrowed = run(cur, GRANT_PREDICATE, granted_id)

# Revoke it: the predicate re-evaluates per query, so this takes effect now.
cur.execute("UPDATE access_grants SET revoked_at = now() WHERE user_id = %s", (granted_id,))
revoked = run(cur, GRANT_PREDICATE, granted_id)

conn.rollback()
conn.close()

# Prove nothing persisted.
with psycopg.connect(os.environ["DATABASE_URL"]) as check, check.cursor() as c2:
    c2.execute("SELECT count(*) FROM users"); users_after = c2.fetchone()[0]
    c2.execute("SELECT count(*) FROM access_grants"); grants_after = c2.fetchone()[0]

payload = {
    "capturedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
    "source": "costhub/query/scoped.py GRANT_PREDICATE, run against deployed RDS",
    "window": {k: v.isoformat() for k, v in WINDOW.items()},
    "predicate": GRANT_PREDICATE.strip(),
    "cases": [
        {"label": "superadmin (predicate bypassed)", "principal": "hemanth.reddy@chryselys.com", **superadmin},
        {"label": "user, granted the whole account", "principal": "rbac.proof@costhub.demo", **granted},
        {"label": "same user, grant narrowed to one service", "principal": "rbac.proof@costhub.demo", **narrowed},
        {"label": "same user, grant revoked", "principal": "rbac.proof@costhub.demo", **revoked},
        {"label": "user with no grant at all", "principal": "no.grant@costhub.demo", **ungranted},
    ],
    "rolledBack": {
        "usersBefore": users_before, "usersAfter": users_after,
        "grantsBefore": grants_before, "grantsAfter": grants_after,
        "clean": users_before == users_after and grants_before == grants_after,
    },
}

OUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
print(f"wrote {OUT}")
for c in payload["cases"]:
    print(f"  {c['label']:42s} rows={c['rows']:3d} accounts={c['accounts']} services={c['services']}")
print(f"  rollback clean: {payload['rolledBack']['clean']}")
