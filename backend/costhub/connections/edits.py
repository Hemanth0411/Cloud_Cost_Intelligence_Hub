"""Correcting and removing a registered connection.

Split from `store.py`, which registers and reads them. The boundary is
real: everything here changes a row that already exists, and every
function takes a `connection_id` rather than a natural key.

Neither operation existed until a mistyped role ARN proved unfixable --
the only recovery was deleting the connection and registering it again,
and while the ExternalId was redacted you could not even see that it was
wrong.
"""
from __future__ import annotations

from costhub.audit import log
from costhub.connections.store import SELECT
from costhub.db import connect


# Columns a superadmin may change after registration. An allowlist, not
# a filter: the SET clause is built from these NAMES, so anything a
# caller sends that is not here cannot reach the SQL at all.
#
# `provider` and `account_id` are absent on purpose. They are the natural
# key, the UNIQUE constraint is on them, and the imported cost rows are
# keyed by account_id -- changing either would orphan every row already
# imported rather than "editing" anything. Re-register instead.
EDITABLE = (
    "display_name",
    "credential_mode",
    "role_arn",
    "external_id",
    "profile_name",
    "secret_arn",
)


def update(*, actor: str, connection_id: str, changes: dict) -> dict | None:
    """Change only the fields supplied. Returns the row before the change.

    There was no way to correct a connection at all: a mistyped role ARN
    or a stale ExternalId meant deleting it and starting again, and
    before the ExternalId was readable you could not even tell that it
    was wrong.

    Only keys in EDITABLE are honoured and anything else is ignored
    silently rather than raising -- a caller sending an extra field is
    not an error worth failing an edit over, and the allowlist is what
    makes the dynamic SET safe.

    Returns None when no live row matches, so a route can answer 404.
    """
    fields = {k: v for k, v in changes.items() if k in EDITABLE}
    if not fields:
        return None

    assignments = ", ".join(f"{k} = %({k})s" for k in fields)

    with connect() as conn, conn.cursor() as cur:
        # FOR UPDATE, and read `before` in the same transaction: the
        # audit row needs the old values and RETURNING only sees the new
        # ones.
        cur.execute(
            SELECT + " AND id = %(id)s FOR UPDATE",
            {"id": connection_id},
        )
        before = cur.fetchone()
        if before is None:
            return None

        cur.execute(
            f"""
            UPDATE cloud_connections
               SET {assignments}, updated_at = now(),
                   updated_by = %(actor)s, revision = revision + 1
             WHERE id = %(id)s
            """,
            {**fields, "id": connection_id, "actor": actor},
        )

        # The ExternalId's VALUE is deliberately not written to the audit
        # log. It is readable from the connections API by the same
        # superadmin, so the log gains nothing by carrying copies of
        # every value it has ever held.
        def safe(d: dict) -> dict:
            out = {k: d.get(k) for k in fields}
            if "external_id" in out:
                out["external_id"] = "changed" if out["external_id"] else None
            return out

        log(
            cur,
            actor=actor,
            action="connection.update",
            entity_type="cloud_connection",
            entity_id=connection_id,
            before=safe(before),
            after=safe(fields),
        )
        return dict(before)


def soft_delete(*, actor: str, connection_id: str) -> bool:
    """Stop importing from a connection, keeping the history.

    Soft, like everything else here: `deleted_at` is stamped and the row
    stays. The audit trail has to keep making sense, and a hard delete
    would leave `audit_log` entries pointing at an entity that no longer
    exists.

    COST DATA ALREADY IMPORTED IS NOT REMOVED, and that is the right
    behaviour rather than an omission. `fact_cost_daily` is keyed by
    provider and account_id, not by connection, so those rows remain
    readable -- deleting a connection means "stop importing", not
    "forget what we spent". Re-registering the same account picks the
    history back up.

    Returns False when nothing live matched, so a route can answer 404
    instead of pretending to have deleted something.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            SELECT + " AND id = %(id)s FOR UPDATE",
            {"id": connection_id},
        )
        before = cur.fetchone()
        if before is None:
            return False

        cur.execute(
            """
            UPDATE cloud_connections
               SET deleted_at = now(), deleted_by = %(actor)s,
                   enabled = false, updated_at = now(),
                   updated_by = %(actor)s, revision = revision + 1
             WHERE id = %(id)s
            """,
            {"id": connection_id, "actor": actor},
        )
        log(
            cur,
            actor=actor,
            action="connection.delete",
            entity_type="cloud_connection",
            entity_id=connection_id,
            before={
                "provider": before["provider"],
                "account_id": before["account_id"],
                "display_name": before["display_name"],
            },
            after={"deleted": True, "cost_rows_kept": True},
        )
        return True
