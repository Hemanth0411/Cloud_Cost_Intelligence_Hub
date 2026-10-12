"""Gap-filling, which the detector's index arithmetic depends on.

`_densify` exists because `anomaly/mad.py` treats a series as evenly
spaced -- position i is "i days ago". A day with no cost row simply did
not appear, so a service billed on weekdays only had its index silently
compressed and the detector's "sustained for 3 days" meant "3 billing
events, maybe a fortnight apart".

This is the pure half of that fix and needs no database. It is also the
part that went wrong twice, both times by inventing data:
zero-filling a sparse series made zero the baseline (fixed in
`mad._score`), and zero-filling past a series' last day turned a deleted
service into a cliff.
"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from costhub.query.scoped import _densify

START = date(2026, 3, 1)
END = date(2026, 3, 10)


def _row(day: date, cost: str, service: str = "AWSGlue") -> dict:
    return {
        "provider": "aws",
        "account_id": "111122223333",
        "service_name": service,
        "usage_date": day,
        "cost": Decimal(cost),
    }


def _costs(rows: list[dict], service: str = "AWSGlue") -> list[Decimal]:
    return [r["cost"] for r in rows if r["service_name"] == service]


def _days(rows: list[dict], service: str = "AWSGlue") -> list[date]:
    return [r["usage_date"] for r in rows if r["service_name"] == service]


def test_interior_gaps_are_filled_with_zero():
    rows = _densify(
        [_row(START, "10"), _row(START + timedelta(days=4), "10")],
        start=START,
        end=END,
    )
    assert _costs(rows) == [Decimal("10"), *[Decimal("0")] * 3, Decimal("10")]
    assert _days(rows) == [START + timedelta(days=i) for i in range(5)]


def test_days_come_out_consecutive_so_index_means_days():
    """The property the detector actually relies on."""
    rows = _densify(
        [_row(START + timedelta(days=i), "5") for i in (0, 2, 6, 9)],
        start=START,
        end=END,
    )
    days = _days(rows)
    assert all(b - a == timedelta(days=1) for a, b in zip(days, days[1:]))


def test_nothing_is_invented_before_a_series_begins():
    """A service that started mid-window has no history, not a history of 0.

    Filling backwards would drag the baseline to nothing and make the
    service's first real charge look like a step change.
    """
    first = START + timedelta(days=6)
    rows = _densify([_row(first, "10")], start=START, end=END)
    assert _days(rows) == [first]


def test_nothing_is_invented_after_a_series_ends():
    """The same argument at the other end, and it matters more.

    A service switched off on the 3rd used to acquire seven real-looking
    $0 days. The detector reads that as a drop to zero -- a false
    anomaly -- and the zeroes also pull the median down, so the next
    genuine charge reads as a step up. A gap at the end of a window is
    missing data, not a measurement.
    """
    last = START + timedelta(days=2)
    rows = _densify(
        [_row(START, "10"), _row(last, "10")], start=START, end=END
    )
    assert _days(rows) == [START, START + timedelta(days=1), last]
    assert _costs(rows) == [Decimal("10"), Decimal("0"), Decimal("10")]


def test_each_series_is_filled_independently():
    """One service's lifetime must not define another's."""
    rows = _densify(
        [
            _row(START, "10", "AWSGlue"),
            _row(END, "7", "AmazonS3"),
        ],
        start=START,
        end=END,
    )
    assert _days(rows, "AWSGlue") == [START]
    assert _days(rows, "AmazonS3") == [END]


def test_a_single_day_series_stays_one_day():
    rows = _densify([_row(START, "10")], start=START, end=START)
    assert _costs(rows) == [Decimal("10")]


def test_no_rows_in_means_no_rows_out():
    assert _densify([], start=START, end=END) == []


def test_costs_stay_decimal():
    """Money never becomes a float on this path."""
    rows = _densify(
        [_row(START, "10"), _row(START + timedelta(days=2), "10")],
        start=START,
        end=END,
    )
    assert all(isinstance(r["cost"], Decimal) for r in rows)
