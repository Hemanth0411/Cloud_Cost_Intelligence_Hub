"""Superadmin: register, correct, test and import cloud accounts.

Split out of routes/admin.py on the 300-line limit. These were already
the most self-contained group there -- their own request models, their
own store module, and the only routes that talk to another AWS account.

The two verbs worth distinguishing: `test` says whether access works and
which prerequisite is missing; `import` says whether any data arrived.
Both answer 200 with a verdict in the body rather than a 4xx, because
"the request ran and the connection is broken" and "the request failed"
are different facts and the operator needs to tell them apart.
"""
from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, status
from psycopg.errors import IntegrityError
from pydantic import BaseModel, Field

from costhub.api.deps import SuperAdmin
from costhub.audit import log as audit_log
from costhub.connections import edits, store
from costhub.connections.probe import probe
from costhub.db import connect

router = APIRouter(prefix="/admin", tags=["admin"])


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


class ConnectionPatch(BaseModel):
    """Every field optional: absent means "leave it alone".

    Separate from ConnectionIn rather than reusing it with defaults,
    because the two mean different things. ConnectionIn describes a whole
    connection and its defaults are real values -- `credential_mode`
    defaults to "assume_role". Here a default of None is the ABSENCE of
    an instruction, and sending the model through `upsert` would blank
    every credential column the caller did not re-state.

    `provider` and `account_id` are not editable: they are the natural
    key, and the imported cost rows are keyed by account_id, so changing
    either orphans the history rather than editing anything.
    """

    # NOT nullable, because the columns are NOT NULL. `null` here used
    # to reach Postgres and come back as a bare 500 through the generic
    # handler, with no indication of which constraint failed. A 422 from
    # pydantic names the field.
    display_name: str | None = Field(None, min_length=1)
    credential_mode: Literal["self", "assume_role", "profile", "secret"] | None = None
    role_arn: str | None = None
    external_id: str | None = None
    profile_name: str | None = None
    secret_arn: str | None = None


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
    if not store.set_enabled(actor=who.email, connection_id=connection_id, value=value):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such connection")
    return {"id": connection_id, "enabled": value}


@router.post("/connections/{connection_id}/import", summary="Import from this account now")
def import_now(
    who: SuperAdmin,
    connection_id: str,
    days: Annotated[int, Query(ge=1, le=31)] = 7,
) -> dict:
    """Run the ingest for ONE connection, inline, and return the result.

    Imports previously happened only on the EventBridge schedule at
    06:00 UTC. So registering an account, or fixing a role, told you
    nothing until the next morning -- and "I just connected it, show me"
    is the obvious next click.

    INLINE RATHER THAN INVOKING THE INGEST LAMBDA, for two reasons. The
    ingest function has no notion of a single connection: it loops over
    `store.enabled()`, so triggering it would import every account to
    answer a question about one. And an asynchronous invoke returns
    nothing useful -- the caller would poll /admin/ingest-runs and the
    immediate verdict, which is the entire point, would be gone.

    No new permission is needed: every Lambda here shares one execution
    role, so this function already holds the `ce:*` and `sts:AssumeRole`
    it needs.

    THE TIMEOUT IS REAL and `days` is capped at 31 because of it. API
    Gateway cuts the request at 29 seconds. One connection over a window
    inside a single month is one Cost Explorer call and returns in a few
    seconds; a long backfill would not, which is what `cli backfill` is
    for. If it does time out the work is not lost or invisible: the
    `ingest_runs` row is written BEFORE fetching, so the run is visible
    on this screen as `running` rather than silently absent.
    """
    from costhub.ingest import runner
    from costhub.ingest.cost_explorer import default_window
    from costhub.ingest.sources import source_for

    conn = store.get(connection_id)
    if conn is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such connection")

    # BEFORE spending any Cost Explorer calls. `store.get` filters on
    # deleted_at only, and `runner.ingest` skips `store.enabled()`
    # entirely when given an explicit connection list -- so without this
    # a disabled account was imported, billed for, and stamped
    # `last_ingest_status='success'` while the screen drew it greyed out
    # as disabled. The "disabled" branch further down was unreachable.
    if not conn.enabled:
        return {
            "ok": False,
            "rows": 0,
            "window": None,
            "detail": "This connection is disabled, so nothing was imported. Enable it first.",
        }

    start, end = default_window(days)
    results = runner.ingest(
        source_factory=source_for,
        start=start,
        end=end,
        triggered_by=who.email,
        connections=[conn],
    )

    # One connection in, one result out. The guard above is what handles
    # the disabled case; this used to be a second attempt at it that
    # could never run, because `ingest` only returns an empty list when
    # it had to consult `store.enabled()` itself.
    result = results[0]
    with connect() as db, db.cursor() as cur:
        audit_log(
            cur,
            actor=who.email,
            action="connection.import",
            entity_type="cloud_connection",
            entity_id=connection_id,
            after={"ok": result.ok, "rows": result.rows, "days": days},
        )

    return {
        "ok": result.ok,
        "rows": result.rows,
        "window": [start.isoformat(), end.isoformat()],
        # On failure, point at Test connection. The ingest path cannot
        # tell the two AccessDenied cases apart -- a failed AssumeRole
        # surfaces through the same handler as a refused Cost Explorer
        # call, so its message names the billing toggle even when the
        # real problem is that the role does not exist. That sends
        # someone to ask root for a setting they do not need. The probe
        # distinguishes them; this says so rather than repeating a guess.
        "detail": (
            f"Imported {result.rows} row(s) for {start} to {end}."
            if result.ok
            else f"{result.error or 'The import failed.'} "
            "Use Test connection for which stage actually failed -- this "
            "message cannot tell a missing role from a missing permission."
        ),
    }


@router.patch("/connections/{connection_id}", summary="Correct a connection")
def update_connection(who: SuperAdmin, connection_id: str, body: ConnectionPatch) -> dict:
    """Change only the fields supplied.

    `exclude_unset` is the whole mechanism: it distinguishes "set this to
    null" from "do not touch this". Without it, every absent field would
    arrive as None and clear a column the caller never mentioned -- which
    is exactly how an edit screen silently destroys an ExternalId.
    """
    changes = body.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "nothing to change")

    # The schema has a CHECK that pydantic cannot express: an
    # assume_role row must keep a role_arn. Clearing it -- the obvious
    # first half of "retype the ARN" -- violated it and surfaced as an
    # unhandled 500. Say which rule was broken instead.
    try:
        before = edits.update(actor=who.email, connection_id=connection_id, changes=changes)
    except IntegrityError as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "That change is not allowed: an AssumeRole connection must keep a role ARN, "
            "and display name and credential mode cannot be empty. "
            f"({type(exc).__name__})",
        ) from exc
    if before is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such connection")

    return {"id": connection_id, "changed": sorted(changes)}


@router.delete("/connections/{connection_id}", summary="Stop importing from an account")
def delete_connection(who: SuperAdmin, connection_id: str) -> dict:
    """Soft delete. Cost data already imported is kept.

    Says so in the response, because "delete" reads as "remove the data"
    and it does not: `fact_cost_daily` is keyed by provider and
    account_id rather than by connection, so the history stays readable
    and re-registering the account picks it back up.
    """
    if not edits.soft_delete(actor=who.email, connection_id=connection_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such connection")
    return {"id": connection_id, "deleted": True, "cost_data_kept": True}


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
