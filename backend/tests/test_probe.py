"""The connection probe, and specifically which stage it blames.

The probe exists to answer one question the scheduled ingest cannot
answer for a day: of the three things a target account must do, which
one is missing? Two of them fail with the SAME AWS error code --
AccessDenied -- for completely different reasons and with different
people able to fix them:

  * AssumeRole denied  -> role missing / trust policy wrong / ExternalId
                          mismatch. Their IAM admin, no root needed.
  * cost call denied   -> we hold the role, so trust is right. The
                          billing toggle is off (ROOT ONLY) or the
                          policy lacks ce:Get*.

Conflating those sends somebody to check the wrong thing, which is one
email round trip per mistake. So the stage is the assertion here, not
just `ok`.

No AWS is contacted: the STS call (`assume_role`) and the `ce` client
are replaced. `own_session` is replaced too, except in the two tests at
the bottom, which run the REAL one on a machine made to have no
credentials -- that failure is local, so it needs no AWS and no
stand-in.

The error codes raised by the fakes are the ones AWS was observed to
return, not the ones the code would like: on 2026-10-13 a real
`sts:AssumeRole` on `...:role/costhub/CostHubCostReader` answered
AccessDenied, and only a string that is not an ARN at all answered
ValidationError.
"""
from __future__ import annotations

import os

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError

from costhub.connections import probe as probe_mod
from costhub.connections.credentials import Connection
from costhub.connections.credentials import own_session as real_own_session


def _conn(**over) -> Connection:
    base = dict(
        id="c-1",
        provider="aws",
        account_id="881953306582",
        display_name="Stemline",
        credential_mode="assume_role",
        role_arn="arn:aws:iam::881953306582:role/CostHubCostReader",
        external_id="ext-1",
        profile_name=None,
        secret_arn=None,
    )
    base.update(over)
    return Connection(**base)


def _client_error(code: str, op: str = "AssumeRole") -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": code}}, op)


class _FakeCe:
    def __init__(self, values=None, raises=None):
        self._values = values or []
        self._raises = raises

    def get_dimension_values(self, **_):
        if self._raises:
            raise self._raises
        return {"DimensionValues": [{"Value": v} for v in self._values]}


class _FakeSession:
    def __init__(self, ce):
        self._ce = ce

    def client(self, name, **_):
        assert name == "ce"
        return self._ce


def _raising(exc):
    def _boom(*_a, **_k):
        raise exc

    return _boom


@pytest.fixture
def sts_answers(monkeypatch):
    """We have credentials of our own; STS refuses the role with `exc`."""

    def _install(exc: Exception):
        monkeypatch.setattr(probe_mod, "own_session", lambda c: object())
        monkeypatch.setattr(probe_mod, "assume_role", _raising(exc))

    return _install


@pytest.fixture
def reaches(monkeypatch):
    """Both credential steps succeed; Cost Explorer is `ce`."""

    def _install(ce: _FakeCe):
        monkeypatch.setattr(probe_mod, "own_session", lambda c: object())
        monkeypatch.setattr(probe_mod, "assume_role", lambda own, c: _FakeSession(ce))

    return _install


# ------------------------------------------------- stage: assume_role

def test_assume_role_denied_blames_the_role_not_the_billing_switch(sts_answers):
    sts_answers(_client_error("AccessDenied"))
    r = probe_mod.probe(_conn())

    assert r.ok is False
    assert r.stage == "assume_role"
    # Must point at the role, and must NOT send them to the root-only
    # billing setting -- that is the other failure.
    assert "trust policy" in r.detail
    assert "does not need root" in r.detail
    assert "Billing Information" not in r.detail
    # A role under a path is one of the causes of this same denial, so
    # it is listed -- but a correctly shaped ARN must not be told it is
    # the thing that is wrong.
    assert "root IAM path" in r.detail
    assert "stored here is not" not in r.detail


def test_a_pathed_role_arn_is_denied_and_the_blame_lands_on_our_side(sts_answers):
    """A role under an IAM path is a VALID arn, so STS says AccessDenied.

    This test used to raise ValidationError here and assert the hint
    appeared -- which only proved the hint was wired to the code we had
    guessed, not to the one AWS sends. Our own policy grants exactly
    `role/CostHubCostReader`, so for this ARN the caller is denied before
    the other account's trust policy is read; telling their admin to fix
    it is the wrong email to send.
    """
    sts_answers(_client_error("AccessDenied"))
    r = probe_mod.probe(
        _conn(role_arn="arn:aws:iam::881953306582:role/costhub/CostHubCostReader")
    )

    assert r.stage == "assume_role"
    assert "root IAM path" in r.detail
    assert "stored here is not" in r.detail
    assert "correct the ARN on this connection" in r.detail
    assert "fixable by their IAM administrator" not in r.detail


def test_a_wrongly_named_role_gets_the_same_treatment(sts_answers):
    sts_answers(_client_error("AccessDenied"))
    r = probe_mod.probe(_conn(role_arn="arn:aws:iam::881953306582:role/CostReader"))

    assert "stored here is not" in r.detail


def test_a_string_that_is_not_an_arn_is_called_malformed_not_pathed(sts_answers):
    """The only input observed to produce ValidationError."""
    sts_answers(_client_error("ValidationError"))
    r = probe_mod.probe(_conn(role_arn="not-an-arn-at-all-but-long-enough"))

    assert r.stage == "assume_role"
    assert "not a valid role ARN" in r.detail
    assert "root IAM path" not in r.detail


def test_a_missing_role_arn_is_a_credentials_problem(monkeypatch):
    """Runs the real `assume_role`: it refuses before building a client."""
    monkeypatch.setattr(probe_mod, "own_session", lambda c: object())
    r = probe_mod.probe(_conn(role_arn=None))

    assert r.stage == "credentials"
    assert "role_arn missing" in r.detail


def test_a_value_botocore_refuses_to_send_is_not_blamed_on_sts(monkeypatch):
    """The real `assume_role`, on a real session with made-up keys.

    botocore validates RoleArn (20+ characters) before any request, and
    raises ParamValidationError -- a BotoCoreError, so it read "Could
    not reach AWS STS" for a typo that never left this process. If this
    test ever makes a network call it has stopped testing that.
    """
    import boto3

    offline = boto3.Session(
        aws_access_key_id="AKIAIOSFODNN7EXAMPLE",
        aws_secret_access_key="made-up",
        region_name="us-east-1",
    )
    monkeypatch.setattr(probe_mod, "own_session", lambda c: offline)
    r = probe_mod.probe(_conn(role_arn="role/short"))

    assert r.ok is False
    assert r.stage == "credentials"
    assert "nothing was sent to AWS" in r.detail
    assert "Could not reach" not in r.detail


def test_stray_whitespace_in_the_arn_is_shown_not_hidden(sts_answers):
    sts_answers(_client_error("AccessDenied"))
    r = probe_mod.probe(_conn(role_arn="arn:aws:iam::881953306582:role/CostHubCostReader "))

    assert "stored here is not" in r.detail
    assert "CostHubCostReader '" in r.detail, "quoted, so the space can be seen"


def test_sts_unreachable_is_still_an_assume_role_failure(sts_answers):
    """A transport failure DURING the STS call is the one BotoCoreError
    that legitimately belongs to this stage."""
    sts_answers(EndpointConnectionError(endpoint_url="https://sts.us-east-1.amazonaws.com"))
    r = probe_mod.probe(_conn())

    assert r.stage == "assume_role"
    assert "Could not reach AWS STS" in r.detail


# ------------------------------------------------ stage: cost_explorer

def test_cost_denied_blames_the_billing_switch_not_the_role(reaches):
    """The message that saves a wasted round trip."""
    reaches(_FakeCe(raises=_client_error("AccessDeniedException", "GetDimensionValues")))
    r = probe_mod.probe(_conn())

    assert r.ok is False
    assert r.stage == "cost_explorer"
    # It must SAY the trust policy is fine, or the reader will go back to
    # the IAM admin who already did their part correctly.
    assert "assumed successfully" in r.detail
    assert "ROOT USER ONLY" in r.detail


def test_cost_explorer_not_enabled_is_reported_as_itself(reaches):
    reaches(_FakeCe(raises=_client_error("DataUnavailableException", "GetDimensionValues")))
    r = probe_mod.probe(_conn())

    assert r.stage == "cost_explorer"
    assert "Cost Explorer is not enabled" in r.detail
    assert "24 hours" in r.detail


# ----------------------------------------------------------- stage: ok

def test_success_returns_evidence_not_just_a_flag(reaches):
    reaches(_FakeCe(values=["Amazon Relational Database Service", "AWS Amplify"]))
    r = probe_mod.probe(_conn())

    assert r.ok is True
    assert r.stage == "ok"
    # A list of real service names proves we read THIS account, rather
    # than merely getting a 200 from somewhere.
    assert r.sample == ["AWS Amplify", "Amazon Relational Database Service"]
    assert "2 service" in r.detail


def test_no_services_is_a_pass_not_a_failure(reaches):
    """A new account is readable and simply has nothing yet.

    Reporting this as failure would send someone to debug permissions
    that are already correct -- which is exactly the state this
    deployment's own account was in for its first day.
    """
    reaches(_FakeCe(values=[]))
    r = probe_mod.probe(_conn())

    assert r.ok is True
    assert r.sample == []
    assert "No services billed" in r.detail


def test_a_self_connection_never_calls_sts(monkeypatch):
    """`self` reads with our own session; there is no role to assume."""
    ce = _FakeCe(values=["AWS Lambda"])
    monkeypatch.setattr(probe_mod, "own_session", lambda c: _FakeSession(ce))
    monkeypatch.setattr(
        probe_mod, "assume_role", _raising(AssertionError("STS must not be called"))
    )
    r = probe_mod.probe(_conn(credential_mode="self", role_arn=None, account_id="self"))

    assert r.ok is True


# -------------------------------------------------------- non-AWS

@pytest.mark.parametrize("provider", ["azure", "gcp"])
def test_non_aws_says_it_is_not_implemented_rather_than_failing(provider):
    r = probe_mod.probe(_conn(provider=provider))

    assert r.ok is False
    assert r.stage == "unsupported"
    # "not implemented" and "misconfigured" must not look the same.
    assert "AWS only" in r.detail


# ------------------------------------------------ stage: credentials
#
# The real `own_session`, on a machine made to have no credentials. No
# stand-in for botocore: the claim under test is what botocore actually
# raises, and where the probe files it.

@pytest.fixture
def no_local_aws(monkeypatch, tmp_path):
    for var in list(os.environ):
        if var.startswith("AWS_"):
            monkeypatch.delenv(var)
    monkeypatch.setenv("AWS_CONFIG_FILE", str(tmp_path / "config"))
    monkeypatch.setenv("AWS_SHARED_CREDENTIALS_FILE", str(tmp_path / "credentials"))
    # Otherwise botocore spends seconds asking a metadata service that
    # is not there -- and on EC2 would find credentials after all.
    monkeypatch.setenv("AWS_EC2_METADATA_DISABLED", "true")
    monkeypatch.setattr(probe_mod, "own_session", real_own_session)
    monkeypatch.setattr(
        probe_mod, "assume_role", _raising(AssertionError("STS must not be called"))
    )


def test_a_profile_missing_on_this_machine_is_not_blamed_on_sts(no_local_aws):
    """ProfileNotFound is a BotoCoreError, and used to be filed as stage
    "assume_role", "Could not reach AWS STS" -- for a failure in which
    STS was never contacted. This is the state of any `profile`
    connection the moment it runs in Lambda."""
    r = probe_mod.probe(
        _conn(credential_mode="profile", profile_name="no-such-profile", role_arn=None)
    )

    assert r.ok is False
    assert r.stage == "credentials"
    assert "no-such-profile" in r.detail
    assert "STS" not in r.detail
    assert "target account was not tested" in r.detail


def test_no_credentials_of_our_own_is_our_fault_not_the_roles(no_local_aws):
    r = probe_mod.probe(_conn())

    assert r.stage == "credentials"
    assert "no AWS credentials" in r.detail
    assert "trust policy" not in r.detail
