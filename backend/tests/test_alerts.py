"""Alert tests.

The two that matter most:

  test_resolve_agrees_with_scoped          -- the drift guard. resolve and
                                              scoped express the same rule
                                              in different SQL; this pins
                                              them together.
  test_revoked_grant_suppresses_delivery   -- FR-34. A rule can outlive the
                                              grant that justified it.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from costhub.alerts import runner
from costhub.alerts.ports import Delivery, Event, Rule, due
from costhub.query import scoped
from costhub.query.scoped import Filters, Principal
from costhub.rbac import resolve
from costhub.db import fetch_all, fetch_one

ACCT = "777777777777"
OTHER = "888888888888"
TODAY = date.today()
NOW = datetime.now(timezone.utc)


class Recorder:
    """A notifier that records instead of sending."""

    channel = "inapp"

    def __init__(self, *, fail: bool = False) -> None:
        self.sent: list[Event] = []
        self.fail = fail

    def send(self, event: Event, *, recipients: list[str]) -> Delivery:
        self.sent.append(event)
        if self.fail:
            return Delivery(self.channel, False, "simulated failure")
        return Delivery(self.channel, True)


def _rule(exec_sql, owner_id: str, **over) -> str:
    body = {
        "name": "test rule", "type": "threshold", "scope_provider": "aws",
        "scope_account": ACCT, "scope_service": None, "metric": "effective_cost",
        "comparator": "gt", "threshold_value": Decimal("50"), "window_days": 7,
        "frequency": "immediate", "channels": json.dumps(["inapp"]),
        "enabled": True,
    }
    body.update(over)
    row = exec_sql(
        """
        INSERT INTO alert_rules
          (name, owner_user_id, scope_provider, scope_account, scope_service,
           type, metric, comparator, threshold_value, window_days,
           frequency, channels, enabled, created_by, updated_by)
        VALUES (%(name)s, %(uid)s, %(scope_provider)s, %(scope_account)s,
                %(scope_service)s, %(type)s, %(metric)s, %(comparator)s,
                %(threshold_value)s, %(window_days)s, %(frequency)s,
                %(channels)s, %(enabled)s, 'test', 'test')
        RETURNING id
        """,
        {**body, "uid": owner_id},
    )
    return str(row["id"])


# ------------------------------------------------------ the drift guard

def test_resolve_agrees_with_scoped(make_series, make_user, make_grant):
    """resolve.can_see and scoped.GRANT_PREDICATE encode the same rule in
    different SQL. If they ever disagree, alert suppression and data
    filtering disagree, which is a disclosure or a silent outage."""
    make_series(ACCT, "AWSGlue", [10.0] * 10)
    make_series(ACCT, "AmazonS3", [5.0] * 10)
    make_series(OTHER, "AWSGlue", [20.0] * 10)

    start = TODAY - timedelta(days=30)
    end = TODAY + timedelta(days=1)

    # (label, how the grant is made, what we then ASK about).
    # The third element is the point: the original version of this test
    # always asked about exactly what it granted, so it never exercised
    # "granted one service, asked account-wide" -- which is precisely
    # where the two predicates disagreed.
    cases = [
        ("all services granted, asked account-wide",
         dict(account_id=ACCT, service_name=None), None),
        ("one service granted, asked that service",
         dict(account_id=ACCT, service_name="AWSGlue"), "AWSGlue"),
        ("one service granted, asked account-wide",
         dict(account_id=ACCT, service_name="AWSGlue"), None),
        ("one service granted, asked a different service",
         dict(account_id=ACCT, service_name="AWSGlue"), "AmazonS3"),
        ("expired",
         dict(account_id=ACCT, service_name=None,
              valid_from=TODAY - timedelta(days=10),
              valid_until=TODAY - timedelta(days=1)), None),
        ("future",
         dict(account_id=ACCT, service_name=None,
              valid_from=TODAY + timedelta(days=1)), None),
        ("revoked",
         dict(account_id=ACCT, service_name=None, revoked=True), None),
        ("granted a different account",
         dict(account_id=OTHER, service_name=None), None),
    ]

    for label, grant_kw, asked_service in cases:
        slug = label.replace(" ", "-").replace(",", "")[:40]
        user = make_user(f"drift-{slug}@chryselys.com")
        make_grant(user, **grant_kw)
        who = Principal(user_id=user, email="x@chryselys.com")

        via_scoped = bool(
            scoped.by_dimension(
                who,
                Filters(start=start, end=end, provider="aws",
                        account_id=ACCT, service_name=asked_service),
                "service",
            )
        )
        via_resolve = resolve.can_see(
            user, provider="aws", account_id=ACCT, service_name=asked_service
        )
        assert via_scoped == via_resolve, (
            f"disagree on {label!r}: scoped={via_scoped} resolve={via_resolve}"
        )


def test_effective_grants_excludes_dead_grants(make_user, make_grant):
    user = make_user("live@chryselys.com")
    make_grant(user, ACCT)
    make_grant(user, OTHER, revoked=True)
    make_grant(user, "666666666666",
               valid_from=TODAY - timedelta(days=10),
               valid_until=TODAY - timedelta(days=1))

    accounts = {g.account_id for g in resolve.effective_grants(user)}
    assert accounts == {ACCT}


# ------------------------------------------------------------- FR-34

def test_revoked_grant_suppresses_delivery(make_series, make_user, make_grant, exec_sql):
    """A rule outlives its grant.

    Nothing is delivered, the notifier is never called, and a notice is
    recorded carrying NO cost figures -- the owner can read their own
    feed and is no longer entitled to the numbers.
    """
    make_series(ACCT, "AWSGlue", [40.0] * 10)
    user = make_user("owner@chryselys.com")
    gid = make_grant(user, ACCT)
    rule_id = _rule(exec_sql, user)
    rec = Recorder()

    first = runner.run(today=TODAY, notifiers={"inapp": rec})
    assert first.fired == 1 and first.delivered == 1
    assert len(rec.sent) == 1

    exec_sql("UPDATE access_grants SET revoked_at = now() WHERE id = %(id)s",
             {"id": gid})

    second = runner.run(today=TODAY, notifiers={"inapp": rec})
    assert second.suppressed_no_access == 1
    assert second.delivered == 0
    assert second.evaluated == 0, "must not even evaluate an inaccessible scope"
    assert len(rec.sent) == 1, "notifier must not be called at all"

    events = fetch_all(
        "SELECT observed_value, expected_value, delivered_at, delivery_error "
        "FROM alert_events WHERE rule_id = %(r)s ORDER BY fired_at",
        {"r": rule_id},
    )
    assert len(events) == 2
    lapse = events[1]
    assert lapse["delivered_at"] is None
    assert "no longer has access" in lapse["delivery_error"]
    assert lapse["observed_value"] is None, "a lapse notice must not carry figures"
    assert lapse["expected_value"] is None


def test_lapse_notice_is_not_repeated_every_run(
    make_series, make_user, make_grant, exec_sql
):
    """An `immediate` rule with a dead grant must not log a notice per run."""
    make_series(ACCT, "AWSGlue", [40.0] * 10)
    user = make_user("repeat@chryselys.com")
    gid = make_grant(user, ACCT)
    _rule(exec_sql, user)
    runner.run(today=TODAY, notifiers={"inapp": Recorder()})

    exec_sql("UPDATE access_grants SET revoked_at = now() WHERE id = %(id)s",
             {"id": gid})

    first = runner.run(today=TODAY, notifiers={"inapp": Recorder()})
    second = runner.run(today=TODAY, notifiers={"inapp": Recorder()})
    assert first.suppressed_no_access == 1
    assert second.suppressed_no_access == 0
    assert second.skipped_not_due == 1


def test_suppressed_event_is_recorded_not_dropped(make_series, make_user, exec_sql):
    """No grant at all: still recorded, so the spend is not invisible."""
    make_series(ACCT, "AWSGlue", [40.0] * 10)
    user = make_user("nogrant@chryselys.com")
    _rule(exec_sql, user)

    result = runner.run(today=TODAY, notifiers={"inapp": Recorder()})
    assert result.suppressed_no_access == 1
    assert fetch_one("SELECT count(*) c FROM alert_events")["c"] == 1


# -------------------------------------------------------- rule types

def test_threshold_fires_above_and_not_below(make_series, make_user, make_grant, exec_sql):
    make_series(ACCT, "AWSGlue", [10.0] * 10)   # 7-day window ~= 70
    user = make_user("th@chryselys.com")
    make_grant(user, ACCT)

    _rule(exec_sql, user, threshold_value=Decimal("50"))
    assert runner.run(today=TODAY, notifiers={"inapp": Recorder()}).fired == 1

    exec_sql("DELETE FROM alert_events")
    exec_sql("UPDATE alert_rules SET threshold_value = 10000")
    assert runner.run(today=TODAY, notifiers={"inapp": Recorder()}).fired == 0


def test_digest_fires_unconditionally(make_series, make_user, make_grant, exec_sql):
    make_series(ACCT, "AWSGlue", [1.0] * 10)
    user = make_user("dg@chryselys.com")
    make_grant(user, ACCT)
    _rule(exec_sql, user, type="digest", threshold_value=None, comparator=None)

    rec = Recorder()
    assert runner.run(today=TODAY, notifiers={"inapp": rec}).fired == 1
    assert "top services" in rec.sent[0].body


def test_anomaly_rule_fires_on_new_findings(
    make_series, make_user, make_grant, exec_sql
):
    make_series(ACCT, "AWSGlue", [10.0] * 10)
    exec_sql(
        """
        INSERT INTO anomaly_findings
          (provider, account_id, service_name, detected_for_date, method, kind,
           baseline_value, observed_value, delta_abs, delta_pct, score,
           created_by, updated_by)
        VALUES ('aws', %(a)s, 'AWSGlue', %(d)s, 'mad', 'step',
                10, 40, 30, 300, 9.1, 'test', 'test')
        """,
        {"a": ACCT, "d": TODAY - timedelta(days=2)},
    )
    user = make_user("an@chryselys.com")
    make_grant(user, ACCT)
    _rule(exec_sql, user, type="anomaly", threshold_value=None, comparator=None)

    rec = Recorder()
    assert runner.run(today=TODAY, notifiers={"inapp": rec}).fired == 1
    assert "step" in rec.sent[0].body


def test_anomaly_rule_cannot_see_other_accounts(
    make_series, make_user, make_grant, exec_sql
):
    """An unscoped anomaly rule is still bounded by its owner's grants."""
    exec_sql(
        """
        INSERT INTO anomaly_findings
          (provider, account_id, service_name, detected_for_date, method, kind,
           baseline_value, observed_value, delta_abs, delta_pct, score,
           created_by, updated_by)
        VALUES ('aws', %(a)s, 'AWSGlue', %(d)s, 'mad', 'step',
                10, 40, 30, 300, 9.1, 'test', 'test')
        """,
        {"a": OTHER, "d": TODAY - timedelta(days=2)},
    )
    user = make_user("scoped-an@chryselys.com")
    make_grant(user, ACCT)   # granted ACCT, finding is in OTHER
    _rule(exec_sql, user, type="anomaly", scope_account=None,
          threshold_value=None, comparator=None)

    assert runner.run(today=TODAY, notifiers={"inapp": Recorder()}).fired == 0


# ------------------------------------------------------------ frequency

def test_daily_rule_does_not_fire_twice_in_a_day():
    rule = Rule(
        id="r", name="n", owner_user_id="u", owner_email="e", owner_role="user",
        type="threshold", scope_provider=None, scope_account=None,
        scope_service=None, metric="effective_cost", comparator="gt",
        threshold_value=Decimal("1"), window_days=1, frequency="daily",
        channels=["inapp"],
    )
    assert due(rule, None, NOW) is True
    assert due(rule, NOW - timedelta(hours=2), NOW) is False
    assert due(rule, NOW - timedelta(hours=25), NOW) is True


def test_not_due_rule_is_skipped(make_series, make_user, make_grant, exec_sql):
    make_series(ACCT, "AWSGlue", [40.0] * 10)
    user = make_user("freq@chryselys.com")
    make_grant(user, ACCT)
    _rule(exec_sql, user, frequency="daily")

    assert runner.run(today=TODAY, notifiers={"inapp": Recorder()}).fired == 1
    second = runner.run(today=TODAY, notifiers={"inapp": Recorder()})
    assert second.fired == 0
    assert second.skipped_not_due == 1


# ------------------------------------------------------------- delivery

def test_delivery_failure_is_recorded_with_the_error(
    make_series, make_user, make_grant, exec_sql
):
    """A failed send must not lose the fact that the rule fired."""
    make_series(ACCT, "AWSGlue", [40.0] * 10)
    user = make_user("fail@chryselys.com")
    make_grant(user, ACCT)
    rule_id = _rule(exec_sql, user)

    result = runner.run(today=TODAY, notifiers={"inapp": Recorder(fail=True)})
    assert result.fired == 1
    assert result.delivery_failures == 1
    assert result.delivered == 0

    row = fetch_one(
        "SELECT delivered_at, delivery_error FROM alert_events "
        "WHERE rule_id = %(r)s", {"r": rule_id}
    )
    assert row["delivered_at"] is None
    assert "simulated failure" in row["delivery_error"]


def test_disabled_owner_is_skipped(make_series, make_user, make_grant, exec_sql):
    make_series(ACCT, "AWSGlue", [40.0] * 10)
    user = make_user("gone@chryselys.com")
    make_grant(user, ACCT)
    _rule(exec_sql, user)
    exec_sql("UPDATE users SET status='disabled' WHERE id=%(id)s", {"id": user})

    result = runner.run(today=TODAY, notifiers={"inapp": Recorder()})
    assert result.skipped_owner_disabled == 1
    assert result.fired == 0


# --------------------------------------------------------- clock skew

def test_immediate_frequency_is_never_throttled():
    """Measured skew between this machine and Neon was +4.1s, and
    expressing "immediate" as a 0-hour gap turned that into a skipped
    run: a rule that had just fired looked "not due" because the DB
    timestamp was in the local clock's future."""
    rule = Rule(
        id="r", name="n", owner_user_id="u", owner_email="e", owner_role="user",
        type="threshold", scope_provider=None, scope_account=None,
        scope_service=None, metric="effective_cost", comparator="gt",
        threshold_value=Decimal("1"), window_days=1, frequency="immediate",
        channels=["inapp"],
    )
    future = NOW + timedelta(seconds=5)   # DB clock ahead of ours
    assert due(rule, future, NOW) is True


def test_runner_uses_the_database_clock():
    """Throttling must not depend on the gap between two clocks."""
    from costhub.alerts.runner import _db_now

    db = _db_now()
    assert db.tzinfo is not None, "must be timezone-aware"
    # Same clock that writes fired_at, so a round trip cannot go backwards.
    assert _db_now() >= db
