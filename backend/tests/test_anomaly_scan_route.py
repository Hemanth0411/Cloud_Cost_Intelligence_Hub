"""`POST /anomalies/scan` -- the "Run detection now" button.

The detector has its own tests (test_anomaly_runner.py, test_mad.py).
What is pinned here is the route's contract: who may run it, that the
caller is recorded as the actor, and what comes back.
"""
from __future__ import annotations

from costhub.anomaly import runner
from costhub.db import fetch_all


def test_superadmin_runs_detection_as_themselves(as_superadmin, monkeypatch):
    seen = []

    def fake_scan(**kw):
        seen.append(kw)
        return runner.ScanResult(series_scanned=6, findings=2, created=1,
                                 updated=1, by_kind={"spike": 2})

    monkeypatch.setattr(runner, "scan", fake_scan)
    response = as_superadmin.post("/anomalies/scan")

    assert response.status_code == 200
    assert response.json() == {"series_scanned": 6, "findings": 2, "created": 1,
                               "updated": 1, "by_kind": {"spike": 2}}
    # The whole estate, attributed to the person who pressed the button.
    assert seen == [{"actor": "root@costhub.test"}]


def test_a_plain_user_cannot_run_detection(as_plain_user, monkeypatch):
    """Detection reads every account; only a superadmin may start it."""
    monkeypatch.setattr(runner, "scan", lambda **kw: (_ for _ in ()).throw(AssertionError))
    assert as_plain_user.post("/anomalies/scan").status_code == 403


def test_a_real_scan_over_nothing_answers_zero_and_is_audited(as_superadmin):
    body = as_superadmin.post("/anomalies/scan").json()

    assert body == {"series_scanned": 0, "findings": 0, "created": 0,
                    "updated": 0, "by_kind": {}}
    audit = fetch_all("SELECT actor FROM audit_log WHERE action = 'anomaly.scan'")
    assert [r["actor"] for r in audit] == ["root@costhub.test"]
