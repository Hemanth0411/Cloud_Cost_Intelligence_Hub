"""`POST /admin/connections/{id}/import`.

Nothing covered this route at all, which is how a dead branch survived
review: the handler had an `if not results:` arm claiming to catch a
disabled connection, and it could never run. `runner.ingest` only
consults `store.enabled()` when it is NOT given an explicit connection
list, and the route always passes one -- so a disabled account was
imported, billed for in Cost Explorer calls, and stamped
`last_ingest_status='success'`, while the screen drew it greyed out as
disabled and its own tooltip said "Disabled connections are skipped by
imports".

The ingest itself is faked here. The point is the route's contract --
which connections it will act on and what it answers -- not Cost
Explorer, which has its own tests and costs $0.01 a call.
"""
from __future__ import annotations

import pytest

from costhub.connections import edits, store
from costhub.db import fetch_all

BODY = {
    "provider": "aws",
    "account_id": "333344445555",
    "display_name": "Importable",
    "credential_mode": "assume_role",
    "role_arn": "arn:aws:iam::333344445555:role/CostHubCostReader",
    "external_id": "ext-import",
}


@pytest.fixture
def no_real_aws(monkeypatch):
    """Replace the adapter, so no Cost Explorer call is made."""
    from costhub.ingest import ports

    class _Source:
        name = "faked"

        def fetch(self, *, account_id, start, end):
            from datetime import timedelta

            yield ports.CostRow(
                provider="aws",
                account_id=account_id,
                service_name="AWS Glue",
                region="us-east-1",
                charge_category="Usage",
                usage_date=start + timedelta(days=1),
                billed_cost="1.23",
                effective_cost="1.23",
                currency="USD",
            )

    import costhub.api.routes.connections as route_mod

    monkeypatch.setattr("costhub.ingest.sources.source_for", lambda conn: _Source())
    return route_mod


def test_a_disabled_connection_is_not_imported(as_superadmin, no_real_aws):
    """The regression. Billing an account the operator switched off is the
    one thing this must never do."""
    cid = as_superadmin.post("/admin/connections", json=BODY).json()["id"]
    assert edits.set_enabled(actor="t@costhub.test", connection_id=cid, value=False)

    response = as_superadmin.post(f"/admin/connections/{cid}/import")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert body["rows"] == 0
    assert "disabled" in body["detail"].lower()
    # Nothing was written, and no run was recorded against it.
    assert fetch_all(
        "SELECT 1 FROM fact_cost_daily WHERE account_id = '333344445555'"
    ) == []
    row = fetch_all(
        "SELECT last_ingest_status FROM cloud_connections WHERE id = %(i)s", {"i": cid}
    )[0]
    assert row["last_ingest_status"] is None, "a skipped import must not stamp a status"


def test_an_enabled_connection_imports_and_reports_the_count(as_superadmin, no_real_aws):
    cid = as_superadmin.post("/admin/connections", json=BODY).json()["id"]

    body = as_superadmin.post(f"/admin/connections/{cid}/import?days=3").json()

    assert body["ok"] is True
    assert body["rows"] == 1
    assert body["window"][0] < body["window"][1]
    assert fetch_all("SELECT 1 FROM fact_cost_daily WHERE account_id = '333344445555'")


def test_the_import_is_audited(as_superadmin, no_real_aws):
    cid = as_superadmin.post("/admin/connections", json=BODY).json()["id"]
    as_superadmin.post(f"/admin/connections/{cid}/import?days=3")

    rows = fetch_all(
        "SELECT after FROM audit_log WHERE action = 'connection.import' ORDER BY at DESC LIMIT 1"
    )
    assert rows, "the import was not audited"
    assert rows[0]["after"]["rows"] == 1


def test_a_deleted_connection_cannot_be_imported(as_superadmin, no_real_aws):
    cid = as_superadmin.post("/admin/connections", json=BODY).json()["id"]
    as_superadmin.delete(f"/admin/connections/{cid}")

    assert as_superadmin.post(f"/admin/connections/{cid}/import").status_code == 404


def test_the_day_cap_is_enforced(as_superadmin, no_real_aws):
    """Capped because API Gateway cuts the request at 29 seconds."""
    cid = as_superadmin.post("/admin/connections", json=BODY).json()["id"]

    assert as_superadmin.post(f"/admin/connections/{cid}/import?days=32").status_code == 422
    assert as_superadmin.post(f"/admin/connections/{cid}/import?days=0").status_code == 422


def test_a_non_superadmin_cannot_import(as_plain_user, no_real_aws):
    cid = store.upsert(
        actor="root@costhub.test",
        provider="aws",
        account_id="333344445555",
        display_name="Importable",
        credential_mode="assume_role",
        role_arn=BODY["role_arn"],
        external_id="ext-import",
        profile_name=None,
        secret_arn=None,
    )

    assert as_plain_user.post(f"/admin/connections/{cid}/import").status_code == 403
    assert fetch_all("SELECT 1 FROM fact_cost_daily WHERE account_id = '333344445555'") == []


def test_enabling_a_missing_connection_is_404(as_superadmin):
    """The silent-success bug soft delete made easy to hit."""
    missing = "00000000-0000-0000-0000-000000000000"
    assert as_superadmin.post(f"/admin/connections/{missing}/enabled?value=true").status_code == 404


def test_clearing_a_required_field_is_400_not_500(as_superadmin):
    """`{"role_arn": null}` on an assume_role row violates a CHECK.

    It used to surface as an unhandled 500 with no indication of which
    constraint failed -- and it is the obvious first half of "retype the
    role ARN", the exact flow the edit feature exists for.
    """
    cid = as_superadmin.post("/admin/connections", json=BODY).json()["id"]

    response = as_superadmin.patch(f"/admin/connections/{cid}", json={"role_arn": None})

    assert response.status_code == 400, f"got {response.status_code}: {response.text[:200]}"
    assert "role arn" in response.json()["detail"].lower()


def test_an_empty_display_name_is_refused_with_a_reason(as_superadmin):
    """Both rejected, by two different layers, and that is worth recording.

    `""` fails pydantic's min_length -> 422 before any SQL.
    `null` does NOT: `min_length` constrains the string and still permits
    None, so it reaches the NOT NULL column and the IntegrityError
    handler answers 400 with the rule it broke.

    Two statuses for one intent is slightly untidy, but both are refusals
    with a readable reason and neither writes -- which is the property
    that matters. The alternative, forbidding None in the model, needs a
    type whose default is None while the annotation is not Optional, and
    that reads worse than this comment.
    """
    cid = as_superadmin.post("/admin/connections", json=BODY).json()["id"]

    assert as_superadmin.patch(f"/admin/connections/{cid}", json={"display_name": ""}).status_code == 422
    nulled = as_superadmin.patch(f"/admin/connections/{cid}", json={"display_name": None})
    assert nulled.status_code == 400
    assert "empty" in nulled.json()["detail"].lower()

    # Neither wrote.
    row = fetch_all("SELECT display_name FROM cloud_connections WHERE id = %(i)s", {"i": cid})[0]
    assert row["display_name"] == "Importable"


def test_edits_update_is_still_the_only_writer_of_editable_columns():
    """Guard the allowlist: a column added to the model must be added here.

    TWO FIELDS ARE DELIBERATELY NOT COLUMNS. The access key pair is
    popped off in the route and written to Secrets Manager; what reaches
    the SQL is the `secret_arn` that produced. They are named here rather
    than skipped by a pattern, so a third one is a decision somebody has
    to make in this file rather than something a prefix quietly admits.
    """
    from costhub.api.routes.connection_edits import ConnectionPatch

    not_columns = {"access_key_id", "secret_access_key"}

    assert set(ConnectionPatch.model_fields) - not_columns <= set(edits.EDITABLE), (
        "a patchable field is missing from edits.EDITABLE, so it would be "
        "silently ignored rather than applied"
    )

    # The other direction, which is the one that matters now: if either
    # credential field were ever added to EDITABLE, `edits.update` would
    # build a SET clause from its name and write the key itself into a
    # column -- the single thing this feature exists not to do.
    assert not (not_columns & set(edits.EDITABLE)), (
        "a credential input is in edits.EDITABLE, so the key would be "
        "written to a database column"
    )


def test_a_successful_import_also_runs_detection_for_that_account(
    as_superadmin, no_real_aws, monkeypatch
):
    """The schedule runs ingest at 06:00 and detection at 06:30, so a
    newly connected account showed no anomalies until the next morning
    even though its history had just arrived."""
    seen: list[dict] = []

    class _Result:
        findings = 2

    from costhub.anomaly import runner as anomaly_runner

    def fake_scan(*, actor, account_id=None, **kw):
        seen.append({"actor": actor, "account_id": account_id})
        return _Result()

    monkeypatch.setattr(anomaly_runner, "scan", fake_scan)

    cid = as_superadmin.post("/admin/connections", json=BODY).json()["id"]
    body = as_superadmin.post(f"/admin/connections/{cid}/import?days=3").json()

    assert body["findings"] == 2
    # Scoped to the imported account, not a full re-scan of everything.
    assert seen == [{"actor": "root@costhub.test", "account_id": "333344445555"}]


def test_detection_is_skipped_when_nothing_was_imported(
    as_superadmin, no_real_aws, monkeypatch
):
    """`findings: null` means detection did not run -- distinct from 0,
    which means it ran and found nothing."""
    from costhub.anomaly import runner as anomaly_runner
    from costhub.ingest import ports

    class _Empty:
        name = "faked-empty"

        def fetch(self, *, account_id, start, end):
            return iter(())

    monkeypatch.setattr("costhub.ingest.sources.source_for", lambda c: _Empty())
    called = []
    monkeypatch.setattr(anomaly_runner, "scan", lambda **kw: called.append(kw))

    cid = as_superadmin.post("/admin/connections", json=BODY).json()["id"]
    body = as_superadmin.post(f"/admin/connections/{cid}/import?days=3").json()

    assert body["rows"] == 0
    assert body["findings"] is None
    assert called == [], "no rows means nothing new to detect on"
    assert ports  # keep the import meaningful to linters


def test_a_detection_failure_does_not_fail_the_import(
    as_superadmin, no_real_aws, monkeypatch
):
    """The rows are already committed and useful, and the 06:30 run will
    pick the series up anyway. Losing the import over it would be worse."""
    from costhub.anomaly import runner as anomaly_runner

    def boom(**kw):
        raise RuntimeError("detector exploded")

    monkeypatch.setattr(anomaly_runner, "scan", boom)

    cid = as_superadmin.post("/admin/connections", json=BODY).json()["id"]
    response = as_superadmin.post(f"/admin/connections/{cid}/import?days=3")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True and body["rows"] == 1
    assert body["findings"] is None
    assert fetch_all("SELECT 1 FROM fact_cost_daily WHERE account_id = '333344445555'")
