"""CRUD over cloud_connections.

Backs the UI "Connect account" form. Mutations write an audit_log row in
the same transaction, because adding or disabling a data source changes
what the system can see.
"""
from __future__ import annotations

from costhub.audit import log
from costhub.connections.credentials import Connection
from costhub.db import connect, fetch_all

SELECT = """
SELECT id, provider, account_id, display_name, credential_mode,
       role_arn, external_id, profile_name, secret_arn,
       enabled, last_ingest_at, last_ingest_status
FROM cloud_connections
WHERE deleted_at IS NULL
"""


def list_connections(*, enabled_only: bool = False) -> list[dict]:
    sql = SELECT + (" AND enabled" if enabled_only else "") + " ORDER BY provider, account_id"
    return fetch_all(sql)


def get(connection_id: str) -> Connection | None:
    """One connection, as the credential resolver wants it.

    Returns None rather than raising so a route can answer 404 instead
    of 500 for an id that is simply gone -- which happens the moment two
    tabs are open and one of them deletes.
    """
    rows = fetch_all(SELECT + " AND id = %(id)s", {"id": connection_id})
    return Connection.from_row(rows[0]) if rows else None


def enabled() -> list[Connection]:
    """The connections ingest should run against."""
    return [Connection.from_row(r) for r in list_connections(enabled_only=True)]


def upsert(
    *,
    actor: str,
    provider: str,
    account_id: str,
    display_name: str,
    credential_mode: str = "assume_role",
    role_arn: str | None = None,
    external_id: str | None = None,
    profile_name: str | None = None,
    secret_arn: str | None = None,
) -> str:
    """Register or update a cloud account.

    Idempotent on (provider, account_id) so re-running the seed is safe.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO cloud_connections
              (provider, account_id, display_name, credential_mode,
               role_arn, external_id, profile_name, secret_arn,
               created_by, updated_by)
            VALUES
              (%(p)s, %(a)s, %(d)s, %(m)s,
               %(r)s, %(x)s, %(pr)s, %(s)s, %(actor)s, %(actor)s)
            ON CONFLICT (provider, account_id) DO UPDATE SET
               display_name    = EXCLUDED.display_name,
               credential_mode = EXCLUDED.credential_mode,
               role_arn        = EXCLUDED.role_arn,
               external_id     = EXCLUDED.external_id,
               profile_name    = EXCLUDED.profile_name,
               secret_arn      = EXCLUDED.secret_arn,
               -- REVIVE a soft-deleted row. The unique key is
               -- (provider, account_id) and a deleted row still occupies
               -- it, so without these two lines re-registering an account
               -- answered 201 while leaving deleted_at set: the UI showed
               -- success, the row stayed out of `enabled()`, and nothing
               -- ever imported. Enabled is reset too, since `soft_delete`
               -- turns it off.
               deleted_at      = NULL,
               deleted_by      = NULL,
               enabled         = true,
               updated_at      = now(),
               updated_by      = %(actor)s,
               revision        = cloud_connections.revision + 1
            RETURNING id, revision
            """,
            {
                "p": provider, "a": account_id, "d": display_name,
                "m": credential_mode, "r": role_arn, "x": external_id,
                "pr": profile_name, "s": secret_arn, "actor": actor,
            },
        )
        row = cur.fetchone()
        assert row is not None
        log(
            cur,
            actor=actor,
            action="connection.create" if row["revision"] == 1 else "connection.update",
            entity_type="cloud_connection",
            entity_id=row["id"],
            after={
                "provider": provider,
                "account_id": account_id,
                "display_name": display_name,
                "credential_mode": credential_mode,
                "role_arn": role_arn,
                # external_id is a shared secret with the other account;
                # record that one is set, not its value
                "external_id_set": external_id is not None,
            },
        )
        return str(row["id"])


def rename(
    *,
    actor: str,
    provider: str,
    account_id: str,
    display_name: str,
) -> str | None:
    """Change only the label a connection is shown under.

    Separate from `upsert` on purpose. `upsert` sets every credential
    column from its arguments, so calling it to change a name would
    blank `role_arn`, `external_id` and `profile_name` for any caller
    that did not re-supply them. `update` below is the general form of
    the same idea; this one stays because renaming is the common case
    and its audit entry reads better for being specific.

    Returns the connection id, or None when no live row matches.
    """
    with connect() as conn, conn.cursor() as cur:
        # Read the old name first, in the same transaction, so the audit
        # row can carry a real `before`. RETURNING cannot give it: it
        # sees the row as the UPDATE left it.
        cur.execute(
            """
            SELECT id, display_name FROM cloud_connections
             WHERE provider = %(p)s AND account_id = %(a)s
               AND deleted_at IS NULL
             FOR UPDATE
            """,
            {"p": provider, "a": account_id},
        )
        before = cur.fetchone()
        if before is None:
            return None

        cur.execute(
            """
            UPDATE cloud_connections
               SET display_name = %(d)s, updated_at = now(),
                   updated_by = %(actor)s, revision = revision + 1
             WHERE id = %(id)s
            """,
            {"id": before["id"], "d": display_name, "actor": actor},
        )
        log(
            cur,
            actor=actor,
            action="connection.rename",
            entity_type="cloud_connection",
            entity_id=before["id"],
            before={"display_name": before["display_name"]},
            after={"display_name": display_name},
        )
        return str(before["id"])


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


def set_enabled(*, actor: str, connection_id: str, value: bool) -> None:
    """Disable without losing history (FR-13)."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE cloud_connections
               SET enabled = %(v)s, updated_at = now(), updated_by = %(actor)s,
                   revision = revision + 1
             WHERE id = %(id)s AND deleted_at IS NULL
            RETURNING provider, account_id, enabled
            """,
            {"id": connection_id, "v": value, "actor": actor},
        )
        row = cur.fetchone()
        if row is None:
            return
        log(
            cur,
            actor=actor,
            action="connection.enable" if value else "connection.disable",
            entity_type="cloud_connection",
            entity_id=connection_id,
            after=dict(row),
        )


def record_ingest(*, connection_id: str, status: str) -> None:
    """Stamp the outcome of the last run, for the connections screen."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE cloud_connections
               SET last_ingest_at = now(), last_ingest_status = %(s)s
             WHERE id = %(id)s
            """,
            {"id": connection_id, "s": status},
        )
