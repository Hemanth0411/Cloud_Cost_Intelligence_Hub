"""Superadmin: correct or remove a registered connection.

Split out of routes/connections.py on the 300-line limit (NFR-18), along
the boundary `connections/store.py` and `connections/edits.py` already
use: registering and reading a connection is that module, correcting or
removing one is this. Both routes here take a `connection_id` rather
than a natural key, and both are the only routes that can destroy
something -- a column value, or a stored credential.

THE CREDENTIAL IS WHAT MAKES THIS FILE WORTH ITS OWN PLACE. Rotating a
key and removing one are the two operations that have to get the order
of a Secrets Manager call and a database write right, in opposite
directions, and `api/connection_keys.py` holds the reasoning for both.

Mounted by routes/connections.py, so the paths and the `admin` tag are
unchanged and main.py does not need to know this file exists.
"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, status
from psycopg.errors import IntegrityError
from pydantic import BaseModel, Field, SecretStr

from costhub.api import connection_keys
from costhub.api.deps import SuperAdmin
from costhub.connections import edits, key_store, store

router = APIRouter()


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

    # ROTATION. A key that cannot be replaced is a key nobody will
    # replace, so the edit path takes the same pair the create path
    # does. Sending it rewrites the secret in place and keeps the ARN.
    access_key_id: str | None = None
    secret_access_key: SecretStr | None = None


@router.patch("/connections/{connection_id}", summary="Correct a connection")
def update_connection(who: SuperAdmin, connection_id: str, body: ConnectionPatch) -> dict:
    """Change only the fields supplied.

    `exclude_unset` is the whole mechanism: it distinguishes "set this to
    null" from "do not touch this". Without it, every absent field would
    arrive as None and clear a column the caller never mentioned -- which
    is exactly how an edit screen silently destroys an ExternalId.

    ROTATING A KEY IS AN EDIT and arrives the same way, but the two
    credential fields are popped off before `changes` is used for
    anything, because they are not columns. What reaches the SQL is the
    resulting `secret_arn`, so the audit trail records a pointer moving
    and never a value.
    """
    changes = body.model_dump(exclude_unset=True)
    # Off the top. `edits.EDITABLE` would drop these anyway, but relying
    # on that would mean a credential travelling as far as the SET
    # builder on the strength of an allowlist in another module.
    access_key_id = changes.pop("access_key_id", None)
    secret_access_key = changes.pop("secret_access_key", None)
    rotating = access_key_id is not None or secret_access_key is not None

    if not changes and not rotating:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "nothing to change")

    # Read the row first: a credential change needs to know which account
    # the secret is filed under and which mode this edit lands in, and
    # the patch body does not necessarily state either. Every route on
    # this resource 404s for an id that no longer matches a live row, so
    # answering that here changes the order and nothing else.
    current = store.get(connection_id)
    if current is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such connection")
    mode = changes.get("credential_mode", current.credential_mode)

    stored = connection_keys.store_from_request(
        provider=current.provider,
        account_id=current.account_id,
        mode=mode,
        access_key_id=access_key_id,
        secret_access_key=secret_access_key,
    )
    if stored is not None:
        changes["secret_arn"] = stored.arn

    # A row LEAVING `secret` mode stops reading its key, and a key
    # nothing reads is a live credential with nothing on any screen to
    # say it is there. Clear the pointer in this same update and delete
    # the secret after it, exactly as removing the connection does.
    abandoning = (
        stored is None
        and mode != "secret"
        and current.credential_mode == "secret"
        and key_store.owned(current.secret_arn)
    )
    if abandoning:
        changes["secret_arn"] = None

    # ...and a row ARRIVING in `secret` mode with nothing to resolve is
    # the mirror image: it fails at credential resolution with
    # "secret_arn missing", which is an edit that leaves the connection
    # unable to authenticate. `POST` refuses the same shape for the same
    # reason; neither is expressible as a CHECK, because the column is
    # nullable for Azure rows written before their secret exists.
    if mode == "secret" and not changes.get("secret_arn", current.secret_arn):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "A connection in 'secret' mode needs either an access key to "
            "store or an existing secret_arn. Nothing was changed.",
        )

    # The schema has a CHECK that pydantic cannot express: an
    # assume_role row must keep a role_arn. Clearing it -- the obvious
    # first half of "retype the ARN" -- violated it and surfaced as an
    # unhandled 500. Say which rule was broken instead.
    try:
        before = edits.update(actor=who.email, connection_id=connection_id, changes=changes)
    except IntegrityError as exc:
        connection_keys.undo(stored)
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "That change is not allowed: an AssumeRole connection must keep a role ARN, "
            "and display name and credential mode cannot be empty. "
            f"({type(exc).__name__})",
        ) from exc
    except Exception:
        connection_keys.undo(stored)
        raise
    if before is None:
        connection_keys.undo(stored)
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such connection")

    result: dict = {"id": connection_id, "changed": sorted(changes)}
    if stored is not None:
        connection_keys.audit_set(
            actor=who.email, connection_id=connection_id, stored=stored
        )
        result["credential_stored"] = True
    if abandoning:
        removed, detail = connection_keys.discard(
            actor=who.email,
            connection_id=connection_id,
            secret_arn=current.secret_arn,
        )
        result["credential_removed"] = removed
        result["detail"] = detail
    return result


@router.delete("/connections/{connection_id}", summary="Stop importing from an account")
def delete_connection(who: SuperAdmin, connection_id: str) -> dict:
    """Soft delete. Cost data already imported is kept; the key is not.

    Says so in the response, because "delete" reads as "remove the data"
    and it does not: `fact_cost_daily` is keyed by provider and
    account_id rather than by connection, so the history stays readable
    and re-registering the account picks it back up.

    THE CREDENTIAL IS THE EXCEPTION TO THAT, and it has to be. The row
    is soft-deleted and the cost rows survive, but a stored access key
    has no reason to outlive the connection that read it -- leaving it
    would mean removing an account from the UI while a usable credential
    for it stays in Secrets Manager, with nothing on any screen saying
    so. The secret is deleted after the row, and the response reports
    which, because a failure here is exactly the fact that must not be
    swallowed.
    """
    # Read before the delete: `soft_delete` answers a bool and the ARN is
    # needed afterwards. A concurrent delete is still handled -- it is
    # `soft_delete` that decides the 404.
    current = store.get(connection_id)
    if not edits.soft_delete(actor=who.email, connection_id=connection_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such connection")

    removed, detail = connection_keys.discard(
        actor=who.email,
        connection_id=connection_id,
        secret_arn=current.secret_arn if current is not None else None,
    )
    return {
        "id": connection_id,
        "deleted": True,
        "cost_data_kept": True,
        "credential_removed": removed,
        "detail": detail,
    }
