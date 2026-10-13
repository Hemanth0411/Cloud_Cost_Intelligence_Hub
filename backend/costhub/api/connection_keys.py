"""The request side of storing a connection's own access key.

Split from `routes/connections.py` on the 300-line limit (NFR-18). The
boundary is the one that was already there: that module is routing and
this is the single rule set for what happens when a request carries a
credential, which is the only part of the connections API where the body
contains something that must not come back out.

It lives in `api/` rather than in `connections/` because it raises
`HTTPException` -- these are request-shaped refusals ("both halves or
neither", "that mode would never read it"), not domain errors.
`connections/key_store.py` is the half that talks to Secrets Manager and
knows nothing about HTTP.

THE ORDER OF THE TWO WRITES, which is the only genuinely delicate thing
here. A credential write and a database write cannot be one transaction,
so one of them goes first and the other can fail after it:

  * secret first, row second -- a failed row write leaves a credential
    nothing points at, and `undo()` deletes it.
  * row first, secret second -- a failed secret write leaves a row whose
    `secret_arn` names nothing, and the connection is broken until
    somebody stores the key again.

The first is chosen because its failure is recoverable without anyone
knowing it happened, and because the failure that matters more -- a live
credential with no record of it -- is the one `undo()` closes. Deleting
is the reverse, and `discard()` says why.
"""
from __future__ import annotations

import logging

from fastapi import HTTPException, status
from pydantic import SecretStr

from costhub.audit import log as audit_log
from costhub.connections import key_store
from costhub.db import connect

log = logging.getLogger(__name__)


def store_from_request(
    *,
    provider: str,
    account_id: str,
    mode: str,
    access_key_id: str | None,
    secret_access_key: SecretStr | None,
) -> key_store.StoredKey | None:
    """Write a supplied key pair to Secrets Manager, or refuse it.

    Returns None when no key was supplied, which is the ordinary case for
    every other credential mode and for every edit that is not a
    rotation. Everything it raises is a 400 the caller can act on, except
    a Secrets Manager failure, which is a 502 because the request was
    fine and an upstream service refused it.
    """
    key_id = (access_key_id or "").strip()
    secret = (secret_access_key.get_secret_value() if secret_access_key else "").strip()

    if not key_id and not secret:
        return None

    # Half a pair is the single most likely mistake -- a form that
    # submits while one field is still empty -- and storing it would
    # produce a connection that fails at signing time with an error
    # about the account rather than about the key.
    if not key_id or not secret:
        missing = "access key id" if not key_id else "secret access key"
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"An access key needs both halves and the {missing} is empty. "
            "Nothing was stored.",
        )

    # Refused rather than quietly switched for the caller. Writing a
    # credential that nothing will ever read is worse than refusing it:
    # it is a live key, stored, with no sign on any screen that it is
    # there -- and the connection it was meant to fix still does not work.
    if mode != "secret":
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"A stored access key is only read when credential_mode is "
            f"'secret', and this connection would be {mode!r}. Nothing was "
            "stored. Set the mode in the same request if that is the intent.",
        )
    if provider != "aws":
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"An AWS access key cannot be stored for a {provider} connection. "
            f"A {provider} connection in 'secret' mode holds a service "
            "principal, which is written to Secrets Manager by hand and "
            "referenced here by ARN.",
        )

    problem = key_store.check_key_inputs(key_id, secret)
    if problem is not None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, problem)

    try:
        return key_store.put_access_key(
            provider=provider,
            account_id=account_id,
            access_key_id=key_id,
            secret_access_key=secret,
        )
    except key_store.SecretError as exc:
        # 502, not 500: nothing about the request was wrong and nothing
        # was stored. The message is the operator's -- it names which
        # grant is missing when that is the cause.
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"The access key could not be stored, so the connection was not "
            f"changed. {exc}",
        ) from exc


def audit_set(*, actor: str, connection_id: str, stored: key_store.StoredKey) -> None:
    """Record THAT a credential was written. Never what it was.

    Its own row rather than a field on the create/update entry, because
    the Secrets Manager write is a separate side effect in a separate
    system: it can succeed when the row write fails, and the trail has
    to be able to say so. `secret_set` is a boolean for the same reason
    `store.upsert` logs `external_id_set` as one.
    """
    with connect() as db, db.cursor() as cur:
        audit_log(
            cur,
            actor=actor,
            action="connection.credential_set",
            entity_type="cloud_connection",
            entity_id=connection_id,
            after={
                "secret_set": True,
                # Which of the two this was, since "rotated" is the one
                # that invalidates a key somebody may still be using.
                "rotated": not stored.created,
                # The ARN is not a credential: it is the pointer the row
                # already stores in a column any superadmin can read.
                "secret_arn": stored.arn,
            },
        )


def undo(stored: key_store.StoredKey | None) -> None:
    """Remove a secret this request created, after the row write failed.

    Only one this call CREATED. A rotation wrote a new version of a
    secret that was already in use, and deleting that would break a
    working connection to tidy up after an unrelated failure.

    Best effort, and it swallows its own failure deliberately: it runs on
    the way out of an exception that the caller is about to re-raise, and
    replacing that exception with this one would report the wrong fault.
    The orphan is logged instead, with the ARN, so it can be removed.
    """
    if stored is None or not stored.created:
        return
    try:
        key_store.delete_access_key(stored.arn)
    except key_store.SecretError:
        log.exception(
            "orphaned secret %s: created for a connection whose row write "
            "failed, and could not be deleted. Remove it by hand.",
            stored.arn,
        )


def discard(*, actor: str, connection_id: str, secret_arn: str | None) -> tuple[bool, str]:
    """Delete the stored key for a connection that no longer uses one.

    Returns (removed, sentence). Called AFTER the row has been updated,
    which is the opposite order to `store_from_request` and for the
    opposite reason: deleting the secret first and then failing to update
    the row would leave a connection pointing at a credential that no
    longer exists, i.e. would break it. Updating first and then failing
    here leaves a credential behind -- which is bad, so it is reported
    rather than swallowed, and the caller puts it in the response.

    An ARN outside our own prefix is NOT a failure. An Azure service
    principal, or anything an operator pointed this column at by hand,
    is managed somewhere else and is not ours to delete; `key_store.owned`
    draws that line and this says so in the response rather than
    pretending the credential is gone.
    """
    if secret_arn is None:
        return True, "This connection had no stored credential."

    if not key_store.owned(secret_arn):
        return (
            False,
            f"The secret {secret_arn} was left in place: it is not one this "
            "deployment created, so it is managed elsewhere. Remove it there "
            "if it is no longer needed.",
        )

    try:
        key_store.delete_access_key(secret_arn)
    except key_store.SecretError as exc:
        log.error("could not delete %s for connection %s: %s", secret_arn, connection_id, exc)
        _audit_discard(actor=actor, connection_id=connection_id, removed=False)
        return (
            False,
            f"THE STORED ACCESS KEY IS STILL LIVE and has to be deleted by "
            f"hand: {secret_arn}. {exc}",
        )

    _audit_discard(actor=actor, connection_id=connection_id, removed=True)
    return True, "The stored access key was deleted from Secrets Manager."


def _audit_discard(*, actor: str, connection_id: str, removed: bool) -> None:
    """Both outcomes are recorded, and a failure especially.

    A credential that outlived its connection is exactly the thing
    somebody will later need to find, and "we tried and could not" is
    the entry that lets them.
    """
    with connect() as db, db.cursor() as cur:
        audit_log(
            cur,
            actor=actor,
            action="connection.credential_deleted",
            entity_type="cloud_connection",
            entity_id=connection_id,
            after={"secret_deleted": removed},
        )
