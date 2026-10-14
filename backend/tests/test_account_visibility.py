"""Deleting a connection hides its account; registering it shows it again.

The bug: `DELETE /admin/connections/{id}` soft-deleted the connection and
left `dim_account.is_active` true, so the account stayed in every filter
dropdown with nothing behind it. It was fixed by hand once, in the
deployed database, and would have recurred on the next delete.

The revive-after-delete path has produced two real bugs already (a 201
that left `deleted_at` set, and a revived row inheriting an old "failed"
import), so it is exercised here end to end -- the real API, the real
runner with a fake source, and `/meta/accounts`, which is what the
dropdowns actually read -- rather than by poking `dim_account` alone.
"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from costhub.connections import store
from costhub.db import execute, fetch_all
from costhub.ingest import runner
from costhub.ingest.ports import CostRow

ACCOUNT = "222233334444"
BODY = {
    "provider": "aws",
    "account_id": ACCOUNT,
    "display_name": "Target",
    "credential_mode": "assume_role",
    "role_arn": f"arn:aws:iam::{ACCOUNT}:role/CostHubCostReader",
    "external_id": "ext-original",
}
DAYS = 3


class _ThreeDays:
    name = "test"

    def fetch(self, *, account_id, start, end):
        for i in range(DAYS):
            yield CostRow(
                provider="aws", account_id=account_id, service_name="Amazon S3",
                usage_date=start + timedelta(days=i), billed_cost=Decimal("1.50"),
                effective_cost=Decimal("1.50"), currency="USD", region="us-east-1",
            )


def _register(client) -> str:
    response = client.post("/admin/connections", json=BODY)
    assert response.status_code == 201
    return response.json()["id"]


def _import(cid: str) -> None:
    conn = store.get(cid)
    assert conn is not None
    [result] = runner.ingest(
        source_factory=lambda c: _ThreeDays(), start=date(2026, 10, 1),
        end=date(2026, 10, 8), triggered_by="t@costhub.test", connections=[conn],
    )
    assert result.ok and result.rows == DAYS


def _listed(client) -> bool:
    """What the dropdowns see -- the route, not the table."""
    accounts = client.get("/meta/accounts").json()["data"]
    return any(a["account_id"] == ACCOUNT for a in accounts)


def _active() -> bool:
    [row] = fetch_all(
        "SELECT is_active FROM dim_account WHERE provider = 'aws' AND account_id = %(a)s",
        {"a": ACCOUNT},
    )
    return row["is_active"]


def _account_audit() -> list[str]:
    return [
        r["action"]
        for r in fetch_all(
            "SELECT action FROM audit_log WHERE entity_type = 'dim_account' "
            "AND entity_id = %(e)s ORDER BY at, id",
            {"e": f"aws:{ACCOUNT}"},
        )
    ]


# -------------------------------------------------------------- delete

def test_deleting_a_connection_takes_its_account_out_of_the_dropdowns(as_superadmin):
    cid = _register(as_superadmin)
    _import(cid)
    assert _listed(as_superadmin), "precondition: an imported account is listed"

    assert as_superadmin.delete(f"/admin/connections/{cid}").status_code == 200

    assert not _active()
    assert not _listed(as_superadmin), "the ghost: listed with no live connection"


def test_the_cost_rows_survive_and_still_join_to_their_account(as_superadmin):
    """Deactivate, never delete: history must stay readable by name."""
    cid = _register(as_superadmin)
    _import(cid)

    as_superadmin.delete(f"/admin/connections/{cid}")

    rows = fetch_all(
        """
        SELECT d.account_name, d.is_active
          FROM fact_cost_daily f
          JOIN dim_account d USING (provider, account_id)
         WHERE f.account_id = %(a)s
        """,
        {"a": ACCOUNT},
    )
    assert len(rows) == DAYS, "every cost row must survive the delete and still join"
    assert {r["account_name"] for r in rows} == {"Target"}
    assert not any(r["is_active"] for r in rows)


def test_deleting_a_connection_that_never_imported_is_not_an_error(as_superadmin):
    """No dimension row exists yet, so there is nothing to hide -- and
    nothing to audit as hidden."""
    cid = _register(as_superadmin)

    assert as_superadmin.delete(f"/admin/connections/{cid}").status_code == 200

    assert _account_audit() == []
    [entry] = fetch_all("SELECT after FROM audit_log WHERE action = 'connection.delete'")
    assert entry["after"]["account_hidden"] is False


def test_disabling_is_not_deleting(as_superadmin):
    """A paused connection still owns its account."""
    cid = _register(as_superadmin)
    _import(cid)

    as_superadmin.post(f"/admin/connections/{cid}/enabled", params={"value": False})

    assert _active() and _listed(as_superadmin)


# -------------------------------------------------------------- revive

def test_re_registering_makes_the_account_visible_before_any_import(as_superadmin):
    """The register path, not the ingest. A revived connection whose role
    is still broken never reaches the runner's re-activation, and its
    earlier history is real."""
    cid = _register(as_superadmin)
    _import(cid)
    as_superadmin.delete(f"/admin/connections/{cid}")

    assert _register(as_superadmin) == cid, "a revive, not a second row"

    assert _active()
    assert _listed(as_superadmin)


def test_an_import_re_activates_an_account_the_register_path_missed(as_superadmin):
    """The runner's own upsert, `runner.DIM_ACCOUNT`. Covers a row hidden
    by any other route, including the hand fix this replaced."""
    cid = _register(as_superadmin)
    _import(cid)
    execute("UPDATE dim_account SET is_active = false WHERE account_id = %(a)s", {"a": ACCOUNT})

    _import(cid)

    assert _active()


def test_delete_and_revive_survive_being_repeated(as_superadmin):
    """Each half has to work from the state the other leaves behind."""
    cid = _register(as_superadmin)
    _import(cid)

    for _ in range(2):
        as_superadmin.delete(f"/admin/connections/{cid}")
        assert not _listed(as_superadmin)
        _register(as_superadmin)
        assert _listed(as_superadmin)

    _import(cid)
    assert _listed(as_superadmin)
    [n] = fetch_all("SELECT count(*) AS n FROM fact_cost_daily WHERE account_id = %(a)s",
                    {"a": ACCOUNT})
    assert n["n"] == DAYS, "re-importing the same days upserts, it does not duplicate"


# --------------------------------------------------------------- audit

def test_both_flips_are_audited_and_no_ops_are_not(as_superadmin):
    cid = _register(as_superadmin)
    _import(cid)
    as_superadmin.post("/admin/connections", json={**BODY, "display_name": "Renamed"})
    assert _account_audit() == [], "re-registering a live account changes nothing"

    as_superadmin.delete(f"/admin/connections/{cid}")
    _register(as_superadmin)

    assert _account_audit() == ["account.deactivate", "account.reactivate"]
    entries = fetch_all(
        "SELECT actor, before, after FROM audit_log WHERE entity_type = 'dim_account' "
        "ORDER BY at, id"
    )
    assert all(e["actor"] == "root@costhub.test" for e in entries)
    assert entries[0]["before"] == {"is_active": True}
    assert entries[0]["after"]["is_active"] is False
    assert entries[0]["after"]["connection_id"] == cid
    assert entries[1]["after"]["is_active"] is True
