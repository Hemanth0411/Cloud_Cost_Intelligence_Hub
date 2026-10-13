"""Turning a cloud_connections row into a usable client session.

Four credential modes, in decreasing order of preference:

  self         the deploy account -- the Lambda's own role, nothing to hold
  assume_role  another AWS account -- short-lived credentials via STS
  profile      local development only
  secret       a static credential in Secrets Manager, read at call time

`secret` IS NOW AVAILABLE TO AWS, and that is a change. It used to be
Azure's alone, because Azure has no equivalent of AssumeRole and an AWS
connection had a better answer available. It still has: `assume_role`
yields credentials that expire in an hour and leaves nothing long-lived
anywhere, and it remains the default. But it needs an IAM role created
in the target account, and the common case this deployment actually hit
was somebody who already holds their own key with Cost Explorer access
and nobody in that account who will create a role for them -- so the
alternative was not AssumeRole, it was `profile`, which cannot run in
Lambda at all.

Nothing here stores or returns a long-lived credential. The database
holds an ARN; `key_store.py` owns the secret the ARN points at.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import boto3
from botocore.exceptions import BotoCoreError

from costhub.config import settings
from costhub.connections import key_store

SESSION_NAME = "costhub-ingest"
SESSION_SECONDS = 3600


class CredentialError(Exception):
    pass


@dataclass(frozen=True)
class Connection:
    """A row from cloud_connections, as the ingest layer sees it."""

    id: str
    provider: str
    account_id: str
    display_name: str
    credential_mode: str
    role_arn: str | None = None
    external_id: str | None = None
    profile_name: str | None = None
    secret_arn: str | None = None
    # Carried so a caller can refuse to act on a disabled connection.
    # `store.enabled()` filters for the scheduled path, but anything that
    # fetches ONE connection by id gets it regardless -- and an
    # on-demand import then spent Cost Explorer calls and wrote rows for
    # an account the operator had deliberately switched off.
    enabled: bool = True

    @classmethod
    def from_row(cls, row: dict) -> "Connection":
        keep = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in row.items() if k in keep})


def own_session(conn: Connection) -> boto3.Session:
    """OUR side of the credential chain, with no call to the target account.

    `self`, `profile` and `secret` read with this session directly;
    `assume_role` uses it only to sign the STS call. Separate from
    `assume_role` below
    because the two fail for opposite reasons and different people fix
    them: a failure HERE is this deployment's own configuration (a
    profile that does not exist on this machine, no credentials in the
    environment), and nothing has been sent to AWS about the target
    account at all. Fused into one function, the probe reported both as
    "Could not reach AWS STS" and blamed the other account's role.

    Raises CredentialError for every failure, so no botocore exception
    leaves this function to be mistaken for an AWS-side answer. (STS can
    still reject credentials that loaded fine -- ExpiredToken and the
    like -- and that does come back from `assume_role`, as a ClientError
    naming the code.)
    """
    if conn.provider != "aws":
        raise CredentialError(f"not an AWS connection: {conn.provider}")

    region = settings().aws_region

    if conn.credential_mode == "secret":
        # Returns early: this mode builds a session from explicit keys
        # rather than from a profile, so it shares none of the chain
        # below.
        return _stored_key_session(conn, region)

    if conn.credential_mode in ("self", "assume_role"):
        # The deploy account. In Lambda this is the execution role; locally
        # it is whatever the default profile resolves to.
        profile = None
    elif conn.credential_mode == "profile":
        if not conn.profile_name:
            raise CredentialError(f"{conn.display_name}: profile_name missing")
        profile = conn.profile_name
    else:
        raise CredentialError(
            f"{conn.display_name}: unsupported credential_mode "
            f"{conn.credential_mode!r} for AWS"
        )

    whose = f"profile {profile!r}" if profile else "its own credentials"
    try:
        session = boto3.Session(profile_name=profile, region_name=region)
        # Resolved NOW rather than at the first signed request: boto3 is
        # lazy, so without this a machine with no credentials built a
        # perfectly good-looking session and failed later, inside
        # whichever AWS call happened to come first.
        #
        # FROZEN, not merely found. For an SSO profile, or one that
        # chains through `source_profile`, `get_credentials()` returns a
        # deferred object without fetching anything -- so an expired SSO
        # login still surfaced at the first signed call and was blamed on
        # whatever that call was. Freezing forces the fetch here.
        found = session.get_credentials()
        if found is not None:
            found.get_frozen_credentials()
    except (BotoCoreError, OSError) as exc:
        # OSError too: a profile whose `credential_process` names a
        # binary that is not there raises FileNotFoundError, not a
        # botocore error, and went out of the probe as a 500.
        raise CredentialError(
            f"{conn.display_name}: this deployment could not load {whose} ({exc}). "
            "Nothing was sent to AWS, and the target account was not tested."
        ) from exc
    if found is None:
        raise CredentialError(
            f"{conn.display_name}: this deployment has no AWS credentials "
            f"({whose}). Nothing was sent to AWS, and the target account was "
            "not tested."
        )
    return session


def _stored_key_session(conn: Connection, region: str) -> boto3.Session:
    """A session built from the access key this connection owns.

    Still "our side", for the reason `own_session` is split from
    `assume_role`: the only call made here is to OUR Secrets Manager, so
    a failure is this deployment's own configuration -- a missing ARN, a
    policy that has not been applied, a secret somebody removed -- and
    nothing has been sent to the target account. The probe reports that
    as stage "credentials", which is the stage whose advice is "look on
    this side", and that is the correct advice for every failure below.

    `SecretError` is translated rather than propagated for exactly that
    reason: `probe` catches `CredentialError` at stage 0, and a
    botocore error escaping from here would arrive as an unhandled 500
    on an endpoint whose entire job is to name the broken prerequisite.
    """
    if not conn.secret_arn:
        raise CredentialError(
            f"{conn.display_name}: secret_arn missing. This connection is set "
            "to use a stored access key but no secret is attached to it -- "
            "store the key again from the connections screen."
        )
    try:
        pair = key_store.read_access_key(conn.secret_arn)
    except key_store.SecretError as exc:
        raise CredentialError(
            f"{conn.display_name}: this deployment could not read the stored "
            f"access key. {exc} Nothing was sent to AWS, and the target "
            "account was not tested."
        ) from exc

    # No session token: these are long-lived user credentials, not the
    # output of an STS call. Passing aws_session_token=None is the same
    # as omitting it, but omitting it says so.
    return boto3.Session(
        aws_access_key_id=pair[key_store.ACCESS_KEY_ID],
        aws_secret_access_key=pair[key_store.SECRET_ACCESS_KEY],
        region_name=region,
    )


def assume_role(own: boto3.Session, conn: Connection) -> boto3.Session:
    """Exchange our identity for short-lived credentials in `conn`'s account.

    The one call here that talks to STS about the target role. A
    ClientError out of this function is AWS's answer about that role.
    """
    if not conn.role_arn:
        raise CredentialError(f"{conn.display_name}: role_arn missing")

    params: dict[str, Any] = {
        "RoleArn": conn.role_arn,
        "RoleSessionName": SESSION_NAME,
        "DurationSeconds": SESSION_SECONDS,
    }
    # External ID guards against the confused-deputy problem: the role
    # in the other account will only answer if we present it.
    if conn.external_id:
        params["ExternalId"] = conn.external_id

    creds = own.client("sts").assume_role(**params)["Credentials"]
    return boto3.Session(
        aws_access_key_id=creds["AccessKeyId"],
        aws_secret_access_key=creds["SecretAccessKey"],
        aws_session_token=creds["SessionToken"],
        region_name=own.region_name,
    )


def aws_session(conn: Connection) -> boto3.Session:
    """A boto3 session scoped to `conn`'s account.

    Only `assume_role` makes a second hop. `self` reads the deploy
    account directly, and `profile` and `secret` are already the target
    account's own credentials -- assuming a role on top of either would
    look for a CostHubCostReader that the whole point of those modes is
    not needing.
    """
    own = own_session(conn)
    if conn.credential_mode == "assume_role":
        return assume_role(own, conn)
    return own


def azure_credentials(conn: Connection) -> dict[str, str]:
    """Resolve an Azure service principal from Secrets Manager.

    Azure has no cross-cloud equivalent of AssumeRole, so a long-lived
    client secret is unavoidable. It lives in Secrets Manager and is read
    at call time -- never persisted by us, never in the database.
    """
    if conn.provider != "azure":
        raise CredentialError(f"not an Azure connection: {conn.provider}")
    if not conn.secret_arn:
        raise CredentialError(f"{conn.display_name}: secret_arn missing")

    raw = boto3.client("secretsmanager", region_name=settings().aws_region) \
        .get_secret_value(SecretId=conn.secret_arn)["SecretString"]
    data = json.loads(raw)

    missing = {"tenant_id", "client_id", "client_secret"} - set(data)
    if missing:
        raise CredentialError(
            f"{conn.display_name}: secret missing {sorted(missing)}"
        )
    return data
