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
            return "exists"
        if code == "UserLambdaValidationException":
            # The pre-sign-up trigger rejected it, and the only rule it
            # enforces is the email domain. Say that, rather than
            # surfacing a Cognito stack trace.
            raise PoolError(
                f"Cognito rejected {email}: the pre-sign-up trigger allows only "
                f"@{s.allowed_email_domain} addresses"
            ) from exc
        raise PoolError(f"could not create the pool user for {email}: {exc}") from exc
