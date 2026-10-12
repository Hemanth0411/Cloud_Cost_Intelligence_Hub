"""Token handling, which had no tests at all.

`api/deps.py` is the other half of the security boundary: `scoped.py`
decides what a Principal may see, and this module decides who the
Principal IS. Everything here is a pure function over a claims dict, so
none of it needs a database -- which makes the absence of tests harder to
excuse than it looks.

Two of the three behaviours below were bugs found by review, not by
these tests. They are pinned here so they stay fixed.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from costhub.api.deps import _email_from, dev_mode
from costhub.config import Settings


def _claims(**over) -> dict:
    base = {"email": "someone@chryselys.com", "email_verified": True}
    base.update(over)
    return base


# ------------------------------------------------- email_verified

def test_verified_claim_is_accepted():
    assert _email_from(_claims()) == "someone@chryselys.com"


def test_email_is_normalised():
    assert _email_from(_claims(email="  Someone@Chryselys.COM ")) == (
        "someone@chryselys.com"
    )


@pytest.mark.parametrize("value", ["true", "True", "TRUE"])
def test_string_true_is_accepted(value):
    """Federation and some SDK versions send the string, not the boolean."""
    assert _email_from(_claims(email_verified=value))


@pytest.mark.parametrize("value", [False, "false", None, 0, "", "yes"])
def test_unverified_is_rejected(value):
    with pytest.raises(HTTPException) as exc:
        _email_from(_claims(email_verified=value))
    assert exc.value.status_code == 403


def test_a_missing_claim_is_rejected_not_waved_through():
    """The regression this check exists for.

    The first version was `if "email_verified" in claims and not ...`,
    reasoning that an access token does not carry the claim and absence
    is not falsity. But the attack the check exists to stop -- change
    your email to a superadmin's address, re-authenticate, inherit the
    role -- is carried out with whatever token the attacker can get, and
    one with no `email_verified` claim sailed straight through the
    lenient branch.
    """
    claims = _claims()
    del claims["email_verified"]
    with pytest.raises(HTTPException) as exc:
        _email_from(claims)
    assert exc.value.status_code == 403


# ------------------------------------------------- identifier source

@pytest.mark.parametrize("key", ["username", "cognito:username"])
def test_username_claims_are_not_accepted_as_identity(key):
    """No falling back to the pool username.

    The pool is `username_attributes = ["email"]`, so for a real user
    these claims hold the email -- which is what made the fallback look
    free. It is not: they carry no verification status at all, so
    accepting one sourced the identity from a field `email_verified`
    says nothing about.
    """
    claims = {key: "someone@chryselys.com", "email_verified": True}
    with pytest.raises(HTTPException) as exc:
        _email_from(claims)
    assert exc.value.status_code == 401
    assert "no email" in exc.value.detail


# ------------------------------------------------- dev_mode

def _settings(**over) -> Settings:
    base = dict(
        allow_dev_auth=True,
        app_env="dev",
        cognito_user_pool_id="",
        database_url="postgresql://unused/unused",
    )
    base.update(over)
    return Settings(**base)


@pytest.mark.parametrize(
    "over,expected",
    [
        ({}, True),
        ({"allow_dev_auth": False}, False),
        ({"app_env": "main"}, False),
        ({"app_env": "staging"}, False),
        # The one that matters: a real pool is configured, so a deployed
        # environment can never be talked into the header bypass even if
        # the other two flags are wrong.
        ({"cognito_user_pool_id": "us-east-1_abc123"}, False),
    ],
)
def test_dev_mode_requires_all_three_conditions(monkeypatch, over, expected):
    import costhub.api.deps as deps

    monkeypatch.setattr(deps, "settings", lambda: _settings(**over))
    assert dev_mode() is expected
