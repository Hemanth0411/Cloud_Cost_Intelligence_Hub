"""Runner tests -- against the database, so persistence behaviour is real.

The one that matters most is `test_rescan_does_not_resurrect_acknowledged`:
a nightly job that quietly marks dismissed findings new again would make
the feed useless within a week.
"""
from __future__ import annotations

from datetime import date, timedelta

from costhub.anomaly import runner
from costhub.anomaly.mad import MadDetector
from costhub.db import fetch_all, fetch_one

ACCT = "999999999999"
TODAY = date.today()


def _seed(make_series, service: str, values: list[float], *, account: str = ACCT):
    """One day per value, ending two days before today.

    Ending before today matters: the detector skips the most recent days
    because AWS is still restating them.
    """
    make_series(account, service, values)


def _noisy(n: int, level: float = 10.0) -> list[float]:
    return [level + (0.4 if i % 2 else -0.4) for i in range(n)]


def test_scan_finds_a_step(make_series):
    _seed(make_series, "AWSGlue", _noisy(40) + [40.0] * 8)

    result = runner.scan(detector=MadDetector(exclude_recent_days=0, scan_days=10))

    assert result.series_scanned >= 1
    rows = fetch_all(
        "SELECT kind, baseline_value, observed_value, delta_pct, score "
        "FROM anomaly_findings WHERE service_name = 'AWSGlue'"
    )
    assert len(rows) == 1
    assert rows[0]["kind"] == "step"
    assert rows[0]["observed_value"] > rows[0]["baseline_value"]
    assert rows[0]["delta_pct"] > 100


def test_quiet_series_produces_no_findings(make_series):
    _seed(make_series, "AmazonS3", _noisy(50))
    runner.scan(detector=MadDetector(exclude_recent_days=0))
    assert fetch_all("SELECT 1 FROM anomaly_findings") == []


def test_each_service_scanned_separately(make_series):
    """A spike in one service must not be averaged away by another."""
    _seed(make_series, "AmazonEC2", _noisy(45, 200.0))      # large and quiet
    _seed(make_series, "AWSLambda", _noisy(44, 1.0) + [30.0])  # small and spiked

    runner.scan(detector=MadDetector(exclude_recent_days=0, scan_days=10))

    rows = fetch_all("SELECT service_name FROM anomaly_findings")
    services = {r["service_name"] for r in rows}
    assert "AWSLambda" in services
    assert "AmazonEC2" not in services


def test_rescan_is_idempotent(make_series):
    _seed(make_series, "AWSGlue", _noisy(40) + [40.0] * 8)
    det = MadDetector(exclude_recent_days=0, scan_days=10)

    first = runner.scan(detector=det)
    second = runner.scan(detector=det)

    assert first.created == 1
    assert second.created == 0
    assert second.updated == 1
    assert fetch_one("SELECT count(*) c FROM anomaly_findings")["c"] == 1


def test_rescan_does_not_resurrect_acknowledged(make_series, exec_sql):
    """Once dismissed, a finding stays dismissed through later scans."""
    _seed(make_series, "AWSGlue", _noisy(40) + [40.0] * 8)
    det = MadDetector(exclude_recent_days=0, scan_days=10)
    runner.scan(detector=det)

    exec_sql(
        "UPDATE anomaly_findings SET status='dismissed', "
        "acknowledged_by='me@chryselys.com', acknowledged_at=now()"
    )

    runner.scan(detector=det)

    row = fetch_one("SELECT status, acknowledged_by, revision FROM anomaly_findings")
    assert row["status"] == "dismissed"
    assert row["acknowledged_by"] == "me@chryselys.com"
    assert row["revision"] > 1  # measurements were refreshed


def test_tax_and_credit_rows_excluded_from_detection(make_series, make_facts):
    """A big tax line is not an anomaly in a service."""
    _seed(make_series, "AmazonRDS", _noisy(50))
    make_facts([(ACCT, "AmazonRDS", 500.0)],
               on=TODAY - timedelta(days=2), charge_category="Tax")

    runner.scan(detector=MadDetector(exclude_recent_days=0, scan_days=10))
    assert fetch_all("SELECT 1 FROM anomaly_findings") == []


def test_scan_writes_one_audit_row_per_run(make_series):
    _seed(make_series, "AWSGlue", _noisy(40) + [40.0] * 8)
    runner.scan(detector=MadDetector(exclude_recent_days=0, scan_days=10))

    rows = fetch_all(
        "SELECT actor, action, after FROM audit_log WHERE action = 'anomaly.scan'"
    )
    assert len(rows) == 1
    assert rows[0]["after"]["findings"] >= 1


def test_findings_are_scoped_like_facts(make_series, make_user, make_grant):
    """A user with no grant for the account must not see its findings."""
    _seed(make_series, "AWSGlue", _noisy(40) + [40.0] * 8)
    runner.scan(detector=MadDetector(exclude_recent_days=0, scan_days=10))

    granted = make_user("has@chryselys.com")
    make_grant(granted, ACCT)
    denied = make_user("hasnot@chryselys.com")

    sql = """
    SELECT count(*) AS c FROM anomaly_findings a
    WHERE EXISTS (
      SELECT 1 FROM access_grants g
      WHERE g.user_id = %(u)s AND g.revoked_at IS NULL AND g.deleted_at IS NULL
        AND g.provider = a.provider AND g.account_id = a.account_id
        AND (g.service_name IS NULL OR g.service_name = a.service_name)
        AND now() >= g.valid_from
        AND (g.valid_until IS NULL OR now() < g.valid_until))
    """
    assert fetch_one(sql, {"u": granted})["c"] == 1
    assert fetch_one(sql, {"u": denied})["c"] == 0
