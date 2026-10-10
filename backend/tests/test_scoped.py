"""Tests for the single authorization point.

Every security claim about this application reduces to these passing. The
first one is the most important: absence of a grant must mean absence of
data, not absence of a filter.
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from cloudminds.query import scoped
from cloudminds.query.scoped import Filters, Principal

TODAY = date.today()
WIDE = Filters(start=TODAY - timedelta(days=30), end=TODAY + timedelta(days=1))

ACCT_A = "111111111111"
ACCT_B = "222222222222"


def _principal(user_id: str, role: str = "user") -> Principal:
    return Principal(user_id=user_id, email="u@chryselys.com", role=role)


def _total(rows) -> float:
    return float(sum(r["cost"] for r in rows))


# --------------------------------------------------------------- fail closed

def test_no_grants_sees_nothing(make_user, make_facts):
    """THE test. No grants must yield zero rows, never all rows.

    The classic RLS bug is an empty filter set meaning 'no restriction'.
    """
    make_facts([(ACCT_A, "AmazonEC2", 10), (ACCT_B, "AmazonS3", 20)])
    user = make_user("nobody@chryselys.com")

    assert scoped.series(_principal(user), WIDE) == []
    assert scoped.by_dimension(_principal(user), WIDE, "service") == []
    assert scoped.visible_accounts(_principal(user)) == []


def test_unknown_user_id_sees_nothing(make_facts):
    """A user id that matches no grant row -- e.g. a forged token."""
    make_facts([(ACCT_A, "AmazonEC2", 10)])
    ghost = _principal("00000000-0000-0000-0000-000000000000")
    assert scoped.series(ghost, WIDE) == []


# ------------------------------------------------------------------- scoping

def test_account_grant_scopes_rows(make_user, make_grant, make_facts):
    make_facts([(ACCT_A, "AmazonEC2", 10), (ACCT_B, "AmazonS3", 20)])
    user = make_user("a@chryselys.com")
    make_grant(user, ACCT_A)

    rows = scoped.by_dimension(_principal(user), WIDE, "account")
    assert [r["key"] for r in rows] == [ACCT_A]
    assert _total(rows) == 10


def test_null_service_means_all_services(make_user, make_grant, make_facts):
    make_facts([(ACCT_A, "AmazonEC2", 10), (ACCT_A, "AmazonS3", 5)])
    user = make_user("b@chryselys.com")
    make_grant(user, ACCT_A, service_name=None)

    rows = scoped.by_dimension(_principal(user), WIDE, "service")
    assert {r["key"] for r in rows} == {"AmazonEC2", "AmazonS3"}
    assert _total(rows) == 15


def test_service_grant_excludes_other_services(make_user, make_grant, make_facts):
    make_facts([(ACCT_A, "AmazonEC2", 10), (ACCT_A, "AmazonS3", 5)])
    user = make_user("c@chryselys.com")
    make_grant(user, ACCT_A, service_name="AmazonEC2")

    rows = scoped.by_dimension(_principal(user), WIDE, "service")
    assert [r["key"] for r in rows] == ["AmazonEC2"]
    assert _total(rows) == 10


def test_grant_does_not_leak_across_providers(make_user, make_grant, make_facts):
    make_facts([(ACCT_A, "AmazonEC2", 10)], provider="aws")
    make_facts([(ACCT_A, "VirtualMachines", 7)], provider="azure")
    user = make_user("d@chryselys.com")
    make_grant(user, ACCT_A, provider="aws")

    rows = scoped.by_dimension(_principal(user), WIDE, "provider")
    assert [r["key"] for r in rows] == ["aws"]


# -------------------------------------------------------------- time bounding

def test_expired_grant_excluded(make_user, make_grant, make_facts):
    make_facts([(ACCT_A, "AmazonEC2", 10)])
    user = make_user("e@chryselys.com")
    make_grant(
        user, ACCT_A,
        valid_from=TODAY - timedelta(days=10),
        valid_until=TODAY - timedelta(days=1),
    )
    assert scoped.series(_principal(user), WIDE) == []


def test_future_grant_excluded(make_user, make_grant, make_facts):
    make_facts([(ACCT_A, "AmazonEC2", 10)])
    user = make_user("f@chryselys.com")
    make_grant(user, ACCT_A, valid_from=TODAY + timedelta(days=1))
    assert scoped.series(_principal(user), WIDE) == []


def test_indefinite_grant_included(make_user, make_grant, make_facts):
    make_facts([(ACCT_A, "AmazonEC2", 10)])
    user = make_user("g@chryselys.com")
    make_grant(user, ACCT_A, valid_until=None)
    assert _total(scoped.series(_principal(user), WIDE)) == 10


def test_revoked_grant_excluded(make_user, make_grant, make_facts):
    make_facts([(ACCT_A, "AmazonEC2", 10)])
    user = make_user("h@chryselys.com")
    make_grant(user, ACCT_A, revoked=True)
    assert scoped.series(_principal(user), WIDE) == []


def test_revocation_takes_effect_immediately(
    make_user, make_grant, make_facts, exec_sql
):
    """Nothing is cached: the predicate evaluates now() per query."""
    make_facts([(ACCT_A, "AmazonEC2", 10)])
    user = make_user("i@chryselys.com")
    gid = make_grant(user, ACCT_A)
    assert _total(scoped.series(_principal(user), WIDE)) == 10

    exec_sql(
        "UPDATE access_grants SET revoked_at = now() WHERE id = %(id)s",
        {"id": gid},
    )
    assert scoped.series(_principal(user), WIDE) == []


# ------------------------------------------------------------- superadmin

def test_superadmin_sees_all(make_user, make_facts):
    make_facts([(ACCT_A, "AmazonEC2", 10), (ACCT_B, "AmazonS3", 20)])
    admin = _principal(make_user("admin@chryselys.com", "superadmin"), "superadmin")

    rows = scoped.by_dimension(admin, WIDE, "account")
    assert {r["key"] for r in rows} == {ACCT_A, ACCT_B}
    assert _total(rows) == 30


# ----------------------------------------------------- injection / allowlists

def test_unknown_dimension_rejected(make_user):
    user = _principal(make_user("j@chryselys.com"))
    with pytest.raises(ValueError):
        scoped.by_dimension(user, WIDE, "account_id; DROP TABLE users--")


def test_unknown_grain_rejected(make_user):
    user = _principal(make_user("k@chryselys.com"))
    with pytest.raises(ValueError):
        scoped.series(user, WIDE, grain="day); DROP TABLE users--")  # type: ignore[arg-type]


def test_unknown_metric_rejected(make_user):
    user = _principal(make_user("l@chryselys.com"))
    bad = Filters(start=WIDE.start, end=WIDE.end, metric="cost; DROP TABLE users--")
    with pytest.raises(ValueError):
        scoped.series(user, bad)


# ------------------------------------------------------------ charge category

def test_tax_and_credits_excluded_by_default(make_user, make_grant, make_facts):
    """Tax and Credit rows skew every per-service comparison (FR-23)."""
    make_facts([(ACCT_A, "AmazonEC2", 10)])
    make_facts([(ACCT_A, "Tax", 3)], charge_category="Tax")
    make_facts([(ACCT_A, "Refund", -2)], charge_category="Credit")

    user = make_user("m@chryselys.com")
    make_grant(user, ACCT_A)

    assert _total(scoped.series(_principal(user), WIDE)) == 10

    inclusive = Filters(start=WIDE.start, end=WIDE.end, include_tax_and_credits=True)
    assert _total(scoped.series(_principal(user), inclusive)) == 11


# -------------------------------------------------------------- dropdown data

def test_visible_accounts_scoped(make_user, make_grant, make_facts, exec_sql):
    """Dropdowns must contain only what the user may see (FR-9)."""
    make_facts([(ACCT_A, "AmazonEC2", 10), (ACCT_B, "AmazonS3", 20)])
    for acct in (ACCT_A, ACCT_B):
        exec_sql(
            """
            INSERT INTO dim_account (provider, account_id, account_name,
                                     created_by, updated_by)
            VALUES ('aws', %(a)s, %(a)s, 'test', 'test')
            """,
            {"a": acct},
        )

    user = make_user("n@chryselys.com")
    make_grant(user, ACCT_A)

    accounts = scoped.visible_accounts(_principal(user))
    assert [a["account_id"] for a in accounts] == [ACCT_A]


def test_visible_services_scoped(make_user, make_grant, make_facts):
    make_facts([(ACCT_A, "AmazonEC2", 10), (ACCT_A, "AmazonS3", 5)])
    user = make_user("o@chryselys.com")
    make_grant(user, ACCT_A, service_name="AmazonEC2")

    assert scoped.visible_services(_principal(user), "aws", ACCT_A) == ["AmazonEC2"]


# ------------------------------------------------------------------ comparison

def test_compare_returns_both_deltas(make_user, make_grant, make_facts):
    """Percent alone is noise on small numbers, so both are required."""
    make_facts([(ACCT_A, "AmazonEC2", 6)], on=TODAY - timedelta(days=1))
    make_facts([(ACCT_A, "AmazonEC2", 2)], on=TODAY - timedelta(days=10))

    user = make_user("p@chryselys.com")
    make_grant(user, ACCT_A)

    current = Filters(start=TODAY - timedelta(days=3), end=TODAY)
    previous = Filters(start=TODAY - timedelta(days=12), end=TODAY - timedelta(days=9))

    rows = scoped.compare(_principal(user), current, previous, "service")
    row = next(r for r in rows if r["key"] == "AmazonEC2")
    assert row["current"] == 6
    assert row["previous"] == 2
    assert row["delta_abs"] == 4
    assert row["delta_pct"] == 200.0


def test_compare_handles_zero_previous(make_user, make_grant, make_facts):
    """A new service has no previous value; percent must be None, not a crash."""
    make_facts([(ACCT_A, "AmazonEC2", 5)], on=TODAY - timedelta(days=1))
    user = make_user("q@chryselys.com")
    make_grant(user, ACCT_A)

    current = Filters(start=TODAY - timedelta(days=3), end=TODAY)
    previous = Filters(start=TODAY - timedelta(days=20), end=TODAY - timedelta(days=15))

    row = scoped.compare(_principal(user), current, previous, "service")[0]
    assert row["previous"] == 0
    assert row["delta_pct"] is None


# ----------------------------------------------------------------- grain

@pytest.mark.parametrize("grain", ["day", "week", "month", "quarter", "year"])
def test_all_grains_work(make_user, make_grant, make_facts, grain):
    make_facts([(ACCT_A, "AmazonEC2", 10)])
    user = make_user(f"r-{grain}@chryselys.com")
    make_grant(user, ACCT_A)

    rows = scoped.series(_principal(user), WIDE, grain=grain)  # type: ignore[arg-type]
    assert _total(rows) == 10
