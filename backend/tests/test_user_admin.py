"""Removing a user, and changing a user's role.

Neither existed. There was no route to delete a user at all, and the only
way to create a superadmin was `bootstrap-admin` on the laptop holding
the Terraform state -- so in practice the role was unchangeable and a
departing colleague kept a working login.

THE REFUSALS GET MORE TESTS THAN THE HAPPY PATHS, deliberately. A delete
that works is easy; what makes these routes safe to put on a screen is
that they refuse to leave the product with no administrator, and refuse
to let someone revoke their own authority by misclicking their own row.

The caller is a dependency override (`as_superadmin`), so the principal
is independent of the `users` table. That is what makes the
last-superadmin guard testable through the route: in a real deployment
the self-guard almost always fires first, because the caller IS a live
superadmin row and therefore the count is never 1.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from costhub.rbac import admin as rbac
from costhub.rbac import users

CALLER = "root@costhub.test"  # matches the as_superadmin fixture


@pytest.fixture
def fake_cognito(monkeypatch):
    """Record pool calls, and optionally fail like Cognito does.

    Every test in this file runs without a Cognito pool, so the real
    adapter would return "skipped" and the question "was the login
    disabled?" would be unobservable -- which is how the missing pool
    write in `invite_user` stayed invisible for so long.
    """

    class Fake:
        def __init__(self):
            self.disabled: list[str] = []
            self.created: list[str] = []
            self.error: Exception | None = None
            self.result = "disabled"

        def disable_user(self, email: str) -> str:
            self.disabled.append(email)
            if self.error:
                raise self.error
            return self.result

        def create_user(self, email: str) -> str:
            self.created.append(email)
            return "re-enabled"

    fake = Fake()
    monkeypatch.setattr(users.pool, "disable_user", fake.disable_user)
    monkeypatch.setattr(rbac.pool, "create_user", fake.create_user)
    return fake


def _audit(exec_sql, action: str) -> dict | None:
    return exec_sql(
        """
        SELECT actor, entity_id, before, after FROM audit_log
         WHERE action = %(a)s ORDER BY at DESC LIMIT 1
        """,
        {"a": action},
    )


# --------------------------------------------------------- removing a user

def test_removing_a_user_soft_deletes_them(as_superadmin, make_user, exec_sql, fake_cognito):
    make_user(CALLER, "superadmin")
    uid = make_user("leaver@chryselys.com")

    response = as_superadmin.delete(f"/admin/users/{uid}")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["deleted"] is True
    assert body["login_disabled"] is True

    row = exec_sql(
        "SELECT deleted_at, deleted_by, status FROM users WHERE id = %(i)s",
        {"i": uid},
    )
    assert row["deleted_at"] is not None, "the row was not soft-deleted"
    assert row["deleted_by"] == CALLER
    assert row["status"] == "disabled"


def test_a_removed_user_disappears_from_the_list(as_superadmin, make_user, fake_cognito):
    make_user(CALLER, "superadmin")
    uid = make_user("leaver@chryselys.com")

    as_superadmin.delete(f"/admin/users/{uid}")

    emails = [u["email"] for u in as_superadmin.get("/admin/users").json()["data"]]
    assert "leaver@chryselys.com" not in emails


def test_a_removed_user_is_refused_by_the_api(as_superadmin, make_user, fake_cognito):
    """The consequence that matters, and it does not depend on Cognito.

    `deps._load_user` requires `deleted_at IS NULL`, so a removed user
    with a still-valid token reaches nothing. Without this the removal
    would be cosmetic until their ID token expired.
    """
    from costhub.api import deps

    make_user(CALLER, "superadmin")
    uid = make_user("leaver@chryselys.com")

    assert deps._load_user("leaver@chryselys.com").email == "leaver@chryselys.com"

    as_superadmin.delete(f"/admin/users/{uid}")

    with pytest.raises(HTTPException) as caught:
        deps._load_user("leaver@chryselys.com")
    assert caught.value.status_code == 403


def test_removal_disables_the_cognito_login(as_superadmin, make_user, fake_cognito):
    """Otherwise they keep a working sign-in after being removed."""
    make_user(CALLER, "superadmin")
    uid = make_user("leaver@chryselys.com")

    as_superadmin.delete(f"/admin/users/{uid}")

    assert fake_cognito.disabled == ["leaver@chryselys.com"], (
        "the pool user was not disabled, so the removed person can still "
        "receive a login code"
    )


def test_a_cognito_failure_still_removes_them_and_says_so(
    as_superadmin, make_user, exec_sql, fake_cognito
):
    """The removal must not be blocked by a side system.

    The database stamp is what denies access, so it is allowed to land
    with the login half reported as failed -- reported, not swallowed,
    because an enabled pool user for someone who has left is worth
    fixing.
    """
    from costhub.rbac import pool

    make_user(CALLER, "superadmin")
    uid = make_user("leaver@chryselys.com")
    fake_cognito.error = pool.PoolError("cognito is down")

    body = as_superadmin.delete(f"/admin/users/{uid}").json()
    assert body["deleted"] is True
    assert body["login_disabled"] is False
    assert "cognito is down" in body["login_detail"]

    row = exec_sql("SELECT deleted_at FROM users WHERE id = %(i)s", {"i": uid})
    assert row["deleted_at"] is not None


def test_a_credentials_error_does_not_roll_the_removal_back(
    as_superadmin, make_user, exec_sql, fake_cognito
):
    """The failure mode that is likelier than a Cognito outage.

    botocore raises NoCredentialsError and NoRegionError before any
    request is sent, so they are not ClientErrors and `disable_user`
    never converts them. Caught narrowly, they escaped the open
    transaction and rolled the removal back -- refusing a security
    operation because a side system could not be reached.
    """
    make_user(CALLER, "superadmin")
    uid = make_user("leaver@chryselys.com")
    fake_cognito.error = RuntimeError("Unable to locate credentials")

    body = as_superadmin.delete(f"/admin/users/{uid}").json()
    assert body["deleted"] is True
    assert body["login_disabled"] is False
    assert "Unable to locate credentials" in body["login_detail"]

    row = exec_sql("SELECT deleted_at FROM users WHERE id = %(i)s", {"i": uid})
    assert row["deleted_at"] is not None, "the removal was rolled back"


def test_removal_keeps_the_grants(as_superadmin, make_user, make_grant, exec_sql, fake_cognito):
    """The question "what could they see before they left" stays answerable."""
    make_user(CALLER, "superadmin")
    uid = make_user("leaver@chryselys.com")
    gid = make_grant(uid, account_id="111111111111")

    assert as_superadmin.delete(f"/admin/users/{uid}").json()["grants_kept"] is True

    row = exec_sql(
        "SELECT revoked_at, deleted_at FROM access_grants WHERE id = %(i)s",
        {"i": gid},
    )
    assert row["revoked_at"] is None and row["deleted_at"] is None


def test_removal_is_audited(as_superadmin, make_user, exec_sql, fake_cognito):
    make_user(CALLER, "superadmin")
    uid = make_user("leaver@chryselys.com")

    as_superadmin.delete(f"/admin/users/{uid}")

    entry = _audit(exec_sql, "user.remove")
    assert entry is not None, "removing a user wrote no audit row"
    assert entry["actor"] == CALLER
    assert entry["entity_id"] == uid
    assert entry["before"]["email"] == "leaver@chryselys.com"
    assert entry["after"] == {
        "deleted": True,
        "grants_kept": True,
        "login": "disabled",
    }


def test_a_superadmin_cannot_remove_themselves(as_superadmin, make_user, exec_sql, fake_cognito):
    """A misclick on your own row would end your own authority."""
    uid = make_user(CALLER, "superadmin")
    make_user("other@chryselys.com", "superadmin")  # so the last-one guard is not what fires

    response = as_superadmin.delete(f"/admin/users/{uid}")
    assert response.status_code == 409, response.text
    assert "your own account" in response.json()["detail"]

    row = exec_sql("SELECT deleted_at FROM users WHERE id = %(i)s", {"i": uid})
    assert row["deleted_at"] is None
    assert fake_cognito.disabled == [], "a refused removal still called Cognito"


def test_the_last_superadmin_cannot_be_removed(as_superadmin, make_user, exec_sql, fake_cognito):
    uid = make_user("solo@chryselys.com", "superadmin")

    response = as_superadmin.delete(f"/admin/users/{uid}")
    assert response.status_code == 409, response.text
    assert "only superadmin" in response.json()["detail"]

    row = exec_sql("SELECT deleted_at FROM users WHERE id = %(i)s", {"i": uid})
    assert row["deleted_at"] is None


def test_a_second_superadmin_can_be_removed(as_superadmin, make_user, fake_cognito):
    """Guard the guard: the rule is "never zero", not "never a superadmin"."""
    make_user("first@chryselys.com", "superadmin")
    uid = make_user("second@chryselys.com", "superadmin")

    assert as_superadmin.delete(f"/admin/users/{uid}").status_code == 200


def test_removing_an_unknown_user_is_404(as_superadmin, fake_cognito):
    missing = "00000000-0000-0000-0000-0000000000ff"
    assert as_superadmin.delete(f"/admin/users/{missing}").status_code == 404


def test_removing_twice_is_404_the_second_time(as_superadmin, make_user, fake_cognito):
    make_user(CALLER, "superadmin")
    uid = make_user("leaver@chryselys.com")

    assert as_superadmin.delete(f"/admin/users/{uid}").status_code == 200
    assert as_superadmin.delete(f"/admin/users/{uid}").status_code == 404


def test_a_malformed_id_is_422_not_500(as_superadmin, fake_cognito):
    """It used to reach Postgres and come back as a bare 500."""
    assert as_superadmin.delete("/admin/users/not-a-uuid").status_code == 422


def test_a_plain_user_cannot_remove_anyone(as_plain_user, make_user, exec_sql, fake_cognito):
    uid = make_user("leaver@chryselys.com")

    assert as_plain_user.delete(f"/admin/users/{uid}").status_code == 403

    row = exec_sql("SELECT deleted_at FROM users WHERE id = %(i)s", {"i": uid})
    assert row["deleted_at"] is None


def test_a_removed_user_can_be_invited_back(as_superadmin, make_user, exec_sql, fake_cognito):
    """Removal must not be a one-way door.

    The invite upsert found the soft-deleted row, reported success and
    left `deleted_at` stamped, so the person was permanently unreachable
    -- an invite that cannot produce a usable login.
    """
    make_user(CALLER, "superadmin")
    uid = make_user("returner@chryselys.com")
    as_superadmin.delete(f"/admin/users/{uid}")

    again = as_superadmin.post(
        "/admin/users", json={"email": "returner@chryselys.com"}
    )
    assert again.status_code == 201, again.text
    assert again.json()["id"] == uid, "a second row was created instead of a revive"

    row = exec_sql(
        "SELECT deleted_at, deleted_by, status FROM users WHERE id = %(i)s",
        {"i": uid},
    )
    assert row["deleted_at"] is None and row["deleted_by"] is None
    assert row["status"] == "invited"
    assert fake_cognito.created == ["returner@chryselys.com"]


def test_re_inviting_a_live_user_does_not_reset_their_status(
    as_superadmin, make_user, exec_sql, fake_cognito
):
    """The revive is scoped to rows that were actually deleted."""
    make_user(CALLER, "superadmin")
    uid = make_user("active@chryselys.com")  # the fixture makes them 'active'

    as_superadmin.post("/admin/users", json={"email": "active@chryselys.com"})

    row = exec_sql("SELECT status FROM users WHERE id = %(i)s", {"i": uid})
    assert row["status"] == "active"


# ------------------------------------------------------- changing the role

def test_a_user_can_be_promoted(as_superadmin, make_user, exec_sql):
    make_user(CALLER, "superadmin")
    uid = make_user("rising@chryselys.com")

    response = as_superadmin.post(f"/admin/users/{uid}/role", json={"role": "superadmin"})
    assert response.status_code == 200, response.text
    assert response.json() == {
        "id": uid,
        "email": "rising@chryselys.com",
        "role": "superadmin",
        "changed": True,
    }

    row = exec_sql("SELECT role FROM users WHERE id = %(i)s", {"i": uid})
    assert row["role"] == "superadmin"


def test_promotion_does_not_touch_the_status(as_superadmin, exec_sql):
    """An invited user who is promoted has still never signed in."""
    uid = str(
        exec_sql(
            """
            INSERT INTO users (email, role, status, created_by, updated_by)
            VALUES ('pending@chryselys.com', 'user', 'invited', 'x', 'x')
            RETURNING id
            """
        )["id"]
    )

    as_superadmin.post(f"/admin/users/{uid}/role", json={"role": "superadmin"})

    assert exec_sql("SELECT status FROM users WHERE id = %(i)s", {"i": uid})["status"] == "invited"


def test_a_superadmin_can_be_demoted(as_superadmin, make_user, exec_sql):
    make_user("keeper@chryselys.com", "superadmin")
    uid = make_user("falling@chryselys.com", "superadmin")

    response = as_superadmin.post(f"/admin/users/{uid}/role", json={"role": "user"})
    assert response.status_code == 200, response.text

    assert exec_sql("SELECT role FROM users WHERE id = %(i)s", {"i": uid})["role"] == "user"


def test_a_role_change_is_audited(as_superadmin, make_user, exec_sql):
    make_user(CALLER, "superadmin")
    uid = make_user("rising@chryselys.com")

    as_superadmin.post(f"/admin/users/{uid}/role", json={"role": "superadmin"})

    entry = _audit(exec_sql, "user.role")
    assert entry is not None, "a role change wrote no audit row"
    assert entry["actor"] == CALLER
    assert entry["before"] == {"email": "rising@chryselys.com", "role": "user"}
    assert entry["after"] == {"role": "superadmin"}


def test_setting_the_same_role_changes_nothing_and_is_not_audited(
    as_superadmin, make_user, exec_sql
):
    make_user(CALLER, "superadmin")
    uid = make_user("steady@chryselys.com")

    body = as_superadmin.post(f"/admin/users/{uid}/role", json={"role": "user"}).json()
    assert body["changed"] is False
    assert _audit(exec_sql, "user.role") is None


def test_a_superadmin_cannot_demote_themselves(as_superadmin, make_user, exec_sql):
    uid = make_user(CALLER, "superadmin")
    make_user("other@chryselys.com", "superadmin")

    response = as_superadmin.post(f"/admin/users/{uid}/role", json={"role": "user"})
    assert response.status_code == 409, response.text
    assert "your own superadmin role" in response.json()["detail"]

    assert exec_sql("SELECT role FROM users WHERE id = %(i)s", {"i": uid})["role"] == "superadmin"


def test_the_last_superadmin_cannot_be_demoted(as_superadmin, make_user, exec_sql):
    uid = make_user("solo@chryselys.com", "superadmin")

    response = as_superadmin.post(f"/admin/users/{uid}/role", json={"role": "user"})
    assert response.status_code == 409, response.text
    assert "only superadmin" in response.json()["detail"]

    assert exec_sql("SELECT role FROM users WHERE id = %(i)s", {"i": uid})["role"] == "superadmin"


def test_promotion_is_never_refused_for_being_the_last_one(as_superadmin, make_user):
    """Guard the guard: the count rules apply to demotion only."""
    make_user("solo@chryselys.com", "superadmin")
    uid = make_user("rising@chryselys.com")

    assert as_superadmin.post(
        f"/admin/users/{uid}/role", json={"role": "superadmin"}
    ).status_code == 200


def test_an_unknown_role_is_422(as_superadmin, make_user):
    uid = make_user("someone@chryselys.com")
    assert as_superadmin.post(f"/admin/users/{uid}/role", json={"role": "root"}).status_code == 422


def test_changing_the_role_of_an_unknown_user_is_404(as_superadmin):
    missing = "00000000-0000-0000-0000-0000000000ff"
    assert as_superadmin.post(
        f"/admin/users/{missing}/role", json={"role": "superadmin"}
    ).status_code == 404


def test_a_removed_user_has_no_role_to_change(as_superadmin, make_user, fake_cognito):
    """`TARGET` filters on deleted_at, so a stale screen gets a 404."""
    make_user(CALLER, "superadmin")
    uid = make_user("leaver@chryselys.com")
    as_superadmin.delete(f"/admin/users/{uid}")

    assert as_superadmin.post(
        f"/admin/users/{uid}/role", json={"role": "superadmin"}
    ).status_code == 404


def test_a_plain_user_cannot_change_a_role(as_plain_user, make_user, exec_sql):
    uid = make_user("someone@chryselys.com")

    assert as_plain_user.post(
        f"/admin/users/{uid}/role", json={"role": "superadmin"}
    ).status_code == 403

    assert exec_sql("SELECT role FROM users WHERE id = %(i)s", {"i": uid})["role"] == "user"
