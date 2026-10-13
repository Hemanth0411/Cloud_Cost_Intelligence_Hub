"""The key must not come back out. Asserted by looking for it.

This is the only feature in the project where the request body contains
something that must never appear in a response, a log line, the
database, or the audit trail. Testing each of those individually is how
you end up covering three of the four, so most of the tests below take
the SAME approach instead: do the thing, then search everything the
request touched for the literal key material.

`_nowhere` is that search. It reads the response body, the whole
`cloud_connections` row and every `audit_log` row as text and asserts
the secret appears in none of them. A test written that way keeps
working when somebody adds a column or an audit field, which a test
asserting on named keys does not.

Secrets Manager is faked. These tests are about what this code does with
a credential, and a real `create_secret` would both cost money and leave
one behind.
"""
from __future__ import annotations

import json

import pytest
from botocore.exceptions import ClientError

from costhub.connections import key_store
from costhub.db import fetch_all

# Deliberately shaped like real credentials, and deliberately not real.
# The id passes `ACCESS_KEY_ID_RE`; the secret is 40 characters.
KEY_ID = "AKIAIOSFODNN7EXAMPLE"
KEY_SECRET = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY123"

ACCOUNT = "881953306582"
ARN = (
    "arn:aws:secretsmanager:us-east-1:997916278551:secret:"
    "costhub/dev/connections/aws-881953306582-aB3dEf"
)

BODY = {
    "provider": "aws",
    "account_id": ACCOUNT,
    "display_name": "Chryselys-Office",
    "credential_mode": "secret",
    "access_key_id": KEY_ID,
    "secret_access_key": KEY_SECRET,
}


class FakeSecrets:
    """Just enough Secrets Manager, with every call recorded."""

    def __init__(self, *, exists: bool = False, fail: str | None = None):
        self.exists = exists
        self.fail = fail
        self.calls: list[tuple[str, dict]] = []
        self.stored: str | None = None

    def _maybe_fail(self, op: str):
        if self.fail:
            raise ClientError({"Error": {"Code": self.fail, "Message": self.fail}}, op)

    def create_secret(self, **kw):
        self.calls.append(("create_secret", kw))
        self._maybe_fail("CreateSecret")
        if self.exists:
            raise ClientError(
                {"Error": {"Code": "ResourceExistsException", "Message": "exists"}},
                "CreateSecret",
            )
        self.stored = kw["SecretString"]
        return {"ARN": ARN}

    def put_secret_value(self, **kw):
        self.calls.append(("put_secret_value", kw))
        self._maybe_fail("PutSecretValue")
        self.stored = kw["SecretString"]
        return {"ARN": ARN}

    def get_secret_value(self, **kw):
        self.calls.append(("get_secret_value", kw))
        self._maybe_fail("GetSecretValue")
        return {"SecretString": self.stored or "{}"}

    def delete_secret(self, **kw):
        self.calls.append(("delete_secret", kw))
        self._maybe_fail("DeleteSecret")
        return {"ARN": ARN}

    def ops(self) -> list[str]:
        return [name for name, _ in self.calls]

    def last(self, op: str) -> dict:
        for name, kw in reversed(self.calls):
            if name == op:
                return kw
        raise AssertionError(f"{op} was never called (saw {self.ops()})")


@pytest.fixture
def secrets(monkeypatch):
    """Fake Secrets Manager, and settings that make the ARN above ours."""
    fake = FakeSecrets()
    monkeypatch.setattr(key_store, "_client", lambda: fake)
    # `owned()` and `secret_name()` are both built from app_env, and the
    # ARN these tests use says `dev`. The .env in this repo already sets
    # APP_ENV=dev, but a test that depends on a developer's .env is a
    # test that fails on someone else's machine.
    monkeypatch.setattr(key_store, "owned_prefix", lambda: "costhub/dev/connections/")
    monkeypatch.setattr(
        key_store,
        "secret_name",
        lambda provider, account_id: f"costhub/dev/connections/{provider}-{account_id}",
    )
    return fake


def _audit_text() -> str:
    rows = fetch_all("SELECT action, before, after FROM audit_log ORDER BY id")
    return json.dumps(rows, default=str)


def _connection_text(connection_id: str) -> str:
    rows = fetch_all(
        "SELECT * FROM cloud_connections WHERE id = %(id)s", {"id": connection_id}
    )
    return json.dumps(rows, default=str)


def _nowhere(*texts: str) -> None:
    """The key material appears in none of these. The core assertion."""
    for text in texts:
        assert KEY_SECRET not in text, f"the secret access key leaked into: {text}"
        assert KEY_ID not in text, f"the access key id leaked into: {text}"


# ------------------------------------------------------------- the write


def test_registering_with_a_key_stores_only_the_arn(as_superadmin, secrets):
    response = as_superadmin.post("/admin/connections", json=BODY)
    assert response.status_code == 201, response.text

    cid = response.json()["id"]
    assert response.json()["credential_stored"] is True

    rows = fetch_all(
        "SELECT secret_arn, credential_mode FROM cloud_connections WHERE id = %(id)s",
        {"id": cid},
    )
    assert rows[0]["secret_arn"] == ARN
    assert rows[0]["credential_mode"] == "secret"

    # The one that matters, over everything the request touched.
    _nowhere(response.text, _connection_text(cid), _audit_text())

    # And it really was written, with both halves, under our own name.
    assert secrets.ops() == ["create_secret"]
    sent = json.loads(secrets.last("create_secret")["SecretString"])
    assert sent == {
        key_store.ACCESS_KEY_ID: KEY_ID,
        key_store.SECRET_ACCESS_KEY: KEY_SECRET,
    }
    assert secrets.last("create_secret")["Name"] == (
        f"costhub/dev/connections/aws-{ACCOUNT}"
    )


def test_the_secret_is_tagged_so_a_teardown_sweep_can_see_it(as_superadmin, secrets):
    """`./do.sh sweep` finds resources by tag, and destroy misses this."""
    as_superadmin.post("/admin/connections", json=BODY)
    tags = {t["Key"]: t["Value"] for t in secrets.last("create_secret")["Tags"]}
    assert tags["Project"] == "costhub"
    assert tags["Environment"] == "dev"


def test_the_audit_row_records_that_a_secret_was_set_not_what_it_was(
    as_superadmin, secrets
):
    response = as_superadmin.post("/admin/connections", json=BODY)
    cid = response.json()["id"]

    rows = fetch_all(
        """
        SELECT action, after FROM audit_log
         WHERE entity_id = %(id)s AND action = 'connection.credential_set'
        """,
        {"id": cid},
    )
    assert len(rows) == 1
    assert rows[0]["after"]["secret_set"] is True
    assert rows[0]["after"]["rotated"] is False
    _nowhere(json.dumps(rows, default=str))

    # And the create row carries the boolean too, alongside external_id_set.
    created = fetch_all(
        """
        SELECT after FROM audit_log
         WHERE entity_id = %(id)s AND action = 'connection.create'
        """,
        {"id": cid},
    )
    assert created[0]["after"]["secret_arn_set"] is True


def test_a_second_registration_rotates_rather_than_orphaning(as_superadmin, secrets):
    """One name per account, so the previous key stops existing."""
    as_superadmin.post("/admin/connections", json=BODY)
    secrets.exists = True  # as Secrets Manager now answers for that name

    response = as_superadmin.post("/admin/connections", json=BODY)
    assert response.status_code == 201, response.text
    assert secrets.ops() == ["create_secret", "create_secret", "put_secret_value"]
    _nowhere(response.text)


# ------------------------------------------------------------- refusals


def test_half_a_pair_is_refused_and_nothing_is_stored(as_superadmin, secrets):
    response = as_superadmin.post(
        "/admin/connections", json={**BODY, "secret_access_key": None}
    )
    assert response.status_code == 400, response.text
    assert "both halves" in response.json()["detail"]
    assert secrets.ops() == []
    assert fetch_all("SELECT id FROM cloud_connections") == []


def test_a_key_for_a_mode_that_would_never_read_it_is_refused(as_superadmin, secrets):
    """Storing it would be a live credential with nothing on screen."""
    response = as_superadmin.post(
        "/admin/connections", json={**BODY, "credential_mode": "assume_role",
                                    "role_arn": f"arn:aws:iam::{ACCOUNT}:role/X"}
    )
    assert response.status_code == 400, response.text
    assert "'secret'" in response.json()["detail"]
    assert secrets.ops() == []
    _nowhere(response.text)


def test_a_malformed_access_key_id_is_refused_without_echoing_it(
    as_superadmin, secrets
):
    response = as_superadmin.post(
        "/admin/connections",
        json={**BODY, "access_key_id": "arn:aws:iam::1:user/nope"},
    )
    assert response.status_code == 400, response.text
    assert "access key id" in response.json()["detail"]
    assert "arn:aws:iam" not in response.text
    assert secrets.ops() == []


def test_secret_mode_with_no_credential_at_all_is_refused(as_superadmin, secrets):
    """A row that could only ever fail at credential resolution."""
    bare = {k: v for k, v in BODY.items()
            if k not in ("access_key_id", "secret_access_key")}
    response = as_superadmin.post("/admin/connections", json=bare)
    assert response.status_code == 400, response.text
    assert "secret_arn" in response.json()["detail"]
    assert fetch_all("SELECT id FROM cloud_connections") == []


def test_a_validation_error_does_not_echo_the_key_back(as_superadmin, secrets):
    """The leak that exists by default, and is closed in api/main.py.

    pydantic reports a `missing` error with the whole parent object as
    its `input`, and FastAPI's built-in handler returns `errors()`
    verbatim -- so this request answered 422 with the access key in the
    response body, before any route ran.
    """
    no_name = {k: v for k, v in BODY.items() if k != "display_name"}
    response = as_superadmin.post("/admin/connections", json=no_name)
    assert response.status_code == 422, response.text
    # Still useful: it says which field is missing.
    assert "display_name" in response.text
    _nowhere(response.text)
    assert secrets.ops() == []


def test_a_non_superadmin_cannot_store_a_key(as_plain_user, secrets):
    response = as_plain_user.post("/admin/connections", json=BODY)
    assert response.status_code == 403
    assert secrets.ops() == []
    _nowhere(response.text)


# ------------------------------------------------------------- rotation


def test_rotating_a_key_keeps_the_arn_and_leaks_nothing(as_superadmin, secrets):
    cid = as_superadmin.post("/admin/connections", json=BODY).json()["id"]
    secrets.exists = True

    new_secret = "ROTATEDrotatedROTATEDrotated1234567890ab"
    response = as_superadmin.patch(
        f"/admin/connections/{cid}",
        json={"access_key_id": KEY_ID, "secret_access_key": new_secret},
    )
    assert response.status_code == 200, response.text
    assert response.json()["credential_stored"] is True
    assert "put_secret_value" in secrets.ops()

    rows = fetch_all(
        "SELECT secret_arn FROM cloud_connections WHERE id = %(id)s", {"id": cid}
    )
    assert rows[0]["secret_arn"] == ARN
    assert new_secret not in response.text
    assert new_secret not in _connection_text(cid)
    assert new_secret not in _audit_text()

    rotated = fetch_all(
        """
        SELECT after FROM audit_log
         WHERE entity_id = %(id)s AND action = 'connection.credential_set'
         ORDER BY id DESC LIMIT 1
        """,
        {"id": cid},
    )
    assert rotated[0]["after"]["rotated"] is True


def test_a_patch_carrying_only_a_key_is_not_nothing_to_change(as_superadmin, secrets):
    """`changes` is empty once the two non-columns are popped off."""
    cid = as_superadmin.post("/admin/connections", json=BODY).json()["id"]
    secrets.exists = True
    response = as_superadmin.patch(
        f"/admin/connections/{cid}",
        json={"access_key_id": KEY_ID, "secret_access_key": KEY_SECRET},
    )
    assert response.status_code == 200, response.text
    assert response.json()["changed"] == ["secret_arn"]


def test_leaving_secret_mode_deletes_the_key_it_stops_reading(as_superadmin, secrets):
    cid = as_superadmin.post("/admin/connections", json=BODY).json()["id"]

    response = as_superadmin.patch(
        f"/admin/connections/{cid}",
        json={
            "credential_mode": "assume_role",
            "role_arn": f"arn:aws:iam::{ACCOUNT}:role/CostHubCostReader",
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["credential_removed"] is True
    assert "delete_secret" in secrets.ops()

    rows = fetch_all(
        "SELECT secret_arn FROM cloud_connections WHERE id = %(id)s", {"id": cid}
    )
    assert rows[0]["secret_arn"] is None


def test_switching_into_secret_mode_with_no_key_is_refused(as_superadmin, secrets):
    """The mirror of the POST rule, and the edit dialog warns about it."""
    body = {
        "provider": "aws",
        "account_id": "123456789012",
        "display_name": "Finance-AWS",
        "credential_mode": "assume_role",
        "role_arn": "arn:aws:iam::123456789012:role/CostHubCostReader",
    }
    cid = as_superadmin.post("/admin/connections", json=body).json()["id"]

    response = as_superadmin.patch(
        f"/admin/connections/{cid}", json={"credential_mode": "secret"}
    )
    assert response.status_code == 400, response.text
    assert "secret_arn" in response.json()["detail"]
    assert secrets.ops() == []

    rows = fetch_all(
        "SELECT credential_mode FROM cloud_connections WHERE id = %(id)s", {"id": cid}
    )
    assert rows[0]["credential_mode"] == "assume_role"


# ------------------------------------------------------------- deletion


def test_deleting_a_connection_deletes_its_stored_key(as_superadmin, secrets):
    cid = as_superadmin.post("/admin/connections", json=BODY).json()["id"]

    response = as_superadmin.delete(f"/admin/connections/{cid}")
    assert response.status_code == 200, response.text
    assert response.json()["credential_removed"] is True
    # Cost rows are still kept -- that part has not changed.
    assert response.json()["cost_data_kept"] is True

    sent = secrets.last("delete_secret")
    assert sent["SecretId"] == ARN
    # FORCED. A 30-day recovery window would make re-registering this
    # account fail, because the name is deterministic.
    assert sent["ForceDeleteWithoutRecovery"] is True

    audited = fetch_all(
        """
        SELECT after FROM audit_log
         WHERE entity_id = %(id)s AND action = 'connection.credential_deleted'
        """,
        {"id": cid},
    )
    assert audited[0]["after"]["secret_deleted"] is True


def test_a_failed_secret_deletion_is_reported_not_swallowed(as_superadmin, secrets):
    """The one outcome that must never look like success."""
    cid = as_superadmin.post("/admin/connections", json=BODY).json()["id"]
    secrets.fail = "AccessDeniedException"

    response = as_superadmin.delete(f"/admin/connections/{cid}")
    assert response.status_code == 200, response.text
    body = response.json()
    # The connection IS gone -- "stop importing" was honoured.
    assert body["deleted"] is True
    # ...but the credential is not, and the response says so.
    assert body["credential_removed"] is False
    assert "STILL LIVE" in body["detail"]

    audited = fetch_all(
        """
        SELECT after FROM audit_log
         WHERE entity_id = %(id)s AND action = 'connection.credential_deleted'
        """,
        {"id": cid},
    )
    assert audited[0]["after"]["secret_deleted"] is False


def test_deleting_a_connection_with_no_key_still_succeeds(as_superadmin, secrets):
    body = {
        "provider": "aws",
        "account_id": "123456789012",
        "display_name": "Finance-AWS",
        "credential_mode": "assume_role",
        "role_arn": "arn:aws:iam::123456789012:role/CostHubCostReader",
    }
    cid = as_superadmin.post("/admin/connections", json=body).json()["id"]
    response = as_superadmin.delete(f"/admin/connections/{cid}")
    assert response.status_code == 200, response.text
    assert response.json()["credential_removed"] is True
    assert secrets.ops() == []


def test_a_foreign_secret_arn_is_left_alone_and_said_so(as_superadmin, secrets):
    """An Azure service principal is not ours to force-delete."""
    foreign = (
        "arn:aws:secretsmanager:us-east-1:997916278551:secret:"
        "someone-elses/azure-sp-XyZ123"
    )
    cid = as_superadmin.post(
        "/admin/connections",
        json={
            "provider": "azure",
            "account_id": "00000000-0000-0000-0000-000000000001",
            "display_name": "Azure-Sub",
            "credential_mode": "secret",
            "secret_arn": foreign,
        },
    ).json()["id"]

    response = as_superadmin.delete(f"/admin/connections/{cid}")
    assert response.status_code == 200, response.text
    assert response.json()["credential_removed"] is False
    assert "managed elsewhere" in response.json()["detail"]
    assert secrets.ops() == []


# --------------------------------------------- the ownership gate itself


def test_owned_refuses_the_database_secret(monkeypatch):
    """One segment short of the wildcard, and it must stay that way."""
    monkeypatch.setattr(key_store, "owned_prefix", lambda: "costhub/dev/connections/")
    db_secret = (
        "arn:aws:secretsmanager:us-east-1:997916278551:secret:"
        "costhub/dev/database-url-AbCdEf"
    )
    assert key_store.owned(db_secret) is False
    assert key_store.owned(ARN) is True
    assert key_store.owned(None) is False
    assert key_store.owned("not-an-arn") is False
    # Another environment's connection secret is not this one's either.
    assert key_store.owned(ARN.replace("/dev/", "/staging/")) is False


def test_delete_refuses_anything_it_does_not_own(secrets, monkeypatch):
    with pytest.raises(key_store.SecretError, match="Refusing to delete"):
        key_store.delete_access_key(
            "arn:aws:secretsmanager:us-east-1:997916278551:secret:"
            "costhub/dev/database-url-AbCdEf"
        )
    assert secrets.ops() == []


# ------------------------------------------------- reading it back again


def test_the_ingest_builds_a_session_from_the_stored_pair(secrets, monkeypatch):
    """What `credential_mode = 'secret'` actually buys, end to end."""
    from costhub.connections.credentials import Connection, own_session

    secrets.stored = json.dumps(
        {
            key_store.ACCESS_KEY_ID: KEY_ID,
            key_store.SECRET_ACCESS_KEY: KEY_SECRET,
        }
    )
    conn = Connection(
        id="1",
        provider="aws",
        account_id=ACCOUNT,
        display_name="Chryselys-Office",
        credential_mode="secret",
        secret_arn=ARN,
    )
    session = own_session(conn)
    frozen = session.get_credentials().get_frozen_credentials()
    assert frozen.access_key == KEY_ID
    assert frozen.secret_key == KEY_SECRET
    # Static keys, so no session token -- this is not an STS result.
    assert frozen.token is None


def test_a_secret_connection_never_calls_sts(secrets, monkeypatch):
    """`aws_session` must not try to assume a role on top of a key."""
    from costhub.connections import credentials as mod

    secrets.stored = json.dumps(
        {key_store.ACCESS_KEY_ID: KEY_ID, key_store.SECRET_ACCESS_KEY: KEY_SECRET}
    )

    def explode(own, conn):
        raise AssertionError("assume_role was called for a secret connection")

    monkeypatch.setattr(mod, "assume_role", explode)
    conn = mod.Connection(
        id="1",
        provider="aws",
        account_id=ACCOUNT,
        display_name="Chryselys-Office",
        credential_mode="secret",
        secret_arn=ARN,
    )
    assert mod.aws_session(conn) is not None


def test_a_secret_connection_with_no_arn_fails_on_our_side(secrets):
    """Stage "credentials", so the probe blames this side and not theirs."""
    from costhub.connections.credentials import Connection, CredentialError, own_session

    conn = Connection(
        id="1",
        provider="aws",
        account_id=ACCOUNT,
        display_name="Chryselys-Office",
        credential_mode="secret",
    )
    with pytest.raises(CredentialError, match="secret_arn missing"):
        own_session(conn)


def test_an_unreadable_secret_is_a_credential_error_not_a_botocore_one(secrets):
    """Or the test endpoint answers 500 instead of naming the problem."""
    from costhub.connections.credentials import Connection, CredentialError, own_session

    secrets.fail = "AccessDeniedException"
    conn = Connection(
        id="1",
        provider="aws",
        account_id=ACCOUNT,
        display_name="Chryselys-Office",
        credential_mode="secret",
        secret_arn=ARN,
    )
    with pytest.raises(CredentialError, match="could not read the stored access key"):
        own_session(conn)


def test_a_secret_missing_a_field_names_the_field_and_not_the_value(secrets):
    secrets.stored = json.dumps({key_store.ACCESS_KEY_ID: KEY_ID})
    with pytest.raises(key_store.SecretError) as caught:
        key_store.read_access_key(ARN)
    assert "aws_secret_access_key" in str(caught.value)
    assert KEY_SECRET not in str(caught.value)


def test_a_key_stored_with_stray_whitespace_is_stripped_on_read(secrets):
    """A wrapped paste otherwise reads as "your credentials are wrong"."""
    secrets.stored = json.dumps(
        {
            key_store.ACCESS_KEY_ID: f"  {KEY_ID}\n",
            key_store.SECRET_ACCESS_KEY: f"{KEY_SECRET}\n",
        }
    )
    pair = key_store.read_access_key(ARN)
    assert pair[key_store.ACCESS_KEY_ID] == KEY_ID
    assert pair[key_store.SECRET_ACCESS_KEY] == KEY_SECRET
