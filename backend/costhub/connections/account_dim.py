"""Keep `dim_account.is_active` in step with the connections.

`scoped.visible_accounts` lists accounts `WHERE is_active`, and that list
is every account dropdown in the product. Deleting a connection used to
leave its `dim_account` row active, so the account stayed in every
filter with nothing behind it -- a ghost, found in production and fixed
by hand once.

DEACTIVATE, NEVER DELETE. `fact_cost_daily` rows keep their
(provider, account_id), the history stays readable, and a report that
joins cost to its account name must keep working for an account nobody
imports from any more. Hiding it from the pickers is the whole change.

Both functions take the caller's cursor, so the flag moves in the same
transaction as the connection row that justified it, and both write
their own audit row -- but only when they actually changed something, so
the trail is not padded with no-ops on every re-registration.

The ingest has a third, unaudited path: `runner.DIM_ACCOUNT` sets
`is_active = true` whenever it writes cost for an account. That covers
a revived connection whose import SUCCEEDS. `reactivate` below is for
the one that has not imported yet, or whose import fails -- its earlier
history is real and must not stay hidden until a role gets fixed.
"""
from __future__ import annotations

import psycopg

from costhub.audit import log

# `NOT EXISTS` is the rule "only when no other live connection uses this
# account". It cannot fire today: cloud_connections is UNIQUE on
# (provider, account_id), so the row being deleted was the only one.
# It is here so that relaxing that key -- two connections reading one
# account with different credentials -- does not quietly start hiding
# accounts that are still being imported.
DEACTIVATE = """
UPDATE dim_account d
   SET is_active = false, updated_at = now(), updated_by = %(actor)s,
       revision = d.revision + 1
 WHERE d.provider = %(p)s AND d.account_id = %(a)s AND d.is_active
   AND NOT EXISTS (
         SELECT 1 FROM cloud_connections c
          WHERE c.provider = d.provider AND c.account_id = d.account_id
            AND c.deleted_at IS NULL)
RETURNING d.account_name
"""

REACTIVATE = """
UPDATE dim_account
   SET is_active = true, updated_at = now(), updated_by = %(actor)s,
       revision = revision + 1
 WHERE provider = %(p)s AND account_id = %(a)s AND NOT is_active
RETURNING account_name
"""


def deactivate(
    cur: psycopg.Cursor, *, actor: str, provider: str, account_id: str, connection_id: str
) -> bool:
    """Hide an account whose last live connection is gone.

    Call AFTER the connection row is soft-deleted, in the same
    transaction, so `NOT EXISTS` sees it gone. Returns whether the
    account was hidden; False also covers "no dimension row yet" -- a
    connection that never imported has nothing to hide.
    """
    return _flip(cur, DEACTIVATE, "account.deactivate", False,
                 actor=actor, provider=provider, account_id=account_id,
                 connection_id=connection_id)


def reactivate(
    cur: psycopg.Cursor, *, actor: str, provider: str, account_id: str, connection_id: str
) -> bool:
    """Show an account again because a live connection reads it."""
    return _flip(cur, REACTIVATE, "account.reactivate", True,
                 actor=actor, provider=provider, account_id=account_id,
                 connection_id=connection_id)


def _flip(
    cur: psycopg.Cursor, sql: str, action: str, active: bool, *,
    actor: str, provider: str, account_id: str, connection_id: str,
) -> bool:
    cur.execute(sql, {"p": provider, "a": account_id, "actor": actor})
    row = cur.fetchone()
    if row is None:
        return False
    log(
        cur,
        actor=actor,
        action=action,
        entity_type="dim_account",
        # The table's key is (provider, account_id); the trail takes one
        # string, so join them the way a human would read it.
        entity_id=f"{provider}:{account_id}",
        before={"is_active": not active},
        after={
            "is_active": active,
            "account_name": row["account_name"],
            # Why it moved: the connection whose delete or registration
            # caused it, so the two audit rows can be read together.
            "connection_id": str(connection_id),
        },
    )
    return True
