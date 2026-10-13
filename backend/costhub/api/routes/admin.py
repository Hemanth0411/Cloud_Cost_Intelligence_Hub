"""Superadmin: users, grants, connections, audit.

Every mutation here goes through rbac.admin or connections.store, which
write an audit_log row in the same transaction as the change.
"""
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, EmailStr, Field

from costhub.api.deps import SuperAdmin
from costhub.connections import store
from costhub.connections.probe import probe
from costhub.audit import log as audit_log
from costhub.db import connect, fetch_all
from costhub.rbac import admin as rbac
from costhub.rbac import pool

router = APIRouter(prefix="/admin", tags=["admin"])


class InviteIn(BaseModel):
    email: EmailStr
    display_name: str | None = None


class GrantIn(BaseModel):
    email: EmailStr
    provider: str = "aws"
    account_id: str
    service_name: str | None = Field(
        None, description="Omit for all services in the account."
    )
    valid_until: datetime | None = Field(
        None, description="Omit for an indefinite grant."
    )
    reason: str | None = None


class ConnectionIn(BaseModel):
    provider: str = "aws"
    account_id: str = Field(description="'self' for the deploy account.")
    display_name: str
    credential_mode: Literal["self", "assume_role", "profile", "secret"] = "assume_role"
    role_arn: str | None = None
    external_id: str | None = None
    profile_name: str | None = None
    secret_arn: str | None = Field(
        None, description="A Secrets Manager ARN. Never a credential value."
    )


# ----------------------------------------------------------------- users

@router.get("/users", summary="All users")
def list_users(_: SuperAdmin) -> dict:
    rows = fetch_all(
        """
        SELECT id, email, display_name, role, status, last_login_at, created_at
        FROM users WHERE deleted_at IS NULL ORDER BY email
        """
    )
    return {"data": rows, "row_count": len(rows)}


@router.post("/users", status_code=201, summary="Invite a user")
def invite(who: SuperAdmin, body: InviteIn) -> dict:
    try:
        uid = rbac.invite_user(
            actor=who.email, actor_role=who.role,
            email=str(body.email), display_name=body.display_name,
        )
    except rbac.InvalidEmail as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    except pool.PoolError as exc:
        # The database row was rolled back with it, so nothing was
        # half-created and the same request can simply be retried. Say
        # that, because the alternative reading -- "the user exists but
        # is broken" -- would send someone looking in the wrong place.
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"{exc} -- nothing was created; the invite can be retried",
        )
    return {"id": uid, "email": str(body.email).lower()}


# ---------------------------------------------------------------- grants

@router.get("/grants", summary="Grants, including expired and revoked")
def list_grants(
    _: SuperAdmin,
    email: Annotated[str | None, Query(description="Filter to one user")] = None,
) -> dict:
    rows = rbac.list_grants(user_email=email.lower() if email else None)
    return {"data": rows, "row_count": len(rows)}


@router.post("/grants", status_code=201, summary="Grant access")
def create_grant(who: SuperAdmin, body: GrantIn) -> dict:
    try:
        gid = rbac.grant(
            actor=who.email, actor_role=who.role,
            req=rbac.GrantRequest(
                user_email=str(body.email),
                provider=body.provider,
                account_id=body.account_id,
                service_name=body.service_name,
                valid_until=body.valid_until,
                reason=body.reason,
            ),
        )
    except rbac.InvalidEmail as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    return {"id": gid}


@router.delete("/grants/{grant_id}", summary="Revoke a grant")
def revoke_grant(
    who: SuperAdmin, grant_id: str, reason: str | None = None
) -> dict:
    """Idempotent, and never deletes the row -- revoked_at is stamped so
    the history of who could see what survives."""
    rbac.revoke(
        actor=who.email, actor_role=who.role, grant_id=grant_id, reason=reason
    )
    return {"id": grant_id, "revoked": True}


# ----------------------------------------------------------- connections

# The ExternalId is RETURNED, not redacted, and that is a reversal.
#
# It used to come back as the literal string "set". The reasoning was
# that it is one half of the cross-account trust and the role ARN is the
# other, so neither should leave the process. That was wrong in a way
# that broke the actual job.
#
# An ExternalId is not a password. Its purpose is the confused-deputy
# problem, and it works by being unguessable by THIRD parties -- it is
# shared, by design, between exactly the two people who need it: the
# owner of this deployment and the administrator of the target account.
# The whole workflow is "generate it, send it to them, they put it in
# their trust policy".
#
# So redacting it from a superadmin removed the one value they have to
# distribute, with no way to read it back: a typo meant deleting the
# connection and starting again. And it was incoherent anyway, because
# `role_arn` -- the other half -- was returned in full to the same
# caller, on the same row.
#
# What actually protects it: this route is superadmin-only, and the
# value is a UUID.
@router.get("/connections", summary="Registered cloud accounts")
def list_connections(_: SuperAdmin) -> dict:
    rows = store.list_connections()
    return {"data": rows, "row_count": len(rows)}


@router.post("/connections", status_code=201, summary="Register a cloud account")
def create_connection(who: SuperAdmin, body: ConnectionIn) -> dict:
    cid = store.upsert(
        actor=who.email,
        provider=body.provider,
        account_id=body.account_id,
        display_name=body.display_name,
        credential_mode=body.credential_mode,
        role_arn=body.role_arn,
        external_id=body.external_id,
        profile_name=body.profile_name,
        secret_arn=body.secret_arn,
    )
    return {"id": cid}


@router.post("/connections/{connection_id}/enabled", summary="Enable or disable")
def set_connection_enabled(
    who: SuperAdmin, connection_id: str, value: bool = True
) -> dict:
    store.set_enabled(actor=who.email, connection_id=connection_id, value=value)
    return {"id": connection_id, "enabled": value}


@router.post("/connections/{connection_id}/test", summary="Test a connection now")
def test_connection(_: SuperAdmin, connection_id: str) -> dict:
    """Resolve credentials and make one cheap Cost Explorer call.

    ALWAYS 200 when the connection exists, even when the test fails. The
    HTTP status answers "did the test run", and the body answers "did the
    connection work" -- collapsing those into 4xx/5xx would make a
    working endpoint reporting a broken role indistinguishable from a
    broken endpoint, and the whole value here is telling the operator
    WHICH of the three prerequisites is missing.
    """
    conn = store.get(connection_id)
    if conn is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such connection")

    result = probe(conn)

    # Recorded because a test is a real attempt against someone else's
    # account, and "who tried to reach this and when" belongs in the
    # trail alongside the grants.
    with connect() as db, db.cursor() as cur:
        audit_log(
            cur,
            actor=_.email,
            action="connection.test",
            entity_type="cloud_connection",
            entity_id=connection_id,
            after={"ok": result.ok, "stage": result.stage},
        )

    return result.as_dict()


# ----------------------------------------------------------------- audit

@router.get("/audit", summary="Append-only change history")
def audit(
    _: SuperAdmin,
    entity_type: str | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> dict:
    rows = fetch_all(
        """
        SELECT id, actor, action, entity_type, entity_id, before, after, at
        FROM audit_log
        -- The ::text cast is load-bearing. A bare parameter in
        -- `$1 IS NULL` gives Postgres nothing to infer a type from:
        --   psycopg.errors.AmbiguousParameter: could not determine
        --   data type of parameter $1
        -- It only fails when the filter is OMITTED, which is what the
        -- UI does on every page load, and what no test did.
        WHERE (%(et)s::text IS NULL OR entity_type = %(et)s)
        ORDER BY at DESC LIMIT %(lim)s
        """,
        {"et": entity_type, "lim": limit},
    )
    return {"data": rows, "row_count": len(rows)}


@router.get("/ingest-runs", summary="Ingest history and failures")
def ingest_runs(_: SuperAdmin, limit: Annotated[int, Query(ge=1, le=200)] = 50) -> dict:
    rows = fetch_all(
        """
        SELECT id, source, provider, account_id, period_start, period_end,
               status, rows_written, error, started_at, finished_at
        FROM ingest_runs ORDER BY started_at DESC LIMIT %(lim)s
        """,
        {"lim": limit},
    )
    return {"data": rows, "row_count": len(rows)}
