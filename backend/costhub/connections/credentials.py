"""Turning a cloud_connections row into a usable client session.

Four credential modes, in decreasing order of preference:

  self         the deploy account -- the Lambda's own role, nothing to hold
  assume_role  another AWS account -- short-lived credentials via STS
  profile      local development only
  secret       a Secrets Manager ARN (Azure needs this; AWS should not)

Nothing here ever stores or returns a long-lived credential. `secret` holds
an ARN and resolves it at call time.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import boto3

from costhub.config import settings

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


def aws_session(conn: Connection) -> boto3.Session:
    """A boto3 session scoped to `conn`'s account."""
    if conn.provider != "aws":
        raise CredentialError(f"not an AWS connection: {conn.provider}")

    region = settings().aws_region

    if conn.credential_mode == "self":
        # The deploy account. In Lambda this is the execution role; locally
        # it is whatever the default profile resolves to.
        return boto3.Session(region_name=region)

    if conn.credential_mode == "profile":
        if not conn.profile_name:
            raise CredentialError(f"{conn.display_name}: profile_name missing")
        return boto3.Session(profile_name=conn.profile_name, region_name=region)

    if conn.credential_mode == "assume_role":
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

        creds = boto3.client("sts", region_name=region).assume_role(**params)["Credentials"]
        return boto3.Session(
            aws_access_key_id=creds["AccessKeyId"],
            aws_secret_access_key=creds["SecretAccessKey"],
            aws_session_token=creds["SessionToken"],
            region_name=region,
        )

    raise CredentialError(
        f"{conn.display_name}: unsupported credential_mode "
        f"{conn.credential_mode!r} for AWS"
    )


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
