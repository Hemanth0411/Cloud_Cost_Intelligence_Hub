"""Detector tests.

Pure functions over synthetic series -- no database, so these run in
milliseconds and can be exhaustive. The false-positive cases matter as
much as the true ones: a detector that cries wolf gets ignored, which is
indistinguishable from not having one.
"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest

from costhub.anomaly.mad import MadDetector

START = date(2026, 6, 1)
D = MadDetector  # shorthand


def series(values: list[float], start: date = START) -> list[tuple[date, Decimal]]:
    return [
        (start + timedelta(days=i), Decimal(str(v))) for i, v in enumerate(values)
    ]


def flat(n: int, value: float = 10.0) -> list[float]:
    return [value] * n


def noisy(n: int, value: float = 10.0) -> list[float]:
    """Deterministic jitter around a level, like a real service."""
    return [value + (0.4 if i % 2 else -0.4) + (0.2 if i % 3 == 0 else 0)
            for i in range(n)]


# --------------------------------------------------------------- quiet data

def test_flat_series_has_no_findings():
    det = D(exclude_recent_days=0)
    assert det.detect(series(flat(60))) == []


def test_noisy_series_has_no_findings():
    """Ordinary day-to-day variation must not flag."""
    det = D(exclude_recent_days=0)
    assert det.detect(series(noisy(60))) == []


def test_weekly_rhythm_has_no_findings():
    """Weekday/weekend patterns are normal in cloud spend."""
    vals = [4.0 if i % 7 in (5, 6) else 12.0 for i in range(70)]
    det = D(exclude_recent_days=0)
    assert det.detect(series(vals)) == []


def test_too_little_history_returns_nothing():
    det = D(exclude_recent_days=0)
    assert det.detect(series(flat(5))) == []


def test_cost_drop_is_not_an_anomaly():
    """We are looking for money being spent, not saved."""
    det = D(exclude_recent_days=0)
    assert det.detect(series(flat(40) + flat(10, 1.0))) == []


# ------------------------------------------------------------------- spike

def test_single_day_spike():
    det = D(exclude_recent_days=0, scan_days=10)
    found = det.detect(series(noisy(50) + [90.0] + noisy(3)))
    assert len(found) == 1
    assert found[0].kind == "spike"
    assert found[0].observed_value == Decimal("90.0")


def test_spike_carries_its_explanation():
    det = D(exclude_recent_days=0, scan_days=10)
    f = det.detect(series(noisy(50) + [90.0] + noisy(3)))[0]
    assert f.baseline_value > 0
    assert f.delta_abs == f.observed_value - f.baseline_value
    assert f.delta_pct and f.delta_pct > 100
    assert f.score >= 3.5
    assert f.method == "mad"


# -------------------------------------------------------------------- step

def test_sustained_shift_is_a_step_not_a_spike():
    """The case a naive spike detector misses, and the expensive one."""
    det = D(exclude_recent_days=0, scan_days=10)
    found = det.detect(series(noisy(45) + flat(8, 40.0)))
    assert len(found) == 1
    assert found[0].kind == "step"


def test_step_reports_once_not_once_per_day():
    """A step that persists must not generate one finding per day."""
    det = D(exclude_recent_days=0, scan_days=14)
    found = det.detect(series(noisy(45) + flat(14, 40.0)))
    assert len(found) == 1


def test_step_is_dated_at_the_day_it_began():
    det = D(exclude_recent_days=0, scan_days=10)
    points = series(noisy(45) + flat(8, 40.0))
    expected = points[45][0]
    assert det.detect(points)[0].detected_for_date == expected


def test_short_run_below_min_step_days_is_a_spike():
    det = D(exclude_recent_days=0, scan_days=10, min_step_days=4)
    found = det.detect(series(noisy(48) + flat(2, 40.0) + noisy(2)))
    assert found and found[0].kind == "spike"


# ------------------------------------------------------------------- creep

def test_gradual_drift_is_creep():
    """No single day trips the threshold; the level has still moved.

    The rise per day has to stay inside the noise, otherwise individual
    days legitimately score as a step -- which is what a steep ramp *is*.
    Creep is specifically the shape that slips under a per-day test.
    """
    ramp = [10 + i * 0.32 + (0.4 if i % 2 else -0.4) for i in range(26)]
    det = D(exclude_recent_days=0, scan_days=7, creep_ratio=1.3)
    found = det.detect(series(noisy(34) + ramp))
    assert found, "a 10 -> 18 drift over 26 days should be caught"
    assert found[0].kind == "creep"
    assert found[0].delta_pct and found[0].delta_pct > 20


def test_a_steep_ramp_is_still_a_creep():
    """Steepness does not decide the kind -- shape does.

    The operator's next action is what matters: a jump to a new plateau
    means "something was switched on, go find it"; a continuing climb
    means "something is growing". A steep ramp is still climbing, so it
    is a creep however sharply it rises.
    """
    det = D(exclude_recent_days=0, scan_days=10)
    found = det.detect(series(noisy(40) + [10 + i * 1.1 for i in range(10)]))
    assert found and found[0].kind == "creep"


def test_creep_not_reported_when_a_step_already_explains_it():
    det = D(exclude_recent_days=0, scan_days=10)
    found = det.detect(series(noisy(45) + flat(8, 40.0)))
    assert [f.kind for f in found] == ["step"]


# ------------------------------------------------------------------- noise

def test_tiny_absolute_change_is_ignored():
    """$0.01 -> $0.05 is +400% and completely irrelevant."""
    det = D(exclude_recent_days=0, scan_days=10, min_abs_delta=Decimal("1.00"))
    assert det.detect(series(flat(50, 0.01) + [0.05])) == []


def test_flat_zero_mad_series_still_detects_a_real_jump():
    """MAD is 0 on a perfectly flat series; the score must not blow up."""
    det = D(exclude_recent_days=0, scan_days=5)
    found = det.detect(series(flat(50, 10.0) + [60.0]))
    assert len(found) == 1
    assert found[0].score == pytest.approx(found[0].score)  # finite
    assert found[0].score < 1e6


def test_zero_baseline_gives_null_percent_not_infinity():
    det = D(exclude_recent_days=0, scan_days=5, min_abs_delta=Decimal("1.00"))
    found = det.detect(series(flat(50, 0.0) + [25.0]))
    assert len(found) == 1
    assert found[0].delta_pct is None


# ----------------------------------------------------------- recency guard

def test_recent_unfinalised_days_are_excluded():
    """Scoring days AWS is still restating produces a daily false alarm."""
    quiet = D(exclude_recent_days=2, scan_days=10)
    loud = D(exclude_recent_days=0, scan_days=10)
    points = series(noisy(50) + [90.0, 95.0])

    assert quiet.detect(points) == []
    assert loud.detect(points) != []


def test_detect_is_order_independent():
    det = D(exclude_recent_days=0, scan_days=10)
    points = series(noisy(50) + [90.0] + noisy(3))
    assert det.detect(points) == det.detect(list(reversed(points)))


# ------------------------------------------- one phenomenon, one finding

def test_steep_ramp_reports_once_not_four_times():
    """A ramp flags days intermittently, because the trailing median
    rises with it. Strict consecutive-only grouping then emits a separate
    finding every time the gap reopens -- four alerts for one cause,
    which is how a feed gets ignored."""
    det = D(exclude_recent_days=0, scan_days=20)
    found = det.detect(series(noisy(40) + [10 + i * 1.1 for i in range(18)]))
    assert len(found) == 1, [(f.kind, str(f.detected_for_date)) for f in found]


def test_long_rising_span_is_classified_creep():
    """A sustained rise over many days is a creep, not a step: a step is
    a jump to a new plateau, a creep keeps climbing."""
    det = D(exclude_recent_days=0, scan_days=20)
    f = det.detect(series(noisy(40) + [10 + i * 1.1 for i in range(18)]))[0]
    assert f.kind == "creep"


def test_plateau_after_jump_is_still_a_step():
    """The converse: jump then hold is a step even over a long span."""
    det = D(exclude_recent_days=0, scan_days=20)
    f = det.detect(series(noisy(40) + flat(18, 40.0)))[0]
    assert f.kind == "step"
