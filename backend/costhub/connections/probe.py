"""Test a connection now, and say which prerequisite is missing.

Cross-account cost access needs THREE things in the target account, and
the role is only one of them:

  1. an IAM role `CostHubCostReader` at the root path, whose trust policy
     allows this account with the matching ExternalId
  2. "IAM User and Role Access to Billing Information" enabled -- root
     only, and without it every cost API returns AccessDenied however
     perfect the role is
  3. Cost Explorer enabled

Before this module existed, you found out which one was missing at
06:00 UTC the next day, when the scheduled ingest wrote `failed` on the
connection. That is a terrible loop when the fix lives in somebody
else's AWS account and each round trip is an email.

THE WHOLE POINT IS THE TWO-STAGE PROBE. AssumeRole and the cost call
fail with the same error code -- AccessDenied -- for completely
different reasons, and conflating them sends the other administrator to
check the wrong thing:

  * AssumeRole denied  -> the role is missing, or its trust policy does
                          not name this account, or the ExternalId does
                          not match. Their IAM admin can fix it.
  * cost call denied   -> the role exists and we assumed it. The billing
                          toggle is off, or the policy lacks ce:Get*.
                          Only root can do the former.

So the probe reports which STAGE failed, not just that something did.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, timedelta

from botocore.exceptions import BotoCoreError, ClientError, ParamValidationError

from costhub.connections.credentials import (
    Connection,
    CredentialError,
    assume_role,
    own_session,
)

log = logging.getLogger(__name__)

CE_REGION = "us-east-1"
DENIED = {"AccessDeniedException", "AccessDenied", "UnauthorizedException"}
# The role name this deployment's own IAM policy lets it assume in ANY
# account, at the root path (terraform/iam.tf,
# "AssumeCostReaderRolesByName"). The same statement also admits ARNs
# listed one by one in `data_source_accounts` in tfvars, which this
# process cannot see -- hence "unless" in the message below.
PERMITTED_ROLE = "CostHubCostReader"


@dataclass(frozen=True)
class ProbeResult:
    ok: bool
    stage: str
    detail: str
    # Present only on success, and the real reason to run this: a list of
    # service names proves we read THIS account's data rather than just
    # getting a 200.
    sample: list[str] | None = None

    def as_dict(self) -> dict:
        return {
            "ok": self.ok,
            "stage": self.stage,
            "detail": self.detail,
            "sample": self.sample,
        }


def probe(conn: Connection) -> ProbeResult:
    """Resolve our credentials, assume the role, make one cheap cost call.

    Never raises for an expected failure: the caller is an API route
    whose job is to report the outcome, and a 500 would tell the operator
    nothing about which of the three prerequisites is missing.
    """
    if conn.provider != "aws":
        # Azure needs a service principal from Secrets Manager and has
        # never been exercised against a real subscription. Saying so is
        # more useful than a probe that cannot distinguish "not
        # configured" from "not implemented".
        return ProbeResult(
            ok=False,
            stage="unsupported",
            detail=(
                f"Testing is implemented for AWS only. {conn.provider} connections "
                "are read with a service principal held in Secrets Manager and "
                "cannot be verified from here yet."
            ),
        )

    # ---- stage 0: do WE have credentials at all? ----------------------
    #
    # Its own step, and deliberately outside the AssumeRole handler. A
    # profile that does not exist on this machine raises ProfileNotFound,
    # which is a BotoCoreError -- so when this shared a try block with
    # the STS call it was reported as stage "assume_role", "Could not
    # reach AWS STS", for a failure in which STS was never contacted and
    # the other account's role had nothing to do with it.
    try:
        session = own_session(conn)
    except CredentialError as exc:
        return ProbeResult(ok=False, stage="credentials", detail=str(exc))

    # ---- stage 1: can we become the role at all? ----------------------
    if conn.credential_mode == "assume_role":
        try:
            session = assume_role(session, conn)
        except CredentialError as exc:
            return ProbeResult(ok=False, stage="credentials", detail=str(exc))
        except ClientError as exc:
            return ProbeResult(ok=False, stage="assume_role", detail=_describe_assume(conn, exc))
        except ParamValidationError as exc:
            # botocore refused to SEND it: a role ARN under 20 characters
            # or an ExternalId under 2. It is a BotoCoreError, so it used
            # to fall through to "Could not reach AWS STS" -- for a value
            # stored on this side that never left the process.
            return ProbeResult(
                ok=False,
                stage="credentials",
                detail=(
                    f"The role ARN {conn.role_arn!r} or the ExternalId stored on this "
                    "connection is not valid, so nothing was sent to AWS and the "
                    f"target account was not tested. ({str(exc).strip()})"
                ),
            )
        except BotoCoreError as exc:
            return ProbeResult(
                ok=False, stage="assume_role", detail=f"Could not reach AWS STS: {exc}"
            )

    # ---- stage 2: can that role read cost data? -----------------------
    #
    # GetDimensionValues over yesterday is the cheapest useful call:
    # $0.01, one day of data, and it returns service names, so a success
    # is evidence rather than just a status code.
    end = date.today()
    start = end - timedelta(days=1)
    try:
        client = session.client("ce", region_name=CE_REGION)
        response = client.get_dimension_values(
            TimePeriod={"Start": start.isoformat(), "End": end.isoformat()},
            Dimension="SERVICE",
        )
    except ClientError as exc:
        return ProbeResult(ok=False, stage="cost_explorer", detail=_describe_cost(conn, exc))
    except BotoCoreError as exc:
        return ProbeResult(
            ok=False, stage="cost_explorer", detail=f"Could not reach Cost Explorer: {exc}"
        )

    services = [
        v.get("Value", "")
        for v in (response.get("DimensionValues") or [])
        if v.get("Value")
    ]

    # An empty list is a PASS, and saying so matters. A new account, or
    # one whose Cost Explorer was enabled in the last 24 hours, is
    # readable and simply has nothing yet -- which looks identical to a
    # failure if the only thing reported is "no data".
    if not services:
        return ProbeResult(
            ok=True,
            stage="ok",
            detail=(
                "Access works. No services billed in the last day -- expected for a new "
                "account, or one where Cost Explorer was enabled within the last 24 hours."
            ),
            sample=[],
        )

    return ProbeResult(
        ok=True,
        stage="ok",
        detail=f"Access works. Read {len(services)} service(s) from this account.",
        sample=sorted(services)[:8],
    )


def _off_root_path(role_arn: str | None) -> bool:
    """Is this a role ARN outside the by-name grant in our own policy?

    Anything after `:role/` other than exactly the permitted name -- a
    path (`role/costhub/CostHubCostReader`), a different name, or the
    right name with stray whitespace pasted after it.
    """
    if not role_arn or ":role/" not in role_arn:
        return False
    return role_arn.split(":role/", 1)[1] != PERMITTED_ROLE


def _describe_assume(conn: Connection, exc: ClientError) -> str:
    code = exc.response.get("Error", {}).get("Code", "")
    if code in DENIED:
        # The root-path advice lives HERE. It used to sit in the
        # ValidationError branch below, on the assumption that STS
        # rejects a pathed ARN as malformed. It does not: such an ARN is
        # perfectly valid, so STS evaluates it and answers AccessDenied
        # -- and it is OUR policy doing the denying, because it grants
        # exactly `role/CostHubCostReader`. The old message for that case
        # sent the other administrator to fix a trust policy when the
        # fault was the ARN stored on this side.
        if _off_root_path(conn.role_arn):
            # !r so a trailing space or newline is visible in the message.
            return (
                f"Could not assume {conn.role_arn!r}. This deployment is permitted to "
                f"assume a role named exactly '{PERMITTED_ROLE}' at the root IAM path "
                f"('...:role/{PERMITTED_ROLE}'), and the ARN stored here is not that "
                "-- a role created under a path has the ARN "
                f"'...:role/<path>/{PERMITTED_ROLE}'. Unless this exact ARN was added "
                "to the deployment's own policy by hand, the denial comes from this "
                "side, before their trust policy is ever consulted: correct the ARN "
                "on this connection, or have the role recreated at the root path. "
                "(If it was added, look at their trust policy and the ExternalId "
                "instead.) AWS returns the same AccessDenied either way."
            )
        return (
            f"Could not assume {conn.role_arn or 'the role'}. The role does not exist, "
            "its trust policy does not allow this account, or the ExternalId does not "
            "match. This is fixable by their IAM administrator and does not need root. "
            f"The role must also sit at the root IAM path, named '{PERMITTED_ROLE}': "
            "one created under a path has a different ARN and is denied identically."
        )
    if code in {"NoSuchEntity", "ValidationError", "InvalidParameterValue"}:
        # Reached only for a string long enough to send that is not an
        # ARN. (Shorter than 20 characters never gets this far: botocore
        # rejects it client-side, handled in `probe`.) A well-formed ARN
        # never lands here, whatever its path.
        return (
            f"AWS rejected {conn.role_arn!r} as not a valid role ARN. It should look "
            f"like 'arn:aws:iam::<12-digit account id>:role/{PERMITTED_ROLE}'."
        )
    return f"AssumeRole failed ({code or 'unknown'}): {exc}"


def _describe_cost(conn: Connection, exc: ClientError) -> str:
    code = exc.response.get("Error", {}).get("Code", "")
    if code in DENIED:
        # The valuable message. We got the role, so IAM trust is right;
        # what is left is the account-level billing switch or a policy
        # missing ce:Get*.
        return (
            "The role was assumed successfully, so its trust policy is correct -- but it "
            "cannot read cost data. Either 'IAM User and Role Access to Billing "
            "Information' is not enabled in that account (account settings, ROOT USER "
            "ONLY), or the role's policy is missing the ce:Get* actions."
        )
    if code == "DataUnavailableException":
        return (
            "Cost Explorer is not enabled in that account yet, or has not finished "
            "preparing data. It is free, enabled once, and can take up to 24 hours."
        )
    return f"Cost Explorer call failed ({code or 'unknown'}): {exc}"
