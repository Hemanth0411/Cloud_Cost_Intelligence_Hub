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

No AWS is contacted: `aws_session` and the `ce` client are replaced.
"""
from __future__ import annotations

import pytest
from botocore.exceptions import ClientError

from costhub.connections import probe as probe_mod
from costhub.connections.credentials import Connection, CredentialError


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


# ------------------------------------------------- stage: assume_role

def test_assume_role_denied_blames_the_role_not_the_billing_switch(monkeypatch):
    monkeypatch.setattr(
        probe_mod, "aws_session", lambda c: (_ for _ in ()).throw(_client_error("AccessDenied"))
    )
    r = probe_mod.probe(_conn())

    assert r.ok is False
    assert r.stage == "assume_role"
    # Must point at the role, and must NOT send them to the root-only
    # billing setting -- that is the other failure.
    assert "trust policy" in r.detail
    assert "does not need root" in r.detail
    assert "Billing Information" not in r.detail


def test_a_bad_role_arn_mentions_the_root_path_trap(monkeypatch):
    monkeypatch.setattr(
        probe_mod, "aws_session", lambda c: (_ for _ in ()).throw(_client_error("ValidationError"))
    )
    r = probe_mod.probe(_conn(role_arn="arn:aws:iam::881953306582:role/costhub/CostHubCostReader"))

    assert r.stage == "assume_role"
    assert "root IAM path" in r.detail


def test_a_missing_role_arn_is_a_credentials_problem(monkeypatch):
    def boom(_c):
        raise CredentialError("Stemline: role_arn missing")

    monkeypatch.setattr(probe_mod, "aws_session", boom)
    r = probe_mod.probe(_conn(role_arn=None))

    assert r.stage == "credentials"
    assert "role_arn missing" in r.detail


# ------------------------------------------------ stage: cost_explorer

def test_cost_denied_blames_the_billing_switch_not_the_role(monkeypatch):
    """The message that saves a wasted round trip."""
    ce = _FakeCe(raises=_client_error("AccessDeniedException", "GetDimensionValues"))
    monkeypatch.setattr(probe_mod, "aws_session", lambda c: _FakeSession(ce))
    r = probe_mod.probe(_conn())

    assert r.ok is False
    assert r.stage == "cost_explorer"
    # It must SAY the trust policy is fine, or the reader will go back to
    # the IAM admin who already did their part correctly.
    assert "assumed successfully" in r.detail
    assert "ROOT USER ONLY" in r.detail


def test_cost_explorer_not_enabled_is_reported_as_itself(monkeypatch):
    ce = _FakeCe(raises=_client_error("DataUnavailableException", "GetDimensionValues"))
    monkeypatch.setattr(probe_mod, "aws_session", lambda c: _FakeSession(ce))
    r = probe_mod.probe(_conn())

    assert r.stage == "cost_explorer"
    assert "Cost Explorer is not enabled" in r.detail
    assert "24 hours" in r.detail


# ----------------------------------------------------------- stage: ok

def test_success_returns_evidence_not_just_a_flag(monkeypatch):
    ce = _FakeCe(values=["Amazon Relational Database Service", "AWS Amplify"])
    monkeypatch.setattr(probe_mod, "aws_session", lambda c: _FakeSession(ce))
    r = probe_mod.probe(_conn())

    assert r.ok is True
    assert r.stage == "ok"
    # A list of real service names proves we read THIS account, rather
    # than merely getting a 200 from somewhere.
    assert r.sample == ["AWS Amplify", "Amazon Relational Database Service"]
    assert "2 service" in r.detail


def test_no_services_is_a_pass_not_a_failure(monkeypatch):
    """A new account is readable and simply has nothing yet.

    Reporting this as failure would send someone to debug permissions
    that are already correct -- which is exactly the state this
    deployment's own account was in for its first day.
    """
    monkeypatch.setattr(probe_mod, "aws_session", lambda c: _FakeSession(_FakeCe(values=[])))
    r = probe_mod.probe(_conn())

    assert r.ok is True
    assert r.sample == []
    assert "No services billed" in r.detail


# -------------------------------------------------------- non-AWS

@pytest.mark.parametrize("provider", ["azure", "gcp"])
def test_non_aws_says_it_is_not_implemented_rather_than_failing(provider):
    r = probe_mod.probe(_conn(provider=provider))

    assert r.ok is False
    assert r.stage == "unsupported"
    # "not implemented" and "misconfigured" must not look the same.
    assert "AWS only" in r.detail
