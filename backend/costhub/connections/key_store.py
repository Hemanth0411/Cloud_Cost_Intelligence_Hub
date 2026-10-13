"""Holding a connection's own AWS access key, outside the database.

THE SECOND WAY AN AWS ACCOUNT CAN BE READ, and the fallback rather than
the recommendation. `assume_role` is better and stays the default: it
yields credentials that expire in an hour and leaves nothing long-lived
anywhere. A static key is for the case that otherwise has no answer --
somebody who already holds their own key with Cost Explorer access, and
nobody in that account who will create a role for them.

WHERE THE KEY LIVES: Secrets Manager holds the pair as JSON under the
deterministic name `costhub/<env>/connections/<provider>-<account_id>`;
`cloud_connections.secret_arn` holds that secret's ARN and nothing else
(FR-12); `credentials.own_session` reads it at call time, per import.
The key is never written to Postgres, never put in an audit row, and
never returned by an endpoint.

THE NAME IS DETERMINISTIC AND DELETION IS FORCED, and those two go
together. Deterministic means an account's secret can be found from the
account id alone, with no second index -- but it also means
re-registering an account reuses a name, and Secrets Manager refuses to
create a name that is merely SCHEDULED for deletion. The default
recovery window is 30 days, so register / remove / register again inside
a month would fail on the create. `secrets.tf` already sets
`recovery_window_in_days = 0` on the database secret for that exact
reason; the same applies here, so `delete_access_key` forces deletion.

ONLY SECRETS UNDER OUR OWN PREFIX ARE EVER DELETED. `secret_arn` is an
editable column and an Azure service principal may have been created by
another team or by Terraform, so `owned()` gates every destructive call
on the name being one this module would have written. The database
secret is `costhub/<env>/database-url` -- no `connections/` segment --
and is excluded by that same check.

THE SECRETS ARE TAGGED, and that is not decoration. `./do.sh sweep`
proves a teardown was complete by listing everything tagged
Project/Environment; Terraform's `default_tags` cannot reach a secret
this API creates, and `destroy` will not remove it. An untagged
connection credential would survive a teardown invisibly.

Nothing here logs a value, but botocore at DEBUG level logs request
bodies -- for CreateSecret and PutSecretValue that includes the key, so
do not raise botocore's log level in a deployed environment.
"""
from __future__ import annotations

import json
import re
from typing import NamedTuple

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from costhub.config import settings

# Must match `var.name_prefix` in terraform/variables.tf, which is what
# the IAM grant in iam.tf is written against. A constant rather than a
# setting: the Lambda is not passed the prefix, and the grant and this
# name are one convention -- as `CostHubCostReader` is in probe.py.
NAME_PREFIX = "costhub"
# The path segment the IAM policy wildcards on. Everything written here
# is under it, and nothing outside it is ever deleted.
SEGMENT = "connections"

ACCESS_KEY_ID = "aws_access_key_id"
SECRET_ACCESS_KEY = "aws_secret_access_key"
FIELDS = (ACCESS_KEY_ID, SECRET_ACCESS_KEY)

# IAM's own constraint on an access key id (AccessKeyIdType): 16-128
# characters. Checked because the likely bad input is an empty field or
# a pasted ARN, and finding that out at 06:00 the next morning is the
# loop this screen exists to shorten. The secret has no published
# format, so its bounds are a sanity check only -- a real one is 40
# base64 characters -- and they claim nothing more than that.
ACCESS_KEY_ID_RE = re.compile(r"^[A-Z0-9]{16,128}$")
SECRET_MIN = 16
SECRET_MAX = 256


class SecretError(Exception):
    """A Secrets Manager call failed, worded for an operator.

    Deliberately NOT `CredentialError`: that lives in credentials.py,
    which imports this module, so raising it here would make the import
    circular. `credentials.own_session` catches this and re-raises as a
    CredentialError, which keeps the probe reporting stage "credentials"
    for a key it could not read.
    """


class StoredKey(NamedTuple):
    arn: str
    # True only when THIS call brought the secret into existence, which
    # is how the caller decides whether a later failure may delete it:
    # removing one we merely added a version to would destroy a
    # credential already in use.
    created: bool


def secret_name(provider: str, account_id: str) -> str:
    """The one name a given account's key is ever stored under."""
    return f"{NAME_PREFIX}/{settings().app_env}/{SEGMENT}/{provider}-{account_id}"


def owned_prefix() -> str:
    """The name prefix this deployment writes, and deletes under."""
    return f"{NAME_PREFIX}/{settings().app_env}/{SEGMENT}/"


def owned(secret_arn: str | None) -> bool:
    """Is this a secret this module would have written?

    The gate on every destructive call. A Secrets Manager ARN ends
    `:secret:<name>-<6 random characters>`, so the test is on the name
    after `:secret:` -- excluding the database secret, another
    environment's, and any ARN typed into `secret_arn` by hand.
    """
    if not secret_arn or ":secret:" not in secret_arn:
        return False
    name = secret_arn.split(":secret:", 1)[1]
    return name.startswith(owned_prefix())


def check_key_inputs(access_key_id: str, secret_access_key: str) -> str | None:
    """Why this pair cannot be stored, or None.

    Names the field and never echoes a value: the point of this feature
    is that the key does not come back out, and a validation message is
    a response body like any other.
    """
    if not ACCESS_KEY_ID_RE.match(access_key_id):
        return (
            "That access key id does not look like one: IAM uses 16 to 128 "
            "characters of A-Z and 0-9, and it normally begins with AKIA. "
            "Nothing was stored."
        )
    if not SECRET_MIN <= len(secret_access_key) <= SECRET_MAX:
        return (
            f"That secret access key is {len(secret_access_key)} characters. "
            f"Expected {SECRET_MIN} to {SECRET_MAX} -- a real one is 40. "
            "Nothing was stored."
        )
    if any(c.isspace() for c in secret_access_key):
        return (
            "That secret access key contains a space or a line break, which a "
            "real one never does -- check for a wrapped paste. Nothing was stored."
        )
    return None


def _client():
    return boto3.client("secretsmanager", region_name=settings().aws_region)


def _code(exc: ClientError) -> str:
    return exc.response.get("Error", {}).get("Code", "")


def _tags() -> list[dict[str, str]]:
    return [
        {"Key": "Project", "Value": NAME_PREFIX},
        {"Key": "Environment", "Value": settings().app_env},
        # Not "terraform": Terraform does not know this secret exists and
        # `destroy` will not remove it. Saying so tells whoever reads a
        # sweep which tool to go and look in.
        {"Key": "ManagedBy", "Value": f"{NAME_PREFIX}-api"},
    ]


def put_access_key(
    *,
    provider: str,
    account_id: str,
    access_key_id: str,
    secret_access_key: str,
) -> StoredKey:
    """Store the pair for an account, creating or rotating as needed.

    Resolved by NAME rather than by the connection's stored ARN, which
    is what makes registration and rotation one operation: one name per
    (provider, account id), so re-registering replaces the value instead
    of leaving the previous key live under an ARN nothing points at.
    """
    payload = json.dumps(
        {ACCESS_KEY_ID: access_key_id, SECRET_ACCESS_KEY: secret_access_key}
    )
    name = secret_name(provider, account_id)
    client = _client()

    try:
        created = client.create_secret(
            Name=name,
            SecretString=payload,
            Description=(
                f"CostHub cost-read credentials for {provider} account "
                f"{account_id}. Written by the API, not by Terraform."
            ),
            Tags=_tags(),
        )
        return StoredKey(arn=created["ARN"], created=True)
    except ClientError as exc:
        if _code(exc) != "ResourceExistsException":
            raise SecretError(_describe(exc, name)) from exc
        # This account has been registered before. A new version is the
        # right answer: the name identifies the account, and leaving the
        # old value in place would keep authenticating as whoever the
        # previous key belonged to.
        try:
            replaced = client.put_secret_value(SecretId=name, SecretString=payload)
        except ClientError as inner:
            raise SecretError(_describe(inner, name)) from inner
        except BotoCoreError as inner:
            raise SecretError(f"Could not reach Secrets Manager: {inner}") from inner
        return StoredKey(arn=replaced["ARN"], created=False)
    except BotoCoreError as exc:
        raise SecretError(f"Could not reach Secrets Manager: {exc}") from exc


def read_access_key(secret_arn: str) -> dict[str, str]:
    """The pair, resolved at call time. Never cached, never logged.

    Stripped, because a key pasted with a trailing newline produces a
    signature mismatch reading as "these credentials are wrong".
    """
    try:
        raw = _client().get_secret_value(SecretId=secret_arn)["SecretString"]
    except ClientError as exc:
        raise SecretError(_describe(exc, secret_arn)) from exc
    except BotoCoreError as exc:
        raise SecretError(f"Could not reach Secrets Manager: {exc}") from exc

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SecretError(
            f"The secret {secret_arn} does not contain JSON, so no access key "
            "could be read from it."
        ) from exc
    if not isinstance(data, dict):
        raise SecretError(
            f"The secret {secret_arn} contains JSON that is not an object, so "
            "no access key could be read from it."
        )

    # Field NAMES only. This message reaches an operator through the test
    # endpoint, and the one rule here is that a value never does.
    missing = [f for f in FIELDS if not str(data.get(f) or "").strip()]
    if missing:
        raise SecretError(
            f"The secret {secret_arn} is missing {sorted(missing)}. It must hold "
            f"a JSON object with {list(FIELDS)}."
        )
    return {f: str(data[f]).strip() for f in FIELDS}


def delete_access_key(secret_arn: str) -> None:
    """Remove a connection's stored key, immediately and for good.

    FORCED rather than scheduled, for the reason in the module
    docstring: the name is deterministic, and one merely scheduled for
    deletion cannot be created again until its recovery window elapses.

    A secret already gone is the end state this was asked for, so that
    is a success rather than an error.
    """
    if not owned(secret_arn):
        raise SecretError(
            f"Refusing to delete {secret_arn}: it is not under "
            f"{owned_prefix()!r}, so this deployment did not create it. Remove "
            "it wherever it is managed."
        )
    try:
        _client().delete_secret(SecretId=secret_arn, ForceDeleteWithoutRecovery=True)
    except ClientError as exc:
        if _code(exc) == "ResourceNotFoundException":
            return
        raise SecretError(_describe(exc, secret_arn)) from exc
    except BotoCoreError as exc:
        raise SecretError(f"Could not reach Secrets Manager: {exc}") from exc


def _describe(exc: ClientError, subject: str) -> str:
    """An AWS refusal, worded for whoever has to fix it."""
    code = _code(exc)
    if code in {"AccessDeniedException", "AccessDenied"}:
        return (
            f"This deployment is not allowed to manage {subject}. The grant is "
            f"scoped to {owned_prefix()}* in terraform/iam.tf -- apply it."
        )
    if code == "ResourceNotFoundException":
        return f"{subject} does not exist. Store the key again."
    if code == "InvalidRequestException":
        # A secret inside its recovery window. Deletion here is forced so
        # that cannot happen, so reaching this means something removed
        # the secret by another route.
        return (
            f"{subject} is scheduled for deletion, so it cannot be written. "
            "Restore it in the Secrets Manager console, or wait for its "
            f"recovery window to elapse. ({exc})"
        )
    return f"Secrets Manager call failed ({code or 'unknown'}): {exc}"
