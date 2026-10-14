"""CRUD over cloud_connections.

Backs the UI "Connect account" form. Mutations write an audit_log row in
the same transaction, because adding or disabling a data source changes
what the system can see.
"""
from __future__ import annotations

from costhub.audit import log
from costhub.connections import account_dim
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

    Three outcomes, audited under three names: `connection.create` for
    a new row, `connection.update` for a live one, `connection.revive`
    for a soft-deleted one coming back.
    """
    with connect() as conn, conn.cursor() as cur:
        # What is in the slot NOW, read in this transaction. RETURNING
        # cannot say: it sees the row as the upsert left it, with
        # deleted_at already cleared -- which is how a revived row came
        # to be logged as an ordinary `connection.update`, leaving
        # nothing in the trail to say a deleted connection had returned.
        cur.execute(
            """
            SELECT deleted_at, deleted_by, last_ingest_at, last_ingest_status
              FROM cloud_connections
             WHERE provider = %(p)s AND account_id = %(a)s
             FOR UPDATE
            """,
            {"p": provider, "a": account_id},
        )
        prior = cur.fetchone()
        revived = prior is not None and prior["deleted_at"] is not None

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
               -- A revived row also forgets its last import. To the
               -- person registering it this is a new connection; keeping
               -- the columns showed "Last import: failed" from months ago
               -- on something that had never been run. Only when
               -- reviving: an ordinary update keeps its real history.
               -- (cloud_connections.* is the row BEFORE this update.)
               last_ingest_at     = CASE WHEN cloud_connections.deleted_at IS NULL
                                         THEN cloud_connections.last_ingest_at END,
               last_ingest_status = CASE WHEN cloud_connections.deleted_at IS NULL
                                         THEN cloud_connections.last_ingest_status END,
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
        # A live connection means a visible account. Deleting one hides
        # its account (edits.soft_delete); this is the other half. The
        # ingest also re-activates, but only once an import succeeds, and
        # a revived connection whose role is still wrong would otherwise
        # keep its real history out of every dropdown. Every outcome, not
        # just a revive: it is a no-op, unaudited, for an active account.
        account_dim.reactivate(
            cur, actor=actor, provider=provider, account_id=account_id,
            connection_id=row["id"],
        )
        if revived:
            # Close anything this row's previous life left `running`, in
            # the same transaction. Otherwise the reaper finds it later,
            # sees a connection with no last import, and stamps the
            # revived row `failed` -- the inherited lie again, arriving
            # fifteen minutes late.
            cur.execute(
                """
                UPDATE ingest_runs
                   SET status = 'failed', rows_written = 0, finished_at = now(),
                       error = 'Did not finish before this connection was removed.',
                       updated_at = now(), updated_by = %(actor)s,
                       revision = revision + 1
                 WHERE connection_id = %(id)s AND status = 'running'
                """,
                {"id": row["id"], "actor": actor},
            )
            action = "connection.revive"
        else:
            # `revision` rather than `prior is None`: two first-time
            # registrations racing both see no prior row, and only one
            # of them inserts.
            action = "connection.create" if row["revision"] == 1 else "connection.update"
        log(
            cur,
            actor=actor,
            action=action,
            entity_type="cloud_connection",
            entity_id=row["id"],
            # What the revive discarded, so the trail still holds it.
            before=(
                {
                    "deleted_at": prior["deleted_at"],
                    "deleted_by": prior["deleted_by"],
                    "last_ingest_at": prior["last_ingest_at"],
                    "last_ingest_status": prior["last_ingest_status"],
                }
                if revived and prior is not None
                else None
            ),
            after={
                "provider": provider,
                "account_id": account_id,
                "display_name": display_name,
                "credential_mode": credential_mode,
                "role_arn": role_arn,
                # external_id is a shared secret with the other account;
                # record that one is set, not its value
                "external_id_set": external_id is not None,
                # Same treatment, for the same reason. `secret_arn` is
                # only a pointer and could be logged in full -- but what
                # the trail is being asked is "did this connection gain
                # a stored credential", and a boolean answers it without
                # anyone having to reason about what an ARN discloses.
                "secret_arn_set": secret_arn is not None,
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


# `update`, `set_enabled`, `soft_delete` and the EDITABLE allowlist live
# in connections/edits.py. Registering and reading a connection is this
# module; correcting or removing one is that one. Split when this file
# crossed the 300-line limit (NFR-18), along the boundary that was
# already there rather than at a convenient line number.

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
