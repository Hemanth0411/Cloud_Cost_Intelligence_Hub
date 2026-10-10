"""Superadmin operations: invite users, grant and revoke access.

Every mutation here writes an audit_log row in the same transaction as
the change itself. Grants are never hard-deleted -- revoking stamps
revoked_at so the history of who could see what, and when, survives.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from costhub.audit import log
from costhub.config import settings
from costhub.db import connect

ALLOWED_EMAIL_DOMAIN = "chryselys.com"


class NotPermitted(Exception):
    pass


class InvalidEmail(Exception):
    pass


@dataclass(frozen=True)
class GrantRequest:
    user_email: str
    provider: str
    account_id: str
    service_name: str | None = None  # None = all services
    valid_until: datetime | None = None  # None = indefinite
    reason: str | None = None


def normalize_email(email: str) -> str:
    """Lowercase and trim. Grants key off this, not the IdP subject."""
    cleaned = email.strip().lower()
    if "@" not in cleaned:
        raise InvalidEmail(email)
    domain = cleaned.rsplit("@", 1)[1]
    if domain != ALLOWED_EMAIL_DOMAIN:
        raise InvalidEmail(f"only @{ALLOWED_EMAIL_DOMAIN} addresses are allowed")
    return cleaned


def _require_superadmin(actor_role: str) -> None:
    if actor_role != "superadmin":
        raise NotPermitted("superadmin required")


def invite_user(
    *, actor: str, actor_role: str, email: str, display_name: str | None = None
) -> str:
    """Create a user in 'invited' state. Returns the user id.

    There is no self-registration: a superadmin invites, Cognito emails a
    one-time code, and the user signs in. That is why no password ever
    exists in this system -- and why migrating accounts later needs no
    credential export.
    """
    _require_superadmin(actor_role)
    normalized = normalize_email(email)

    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO users (email, display_name, created_by, updated_by)
            VALUES (%(email)s, %(name)s, %(actor)s, %(actor)s)
            ON CONFLICT (email) DO UPDATE
              SET updated_at = now(), updated_by = %(actor)s,
                  revision = users.revision + 1
            RETURNING id, status
            """,
            {"email": normalized, "name": display_name, "actor": actor},
        )
        row = cur.fetchone()
        assert row is not None
        log(
            cur,
            actor=actor,
            action="user.invite",
            entity_type="user",
            entity_id=row["id"],
            after={"email": normalized, "status": row["status"]},
        )
        return str(row["id"])


def grant(*, actor: str, actor_role: str, req: GrantRequest) -> str:
    """Give a user access to one account, optionally narrowed to one service."""
    _require_superadmin(actor_role)
    normalized = normalize_email(req.user_email)

    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id FROM users WHERE email = %(e)s AND deleted_at IS NULL",
            {"e": normalized},
        )
        user = cur.fetchone()
        if user is None:
            raise InvalidEmail(f"no such user: {normalized}")

        cur.execute(
            """
            INSERT INTO access_grants
              (user_id, provider, account_id, service_name,
               valid_until, reason, created_by, updated_by)
            VALUES
              (%(uid)s, %(provider)s, %(account)s, %(service)s,
               %(until)s, %(reason)s, %(actor)s, %(actor)s)
            RETURNING id
            """,
            {
                "uid": user["id"],
                "provider": req.provider,
                "account": req.account_id,
                "service": req.service_name,
                "until": req.valid_until,
                "reason": req.reason,
                "actor": actor,
            },
        )
        row = cur.fetchone()
        assert row is not None
        log(
            cur,
            actor=actor,
            action="grant.create",
            entity_type="access_grant",
            entity_id=row["id"],
            after={
                "user_email": normalized,
                "provider": req.provider,
                "account_id": req.account_id,
                "service_name": req.service_name,
                "valid_until": req.valid_until,
            },
        )
        return str(row["id"])


def revoke(*, actor: str, actor_role: str, grant_id: str, reason: str | None = None) -> None:
    """Revoke a grant. Takes effect on the next query -- nothing is cached."""
    _require_superadmin(actor_role)

    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE access_grants
               SET revoked_at = now(), revoked_by = %(actor)s,
                   reason = COALESCE(%(reason)s, reason),
                   updated_at = now(), updated_by = %(actor)s,
                   revision = revision + 1
             WHERE id = %(id)s AND revoked_at IS NULL
            RETURNING user_id, provider, account_id, service_name
            """,
            {"id": grant_id, "actor": actor, "reason": reason},
        )
        row = cur.fetchone()
        if row is None:
            return  # already revoked or absent; idempotent
        log(
            cur,
            actor=actor,
            action="grant.revoke",
            entity_type="access_grant",
            entity_id=grant_id,
            before=dict(row),
            after={"revoked_at": "now()"},
        )


def list_grants(*, user_email: str | None = None) -> list[dict]:
    """Current grants, newest first. Expired and revoked rows are included
    and flagged, because 'why could X see this in March' is a real question."""
    sql = """
    SELECT g.id, u.email, g.provider, g.account_id, g.service_name,
           g.valid_from, g.valid_until, g.revoked_at, g.reason,
           g.created_by, g.created_at,
           (g.revoked_at IS NULL
            AND now() >= g.valid_from
            AND (g.valid_until IS NULL OR now() < g.valid_until)) AS is_active
    FROM access_grants g
    JOIN users u ON u.id = g.user_id
    WHERE g.deleted_at IS NULL
      AND (%(email)s IS NULL OR u.email = %(email)s)
    ORDER BY g.created_at DESC
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute(sql, {"email": user_email})
        return cur.fetchall()


def system_actor() -> str:
    return settings().system_actor
