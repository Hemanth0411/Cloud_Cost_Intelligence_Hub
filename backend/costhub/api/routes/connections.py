"""Superadmin: register, correct, test and import cloud accounts.

Split out of routes/admin.py on the 300-line limit. These were already
the most self-contained group there -- their own request models, their
own store module, and the only routes that talk to another AWS account.

Registering and reading them is here. Correcting and removing one is
routes/connection_edits.py, and importing from one is
routes/connection_import.py; both are mounted at the bottom of this
file, so the paths do not change.

The two verbs worth distinguishing: `test` says whether access works and
which prerequisite is missing; `import` says whether any data arrived.
Both answer 200 with a verdict in the body rather than a 4xx, because
"the request ran and the connection is broken" and "the request failed"
are different facts and the operator needs to tell them apart.
"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field, SecretStr

from costhub.api import connection_keys
from costhub.api.deps import SuperAdmin
from costhub.api.routes import connection_edits, connection_import
from costhub.audit import log as audit_log
from costhub.connections import store
from costhub.connections.probe import probe
from costhub.db import connect
from costhub.ingest.stale import reap_stale_runs

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

    # THE ONLY TWO FIELDS ON THIS API THAT CARRY A CREDENTIAL, and they
    # are inputs only. Neither is a column: the pair is written to
    # Secrets Manager and what the row stores is the resulting ARN. See
    # api/connection_keys.py, which is the one place they are read.
    #
    # `SecretStr` so that nothing which repr()s this model -- a log
    # line, a traceback, a pydantic error -- can print the value. It
    # masks itself.
    access_key_id: str | None = Field(
        None,
        description=(
            "With secret_access_key, and only when credential_mode is "
            "'secret'. Stored in Secrets Manager, never in the database."
        ),
    )
    secret_access_key: SecretStr | None = Field(
        None,
        description=(
            "Written to Secrets Manager. Never stored in the database, "
            "never written to the audit log, and never returned by any "
            "endpoint -- including this one."
        ),
    )


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
    reap_stale_runs()  # or a timed-out import keeps showing the prior success
    rows = store.list_connections()
    return {"data": rows, "row_count": len(rows)}


@router.post("/connections", status_code=201, summary="Register a cloud account")
def create_connection(who: SuperAdmin, body: ConnectionIn) -> dict:
    """Register an account, storing any supplied access key out of band.

    The key, if there is one, goes to Secrets Manager BEFORE the row, so
    the row never names a secret that does not exist. If the row write
    then fails, the secret this request created is deleted again -- see
    `connection_keys.undo`, and that module's header for why this order
    and not the other.
    """
    stored = connection_keys.store_from_request(
        provider=body.provider,
        account_id=body.account_id,
        mode=body.credential_mode,
        access_key_id=body.access_key_id,
        secret_access_key=body.secret_access_key,
    )
    # The ARN, and only ever the ARN. `store.upsert` is not handed the
    # key and has no parameter that could take one.
    secret_arn = stored.arn if stored is not None else body.secret_arn

    # A `secret` row with nothing to resolve cannot authenticate: the
    # ingest fails at credential resolution with "secret_arn missing",
    # which is a connection registered in a state that can never work.
    # The CHECK in 004 cannot express it -- the column is nullable
    # because an Azure row may be written before its secret exists -- so
    # it is refused here.
    if body.credential_mode == "secret" and not secret_arn:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "A connection in 'secret' mode needs either an access key to "
            "store or an existing secret_arn. Nothing was created.",
        )

    try:
        cid = store.upsert(
            actor=who.email,
            provider=body.provider,
            account_id=body.account_id,
            display_name=body.display_name,
            credential_mode=body.credential_mode,
            role_arn=body.role_arn,
            external_id=body.external_id,
            profile_name=body.profile_name,
            secret_arn=secret_arn,
        )
    except Exception:
        connection_keys.undo(stored)
        raise

    if stored is not None:
        connection_keys.audit_set(actor=who.email, connection_id=cid, stored=stored)
    return {"id": cid, "credential_stored": stored is not None}


@router.post("/connections/{connection_id}/enabled", summary="Enable or disable")
def set_connection_enabled(
    who: SuperAdmin, connection_id: str, value: bool = True
) -> dict:
    if not store.set_enabled(actor=who.email, connection_id=connection_id, value=value):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such connection")
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


# PATCH and DELETE live in routes/connection_edits.py, and
# `POST /connections/{id}/import` in routes/connection_import.py.
# Mounted last, once every route above exists, and under this router so
# they keep the /admin prefix.
router.include_router(connection_edits.router)
router.include_router(connection_import.router)
