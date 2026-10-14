"""Cognito user-pool writes, kept behind one function.

Why this module exists: `invite_user` wrote a `users` row and nothing
else. The docstring said "a superadmin invites, Cognito emails a
one-time code", and no code path anywhere called `AdminCreateUser` --
so an invited teammate got a database row, Cognito had never heard of
them, and no code could ever be sent. The only pool user was the
superadmin, created declaratively by `aws_cognito_user` in Terraform.

The IAM policy had `cognito-idp:AdminCreateUser` the whole time, under a
statement named "ManageInvitedUsers". The infrastructure was built for
this; the code half was missing.

Separated from `rbac/admin.py` so the invite path stays a database
transaction plus one adapter call, and so tests can replace this without
a pool.
"""
from __future__ import annotations

import logging

from costhub.config import settings

log = logging.getLogger(__name__)


class PoolError(RuntimeError):
    """The pool rejected the write, for a reason worth showing an operator."""


def pool_configured() -> bool:
    """Is there a pool to write to?

    False locally and in tests, where there is no Cognito at all. The
    invite then writes only the database row -- which is the old
    behaviour, but now it is a deliberate local-development path rather
    than the production one.
    """
    return bool(settings().cognito_user_pool_id)


def create_user(email: str) -> str:
    """Create a pool user who can receive an email OTP. Idempotent.

    Returns one of "created", "exists" or "skipped".

    `email_verified` is set to true because the invite is the
    verification: a superadmin asserted this address, and the OTP is
    delivered to it. It also has to be set, because `api/deps.py`
    requires `email_verified` to be exactly true before it will look a
    user up -- without it an invited user could sign in to Cognito and
    still be refused by the API.

    No password and no TemporaryPassword. The pool offers EMAIL_OTP
    only, so AdminCreateUser without one puts the user straight into
    CONFIRMED rather than FORCE_CHANGE_PASSWORD -- a state an OTP-only
    client has no screen to clear.

    MessageAction=SUPPRESS because Cognito's invitation email exists to
    deliver a temporary password, and there is none. The user gets a
    code when they sign in; an invitation naming a password they do not
    have would only confuse them.
    """
    if not pool_configured():
        log.info("no Cognito pool configured; %s gets a database row only", email)
        return "skipped"

    import boto3
    from botocore.exceptions import ClientError

    s = settings()
    client = boto3.client("cognito-idp", region_name=s.aws_region)

    try:
        client.admin_create_user(
            UserPoolId=s.cognito_user_pool_id,
            Username=email,
            UserAttributes=[
                {"Name": "email", "Value": email},
                {"Name": "email_verified", "Value": "true"},
            ],
            MessageAction="SUPPRESS",
        )
        return "created"
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code == "UsernameExistsException":
            # Re-inviting someone is not an error. The database upsert is
            # idempotent too, so the whole invite can be retried safely --
            # which matters, because a partial failure is recovered by
            # running it again.
            #
            # AND IT RE-ENABLES THEM, which is not decoration.
            # `disable_user` below is how a removed user stops being able
            # to sign in, and AdminCreateUser does not clear that: without
            # this line, removing someone and then inviting them again
            # gave them a revived `users` row and a pool user still
            # disabled -- an invite that cannot work, which is the exact
            # failure this module was written to end. `invite_user`
            # un-deletes the row; this un-disables the login.
            return "re-enabled" if _enable(client, s, email) else "exists"
        if code == "UserLambdaValidationException":
            # The pre-sign-up trigger rejected it, and the only rule it
            # enforces is the email domain. Say that, rather than
            # surfacing a Cognito stack trace.
            raise PoolError(
                f"Cognito rejected {email}: the pre-sign-up trigger allows only "
                f"@{s.allowed_email_domain} addresses"
            ) from exc
        raise PoolError(f"could not create the pool user for {email}: {exc}") from exc


def _enable(client, s, email: str) -> bool:
    """Clear a disabled pool user, for the re-invite path. Best effort.

    Returns whether it changed anything. A failure here is NOT raised:
    the caller is inside `invite_user`'s transaction, and refusing an
    otherwise-good invite because the re-enable call failed would leave
    the operator with no way forward at all. The invite reports "exists"
    instead, which is true, and a retry tries again.
    """
    from botocore.exceptions import ClientError

    try:
        client.admin_enable_user(UserPoolId=s.cognito_user_pool_id, Username=email)
        return True
    except ClientError as exc:
        log.warning("could not re-enable the pool user for %s: %s", email, exc)
        return False


def disable_user(email: str) -> str:
    """Stop a removed user signing in. Idempotent.

    Returns one of "disabled", "absent" or "skipped".

    DISABLE, NOT DELETE, and the choice is deliberate:

    * It mirrors what the database does. `users` is soft-deleted so the
      `audit_log` rows naming that user still resolve to a row; a pool
      user hard-deleted would leave the other half of the same identity
      gone, and re-inviting the person would mint a NEW Cognito `sub`.
      `identities.subject` stores that sub, so a delete orphans those
      rows while a disable keeps the pairing intact.
    * It is reversible by the invite path, which is the only way a
      removed person comes back. `create_user` re-enables above.
    * It is sufficient. Cognito refuses both authentication and token
      refresh for a disabled user, so no new session can start and an
      existing one cannot be extended.

    The app does not depend on this call to deny access, and that is
    worth knowing before trusting it: `api/deps._load_user` requires
    `deleted_at IS NULL`, so a removed user is refused by every endpoint
    the moment the row is stamped -- even with a still-valid token, and
    even if this call fails. What this prevents is the narrower and
    stranger thing: someone removed from the product still receiving
    login codes and reaching a signed-in shell with nothing in it.
    """
    if not pool_configured():
        log.info("no Cognito pool configured; %s keeps no login to disable", email)
        return "skipped"

    import boto3
    from botocore.exceptions import ClientError

    s = settings()
    client = boto3.client("cognito-idp", region_name=s.aws_region)

    try:
        client.admin_disable_user(UserPoolId=s.cognito_user_pool_id, Username=email)
        return "disabled"
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code == "UserNotFoundException":
            # Nothing to disable. True for anyone invited before the pool
            # write existed, and for a local row that never had a login.
            return "absent"
        raise PoolError(f"could not disable the pool user for {email}: {exc}") from exc
