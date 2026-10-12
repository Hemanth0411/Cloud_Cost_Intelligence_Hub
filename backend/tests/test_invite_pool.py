"""The invite writes BOTH halves, or neither.

`invite_user` used to write a `users` row and nothing else, while its own
docstring said "Cognito emails a one-time code". No code path anywhere
called AdminCreateUser, so an invited teammate got a database row,
Cognito had never heard of them, and no code could ever be sent. The only
pool user was the superadmin, created declaratively in Terraform.

That bug was invisible to the suite because every test ran without a
Cognito pool -- which is exactly the configuration where writing only the
database row is correct. These tests therefore pin the behaviour with the
pool adapter faked, so "is the pool written to?" is observable without
one.
"""
from __future__ import annotations

import pytest

from costhub.rbac import admin as rbac
from costhub.rbac import pool


class FakePool:
    """Records calls, and can be told to fail like Cognito does."""

    def __init__(self, result="created", error=None):
        self.result = result
        self.error = error
        self.calls: list[str] = []

    def create_user(self, email: str) -> str:
        self.calls.append(email)
        if self.error:
            raise self.error
        return self.result


@pytest.fixture
def fake_pool(monkeypatch):
    fp = FakePool()
    monkeypatch.setattr(rbac.pool, "create_user", fp.create_user)
    return fp


def _invite(email="invitee@chryselys.com", **kw):
    return rbac.invite_user(
        actor="boss@chryselys.com", actor_role="superadmin", email=email, **kw
    )


def test_invite_creates_the_pool_user(fake_pool, exec_sql):
    """The regression. A users row alone is not an invite."""
    uid = _invite()
    assert uid
    assert fake_pool.calls == ["invitee@chryselys.com"], (
        "invite_user did not create a Cognito pool user, so the invited "
        "person cannot receive a login code"
    )


def test_the_email_is_normalised_before_the_pool_sees_it(fake_pool, exec_sql):
    """Cognito usernames are case-sensitive; grants key off the lowercased form."""
    _invite(email="  Invitee@Chryselys.COM ")
    assert fake_pool.calls == ["invitee@chryselys.com"]


def test_a_rejected_domain_never_reaches_the_pool(fake_pool, exec_sql):
    with pytest.raises(rbac.InvalidEmail):
        _invite(email="someone@gmail.com")
    assert fake_pool.calls == []


def test_a_pool_failure_rolls_the_users_row_back(monkeypatch, exec_sql):
    """Neither half, so the invite can be retried as-is.

    The alternative -- commit the row, report the pool failure -- leaves
    exactly the state this whole change exists to remove: a user who
    looks invited and cannot log in.
    """
    fp = FakePool(error=pool.PoolError("cognito said no"))
    monkeypatch.setattr(rbac.pool, "create_user", fp.create_user)

    with pytest.raises(pool.PoolError):
        _invite(email="rollback@chryselys.com")

    assert exec_sql(
        "SELECT id FROM users WHERE email = 'rollback@chryselys.com'"
    ) is None, "the users row survived a failed pool write"


def test_reinviting_is_not_an_error(fake_pool, exec_sql):
    """Both halves are idempotent, which is what makes a retry safe."""
    first = _invite()
    fake_pool.result = "exists"
    second = _invite()
    assert first == second


def test_the_audit_row_records_what_the_pool_did(fake_pool, exec_sql):
    _invite()
    row = exec_sql(
        """
        SELECT after->>'pool' AS pool
        FROM audit_log
        WHERE action = 'user.invite'
        ORDER BY at DESC LIMIT 1
        """
    )
    assert row is not None and row["pool"] == "created"


# ------------------------------------------------- the adapter itself

def test_no_pool_configured_is_a_skip_not_a_crash(monkeypatch):
    """Local development and this suite have no Cognito at all."""
    monkeypatch.setattr(pool, "pool_configured", lambda: False)
    assert pool.create_user("someone@chryselys.com") == "skipped"
