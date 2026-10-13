"""Correcting and removing a connection.

Neither existed. A mistyped role ARN or a stale ExternalId meant
deleting the connection and registering it again -- and while the
ExternalId was redacted you could not even see that it was wrong. That
is not hypothetical: a handoff message went to another team carrying an
ExternalId that did not match the stored one.

The behaviour worth pinning is the difference between "set this to null"
and "do not touch this". Pydantic's `exclude_unset` is what separates
them, and without it every field a client omits arrives as None and
clears a column nobody mentioned -- which is how an edit form destroys
the credential it was not editing.
"""
from __future__ import annotations

from costhub.connections import edits, store
from costhub.db import fetch_all

BODY = {
    "provider": "aws",
    "account_id": "222233334444",
    "display_name": "Target",
    "credential_mode": "assume_role",
    "role_arn": "arn:aws:iam::222233334444:role/CostHubCostReader",
    "external_id": "ext-original",
}


def _create(client) -> str:
    return client.post("/admin/connections", json=BODY).json()["id"]


def _row(account_id: str = "222233334444") -> dict:
    rows = fetch_all(
        "SELECT * FROM cloud_connections WHERE account_id = %(a)s", {"a": account_id}
    )
    assert rows, "connection missing"
    return rows[0]


# ------------------------------------------------------------- editing

def test_patching_one_field_leaves_the_others_alone(as_superadmin):
    """The whole point. Renaming must not clear the credentials."""
    cid = _create(as_superadmin)

    response = as_superadmin.patch(
        f"/admin/connections/{cid}", json={"display_name": "Renamed"}
    )

    assert response.status_code == 200
    assert response.json()["changed"] == ["display_name"]
    row = _row()
    assert row["display_name"] == "Renamed"
    assert row["role_arn"] == BODY["role_arn"], "role_arn was collateral damage"
    assert row["external_id"] == "ext-original", "external_id was collateral damage"


def test_a_corrected_external_id_actually_changes(as_superadmin):
    """The case that sent a wrong value to another team."""
    cid = _create(as_superadmin)

    as_superadmin.patch(f"/admin/connections/{cid}", json={"external_id": "ext-corrected"})

    assert _row()["external_id"] == "ext-corrected"


def test_an_explicit_null_does_clear_a_field(as_superadmin):
    """Sending null is an instruction, not an omission.

    The inverse of the test above, and both have to hold or
    `exclude_unset` is doing nothing.
    """
    cid = _create(as_superadmin)

    as_superadmin.patch(f"/admin/connections/{cid}", json={"profile_name": None})

    assert _row()["profile_name"] is None


def test_an_empty_patch_is_refused_rather_than_bumping_the_revision(as_superadmin):
    cid = _create(as_superadmin)
    before = _row()["revision"]

    assert as_superadmin.patch(f"/admin/connections/{cid}", json={}).status_code == 400
    assert _row()["revision"] == before


def test_the_natural_key_cannot_be_edited(as_superadmin):
    """provider and account_id are not in the patch model OR the allowlist.

    Changing account_id would orphan every imported cost row, since
    fact_cost_daily keys off it. Re-register instead.
    """
    cid = _create(as_superadmin)

    as_superadmin.patch(
        f"/admin/connections/{cid}", json={"account_id": "999988887777", "provider": "azure"}
    )

    row = _row()
    assert row["account_id"] == "222233334444"
    assert row["provider"] == "aws"
    assert "account_id" not in edits.EDITABLE
    assert "provider" not in edits.EDITABLE


def test_patching_something_that_does_not_exist_is_404(as_superadmin):
    missing = "00000000-0000-0000-0000-000000000000"
    r = as_superadmin.patch(f"/admin/connections/{missing}", json={"display_name": "x"})
    assert r.status_code == 404


def test_an_edit_is_audited_without_logging_the_external_id_value(as_superadmin):
    cid = _create(as_superadmin)
    as_superadmin.patch(f"/admin/connections/{cid}", json={"external_id": "ext-secret-value"})

    rows = fetch_all(
        """
        SELECT before, after FROM audit_log
        WHERE action = 'connection.update' ORDER BY at DESC LIMIT 1
        """
    )
    assert rows, "the edit was not audited"
    blob = str(rows[0]["before"]) + str(rows[0]["after"])
    # The value is readable from the connections API by the same
    # superadmin, so the log gains nothing by keeping copies of every
    # value it has ever held.
    assert "ext-secret-value" not in blob
    assert "changed" in blob


# ------------------------------------------------------------ deleting

def test_deleting_stops_imports_and_keeps_the_row(as_superadmin):
    cid = _create(as_superadmin)

    response = as_superadmin.delete(f"/admin/connections/{cid}")

    assert response.status_code == 200
    assert response.json()["cost_data_kept"] is True
    row = _row()
    assert row["deleted_at"] is not None
    assert row["enabled"] is False, "a deleted connection must not be picked up by ingest"


def test_a_deleted_connection_disappears_from_the_list_and_from_ingest(as_superadmin):
    cid = _create(as_superadmin)
    as_superadmin.delete(f"/admin/connections/{cid}")

    listed = as_superadmin.get("/admin/connections").json()["data"]
    assert all(c["account_id"] != "222233334444" for c in listed)
    assert all(c.account_id != "222233334444" for c in store.enabled())


def test_deleting_twice_is_404_not_a_silent_success(as_superadmin):
    cid = _create(as_superadmin)
    assert as_superadmin.delete(f"/admin/connections/{cid}").status_code == 200
    assert as_superadmin.delete(f"/admin/connections/{cid}").status_code == 404


def test_re_registering_a_deleted_account_works(as_superadmin):
    """The recovery path, and the reason delete is soft.

    `upsert` is ON CONFLICT on (provider, account_id) and the deleted row
    still occupies that key, so re-registering has to revive it rather
    than fail on the unique constraint.
    """
    cid = _create(as_superadmin)
    as_superadmin.delete(f"/admin/connections/{cid}")

    again = as_superadmin.post("/admin/connections", json=BODY)

    assert again.status_code == 201
    row = _row()
    assert row["deleted_at"] is None, "re-registering must revive the row"
    assert row["enabled"] is True


def test_a_non_superadmin_can_neither_edit_nor_delete(as_plain_user):
    """Create the row directly, not through the API.

    Requesting `as_superadmin` and `as_plain_user` together does NOT
    work: both set `app.dependency_overrides[deps.principal]`, so the
    second fixture wins and the "superadmin" client is actually the
    plain user. The create then 403s and the test fails for the wrong
    reason.
    """
    cid = store.upsert(
        actor="root@costhub.test",
        provider="aws",
        account_id="222233334444",
        display_name="Target",
        credential_mode="assume_role",
        role_arn=BODY["role_arn"],
        external_id="ext-original",
        profile_name=None,
        secret_arn=None,
    )

    assert as_plain_user.patch(f"/admin/connections/{cid}", json={"display_name": "x"}).status_code == 403
    assert as_plain_user.delete(f"/admin/connections/{cid}").status_code == 403
    assert _row()["display_name"] == "Target", "nothing was written"


def test_a_revived_connection_does_not_inherit_its_last_import(as_superadmin):
    """Registering what you believe is a new account must not open with
    "Last import: failed" from before it was deleted. The row has never
    run as far as its new owner is concerned."""
    cid = _create(as_superadmin)
    store.record_ingest(connection_id=cid, status="failed")
    as_superadmin.delete(f"/admin/connections/{cid}")

    as_superadmin.post("/admin/connections", json=BODY)

    row = _row()
    assert row["last_ingest_at"] is None
    assert row["last_ingest_status"] is None
    listed = as_superadmin.get("/admin/connections").json()["data"]
    assert next(c for c in listed if c["id"] == cid)["last_ingest_status"] is None


def test_a_revive_is_audited_as_a_revive(as_superadmin):
    """It was logged as `connection.update`, chosen by `revision == 1`,
    so nothing in the trail said a deleted connection had come back."""
    cid = _create(as_superadmin)
    store.record_ingest(connection_id=cid, status="failed")
    as_superadmin.delete(f"/admin/connections/{cid}")
    as_superadmin.post("/admin/connections", json=BODY)

    actions = [
        r["action"]
        for r in fetch_all(
            "SELECT action FROM audit_log WHERE entity_id = %(i)s "
            "AND action IN ('connection.create','connection.update','connection.revive') "
            "ORDER BY at",
            {"i": cid},
        )
    ]
    assert actions == ["connection.create", "connection.revive"]

    entry = fetch_all(
        "SELECT before FROM audit_log WHERE action = 'connection.revive'"
    )[0]
    # What the revive threw away stays readable here.
    assert entry["before"]["deleted_at"] is not None
    assert entry["before"]["last_ingest_status"] == "failed"


def test_re_registering_a_live_connection_keeps_its_history(as_superadmin):
    """The reset is for revival only. An ordinary second POST is an
    update, and its last import really did happen."""
    cid = _create(as_superadmin)
    store.record_ingest(connection_id=cid, status="success")

    as_superadmin.post("/admin/connections", json={**BODY, "display_name": "Renamed"})

    row = _row()
    assert row["last_ingest_status"] == "success"
    assert row["last_ingest_at"] is not None
    last = fetch_all(
        "SELECT action FROM audit_log WHERE entity_id = %(i)s ORDER BY at DESC LIMIT 1",
        {"i": cid},
    )[0]
    assert last["action"] == "connection.update"
