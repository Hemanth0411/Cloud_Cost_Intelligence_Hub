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
    """Percent must be None rather than infinity when there is nothing
    to compare against.

    This used to assert that a zero-baseline series PRODUCES a finding,
    using that as the vehicle for checking the percent. That behaviour
    was deliberately removed -- see
    `test_a_zero_baseline_never_passes_by_default` -- because zero-filling
    sparse series turned it into a false-positive generator. The intent
    survives, tested against the function that owns it.
    """
    from costhub.anomaly.mad import _pct

    assert _pct(Decimal("25"), Decimal("0")) is None
    assert _pct(Decimal("30"), Decimal("10")) == 200.0
    assert _pct(Decimal("5"), Decimal("10")) == -50.0


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


# ------------------------------- sparse series (regression, finding B)

def sparse(n_days: int, every: int, value: float) -> list[float]:
    """A legitimately intermittent series, zero-filled like _densify does.

    AWS Support, Route 53 hosted zones, Marketplace monthly charges and
    weekly batch jobs all look like this once densified.

    Charges are anchored to the END of the series, not the start: a
    charge has to fall inside `scan_days` to be scored at all. My first
    attempt at these tests put them on days 0/30/60/90 of 120, so
    nothing was ever examined and the tests passed against the bug.
    """
    return [
        value if (n_days - 1 - i) % every == 0 else 0.0
        for i in range(n_days)
    ]


def test_monthly_charge_on_a_sparse_series_is_not_an_anomaly():
    """The regression that densification introduced.

    Zero-filling made the injected zeros the whole baseline, so the
    median was 0; `_score`'s mad==0/baseline==0 branch then returned
    EXACTLY z_threshold while `_flag_days` tests `>=`. Every ordinary
    charge on a sparse series flagged -- AWS Support at $500/month was
    reported as a spike on every scan day.
    """
    det = D(exclude_recent_days=0, scan_days=10)
    found = det.detect(series(sparse(120, 30, 500.0)))
    assert found == [], [(f.kind, str(f.baseline_value), str(f.observed_value))
                         for f in found]


def test_thrice_weekly_batch_job_is_not_an_anomaly():
    det = D(exclude_recent_days=0, scan_days=10)
    assert det.detect(series(sparse(120, 2, 30.0))) == []


def test_a_zero_baseline_never_passes_by_default():
    """No baseline means no anomaly: a first-ever charge is a new
    service, not a spike. The old code returned exactly the threshold,
    which `>=` then accepted."""
    det = D(exclude_recent_days=0, scan_days=5)
    found = det.detect(series(flat(50, 0.0) + [25.0]))
    assert found == []


def test_a_real_step_on_a_sparse_series_is_still_caught():
    """The fix must not simply mute sparse series entirely."""
    det = D(exclude_recent_days=0, scan_days=10)
    # Weekday-shaped series that genuinely trebles and stays there.
    base = [0.0 if i % 7 in (5, 6) else 20.0 for i in range(60)]
    raised = [0.0 if i % 7 in (5, 6) else 60.0 for i in range(14)]
    found = det.detect(series(base + raised))
    assert found, "a real sustained rise must still be detected"


# ------------------------------------------- sparse series (regression)

def _sparse_window(active_value: str, active_days: int, total: int = 14):
    """A densified sparse series: some active days, the rest zero-filled."""
    from decimal import Decimal

    vals = [Decimal(active_value)] * active_days + [Decimal("0")] * (total - active_days)
    return vals


def test_a_burst_on_a_sparse_series_is_flagged():
    """The regression this exists for, measured on real data.

    AWS Glue billed about $0.03 on a typical active day and then
    $224.05. It scored ZERO, because 12 active days out of 28 is enough
    to put the densified median on zero -- so baseline and MAD were both
    0 and the series was unflaggable at any amount.
    """
    from decimal import Decimal

    detector = MadDetector()
    window = _sparse_window("0.03", active_days=6)

    score = detector._score(Decimal("224.05"), Decimal("0"), window)

    assert score > detector.z_threshold, (
        "a 7000x charge against a service's own active-day median must flag"
    )


def test_a_recurring_charge_on_a_sparse_series_is_not_flagged():
    """The behaviour the previous `return 0.0` was protecting.

    AWS Support at $500/month is one big charge and twenty-nine zero
    days. Against a densified median of zero every month's charge looked
    like a spike, and it was reported on every single scan. It must stay
    unflagged.
    """
    from decimal import Decimal

    detector = MadDetector()
    window = _sparse_window("500", active_days=1)

    assert detector._score(Decimal("500"), Decimal("0"), window) == 0.0


def test_a_first_ever_charge_is_not_an_anomaly():
    """A new service is a different event with a different message."""
    from decimal import Decimal

    detector = MadDetector()

    assert detector._score(Decimal("50"), Decimal("0"), [Decimal("0")] * 14) == 0.0


def test_a_recurring_charge_that_doubles_is_flagged():
    """The case that proves the sparse path still discriminates.

    Same shape as AWS Support, but the charge itself jumped. Scoring
    against active days means this flags while the steady version does
    not -- which is the whole point of not returning a flat 0.0.
    """
    from decimal import Decimal

    detector = MadDetector()
    window = _sparse_window("500", active_days=3)

    score = detector._score(Decimal("1000"), Decimal("0"), window)

    assert score > detector.z_threshold
