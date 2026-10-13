"""The request and response contract the browser is coded against.

The "add a cloud account" dialog builds its POST body in
`frontend/src/lib/aws-onboarding.ts:registrationBody`. Nothing checks
that the body it produces is the body this API accepts -- the two live
in different languages, in different trees, and a field rename on either
side fails only in a browser, at the moment someone tries to register an
account in front of their devops team.

So these tests send the EXACT shape the frontend sends and assert on the
three things the UI relies on:

  * an assume_role registration is accepted and stores the role ARN,
  * the ExternalId never comes back out, and
  * a non-superadmin is refused, which is what the dialog's 403 branch
    renders a sentence for.
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from costhub.api import deps
from costhub.api.main import app
from costhub.db import fetch_all
from costhub.query.scoped import Principal

SUPERADMIN = Principal(user_id="00000000-0000-0000-0000-000000000001",
                       email="root@costhub.test", role="superadmin")
PLAIN = Principal(user_id="00000000-0000-0000-0000-000000000002",
                  email="user@costhub.test", role="user")

# What `registrationBody()` emits for the cross-account case. Keep this
# literal -- deriving it would stop it being a check on the contract.
FRONTEND_BODY = {
    "provider": "aws",
    "account_id": "123456789012",
    "display_name": "Finance-AWS",
    "credential_mode": "assume_role",
    "role_arn": "arn:aws:iam::123456789012:role/CostHubCostReader",
    "external_id": "1655b563-c910-47bc-bf30-d3c902db4f15",
}

# ...and for the deploy account, where both credential fields are null.
FRONTEND_BODY_SELF = {
    "provider": "aws",
    "account_id": "self",
    "display_name": "Hemanth-AWS",
    "credential_mode": "self",
    "role_arn": None,
    "external_id": None,
}


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def as_superadmin(client):
    app.dependency_overrides[deps.principal] = lambda: SUPERADMIN
    yield client
    app.dependency_overrides.clear()


@pytest.fixture
def as_plain_user(client):
    app.dependency_overrides[deps.principal] = lambda: PLAIN
    yield client
    app.dependency_overrides.clear()


def test_the_body_the_dialog_sends_is_accepted(as_superadmin):
    response = as_superadmin.post("/admin/connections", json=FRONTEND_BODY)
    assert response.status_code == 201, response.text
    assert response.json()["id"]

    row = fetch_all(
        "SELECT * FROM cloud_connections WHERE account_id = '123456789012'"
    )[0]
    assert row["credential_mode"] == "assume_role"
    assert row["role_arn"] == FRONTEND_BODY["role_arn"]
    assert row["external_id"] == FRONTEND_BODY["external_id"]
    assert row["enabled"] is True


def test_the_self_body_is_accepted_with_null_credentials(as_superadmin):
    response = as_superadmin.post("/admin/connections", json=FRONTEND_BODY_SELF)
    assert response.status_code == 201, response.text
    row = fetch_all("SELECT * FROM cloud_connections WHERE account_id = 'self'")[0]
    assert row["credential_mode"] == "self"
    assert row["role_arn"] is None


def test_the_external_id_never_comes_back(as_superadmin):
    as_superadmin.post("/admin/connections", json=FRONTEND_BODY)
    body = as_superadmin.get("/admin/connections").json()

    row = next(r for r in body["data"] if r["account_id"] == "123456789012")
    # The dialog states, on screen, that this is the only place the
    # value is ever shown. That promise is only true if the API keeps
    # redacting -- so assert the marker AND the absence of the value.
    assert row["external_id"] == "set"
    assert FRONTEND_BODY["external_id"] not in json.dumps(body)


def test_a_second_post_to_the_same_account_id_updates_rather_than_fails(as_superadmin):
    """The dialog warns about this, because the API cannot: `store.upsert`
    is ON CONFLICT DO UPDATE, so a duplicate is a silent replace that
    still answers 201."""
    first = as_superadmin.post("/admin/connections", json=FRONTEND_BODY).json()["id"]
    changed = {**FRONTEND_BODY, "display_name": "Renamed", "external_id": "second"}
    second = as_superadmin.post("/admin/connections", json=changed).json()["id"]

    assert first == second, "same row, not a new one"
    rows = fetch_all("SELECT * FROM cloud_connections WHERE account_id = '123456789012'")
    assert len(rows) == 1
    assert rows[0]["display_name"] == "Renamed"
    assert rows[0]["external_id"] == "second", "the old trust policy is now dead"


def test_a_non_superadmin_is_refused(as_plain_user):
    refused = as_plain_user.post("/admin/connections", json=FRONTEND_BODY)
    assert refused.status_code == 403
    assert as_plain_user.get("/admin/connections").status_code == 403
    assert as_plain_user.get("/admin/ingest-runs").status_code == 403
    assert fetch_all("SELECT 1 FROM cloud_connections") == [], "nothing was written"


def test_enabled_toggle_round_trips(as_superadmin):
    cid = as_superadmin.post("/admin/connections", json=FRONTEND_BODY).json()["id"]

    off = as_superadmin.post(f"/admin/connections/{cid}/enabled", params={"value": False})
    assert off.status_code == 200
    rows = as_superadmin.get("/admin/connections").json()["data"]
    assert next(r for r in rows if r["id"] == cid)["enabled"] is False

    as_superadmin.post(f"/admin/connections/{cid}/enabled", params={"value": True})
    rows = as_superadmin.get("/admin/connections").json()["data"]
    assert next(r for r in rows if r["id"] == cid)["enabled"] is True


def test_ingest_runs_is_reachable_and_shaped_as_the_screen_expects(as_superadmin):
    body = as_superadmin.get("/admin/ingest-runs").json()
    assert "data" in body and isinstance(body["data"], list)
