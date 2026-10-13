"""Renaming a connection must change the label and nothing else.

The reason this has a test rather than being "obviously fine": the
tempting way to rename is `add-connection` with a new `--name`, because
`upsert` is idempotent on (provider, account_id). But `upsert` assigns
EVERY credential column from its arguments, so that path silently blanks
`role_arn`, `external_id` and `profile_name` for any caller that does
not re-supply them -- and `external_id` cannot be re-supplied, because
`GET /admin/connections` redacts it to the string "set". The result is a
connection that still looks registered and can no longer assume its
role. `rename` exists to make that impossible, so these tests pin the
columns it must leave alone.
"""
from __future__ import annotations

from costhub.connections import store
from costhub.db import fetch_all

ACTOR = "tester@costhub"


def _register_cross_account() -> str:
    return store.upsert(
        actor=ACTOR,
        provider="aws",
        account_id="123456789012",
        display_name="before",
        credential_mode="assume_role",
        role_arn="arn:aws:iam::123456789012:role/CostHubCostReader",
        external_id="ext-abc-123",
    )


def _row(connection_id: str) -> dict:
    rows = fetch_all(
        "SELECT * FROM cloud_connections WHERE id = %(id)s", {"id": connection_id}
    )
    assert len(rows) == 1
    return rows[0]


def test_rename_changes_only_the_display_name():
    cid = _register_cross_account()
    before = _row(cid)

    returned = store.rename(
        actor=ACTOR, provider="aws", account_id="123456789012", display_name="after"
    )

    assert returned == cid, "the id must be stable -- ingest_runs references it"
    after = _row(cid)
    assert after["display_name"] == "after"
    # The load-bearing columns. If any of these move, a working
    # connection stops being able to assume its role.
    assert after["account_id"] == before["account_id"]
    assert after["credential_mode"] == "assume_role"
    assert after["role_arn"] == before["role_arn"]
    assert after["external_id"] == "ext-abc-123"
    assert after["enabled"] is True
    assert after["revision"] == before["revision"] + 1
    assert after["updated_by"] == ACTOR


def test_rename_writes_an_audit_row_carrying_the_old_name():
    cid = _register_cross_account()
    store.rename(
        actor=ACTOR, provider="aws", account_id="123456789012", display_name="after"
    )

    rows = fetch_all(
        """
        SELECT actor, action, before, after FROM audit_log
         WHERE entity_type = 'cloud_connection' AND entity_id = %(id)s
           AND action = 'connection.rename'
        """,
        {"id": cid},
    )
    assert len(rows) == 1
    entry = rows[0]
    assert entry["actor"] == ACTOR
    # `before` is the point of the audit row: RETURNING cannot supply it,
    # because it sees the row as the UPDATE left it.
    assert entry["before"] == {"display_name": "before"}
    assert entry["after"] == {"display_name": "after"}


def test_rename_of_an_unknown_connection_returns_none_and_writes_nothing():
    assert (
        store.rename(
            actor=ACTOR, provider="aws", account_id="999999999999", display_name="x"
        )
        is None
    )
    assert fetch_all(
        "SELECT 1 FROM audit_log WHERE action = 'connection.rename'"
    ) == []


def test_rename_leaves_a_self_connection_in_self_mode():
    """The deployed row is `self`/`self`, and that mode is what makes the
    Lambda read its own account. A rename must not knock it into
    assume_role, which is `upsert`'s default."""
    cid = store.upsert(
        actor=ACTOR,
        provider="aws",
        account_id="self",
        display_name="personal",
        credential_mode="self",
    )
    store.rename(
        actor=ACTOR, provider="aws", account_id="self", display_name="Hemanth-AWS"
    )
    row = _row(cid)
    assert row["display_name"] == "Hemanth-AWS"
    assert row["credential_mode"] == "self"
    assert row["role_arn"] is None
