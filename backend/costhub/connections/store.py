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
