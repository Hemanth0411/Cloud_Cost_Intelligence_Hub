"""Rolling median + median absolute deviation.

Why not mean and standard deviation: the outliers we are hunting would
inflate both, so a real anomaly partly hides itself. The median and MAD
barely move, which is the point.

Why not Prophet or an ML model: the output of this is "you may be wasting
money", and that has to be explainable. "6.2 MADs above the 28-day median,
sustained for 9 days" is a sentence someone can argue with. A model score
is not. (Prophet is also a painful dependency inside a Lambda zip.)

Three shapes, in the order that matters:

  step   something was switched on and left on -- the common, expensive
         case, and the one a naive spike detector misses entirely
  spike  one bad day
  creep  a slow drift that never trips a single-day threshold
"""
from __future__ import annotations

import statistics
from decimal import Decimal
from typing import Sequence

from costhub.anomaly.ports import Finding, Point
from costhub.anomaly.ceilings import clamp_score, pct

# 0.6745 rescales MAD so the score reads like a standard deviation, which
# makes 3.5 the conventional cutoff for a "modified z-score".
MAD_TO_SIGMA = Decimal("0.6745")


# `anomaly_findings.score` is numeric(10,4), so anything from 10^6 up
# fails the INSERT with "numeric field overflow" -- which took the whole
# scan down rather than skipping one finding.
#
class MadDetector:
    name = "mad"

    def __init__(
        self,
        *,
        window: int = 28,
        scan_days: int = 7,
        exclude_recent_days: int = 2,
        z_threshold: float = 3.5,
        min_abs_delta: Decimal = Decimal("1.00"),
        min_rel_delta: float = 0.35,
        min_step_days: int = 3,
        creep_ratio: float = 1.5,
        min_history: int = 14,
        merge_gap_days: int = 3,
        climb_ratio: float = 1.25,
    ) -> None:
        self.window = window
        self.scan_days = scan_days
        # Cost data is restated for a day or two after the fact. Scoring
        # unfinalised days produces an anomaly every single morning.
        self.exclude_recent_days = exclude_recent_days
        self.z_threshold = z_threshold
        # A service that went from $0.01 to $0.05 is +400% and irrelevant.
        self.min_abs_delta = min_abs_delta
        self.min_rel_delta = min_rel_delta
        self.min_step_days = min_step_days
        self.creep_ratio = creep_ratio
        self.min_history = min_history
        # A rising series flags intermittently, because the trailing median
        # climbs with it. Strict consecutive-only grouping then emits a new
        # finding every time the gap reopens -- several alerts for one cause.
        self.merge_gap_days = merge_gap_days
        # Within a run: still climbing (creep) or jumped and held (step)?
        self.climb_ratio = climb_ratio

    # ------------------------------------------------------------------

    def detect(self, series: Sequence[Point]) -> list[Finding]:
        points = sorted(series, key=lambda p: p[0])
        if self.exclude_recent_days:
            points = points[: -self.exclude_recent_days] or []
        if len(points) < self.min_history:
            return []

        flagged = self._flag_days(points)
        findings = self._group(points, flagged)
        if not findings:
            creep = self._creep(points)
            if creep:
                findings.append(creep)
        return findings

    # ------------------------------------------------------------------

    def _flag_days(self, points: Sequence[Point]) -> dict[int, tuple[Decimal, float]]:
        """Score each candidate day against the window *preceding* it.

        Preceding only -- including the day under test in its own baseline
        drags the median toward it and hides the anomaly.
        """
        out: dict[int, tuple[Decimal, float]] = {}
        first = max(self.min_history, len(points) - self.scan_days)

        for i in range(first, len(points)):
            window = [v for _, v in points[max(0, i - self.window): i]]
            if len(window) < self.min_history:
                continue

            observed = points[i][1]
            baseline = Decimal(str(statistics.median(window)))
            delta = observed - baseline

            if delta <= 0 or abs(delta) < self.min_abs_delta:
                continue  # drops only, or noise-level rises

            score = self._score(observed, baseline, window)
            if score >= self.z_threshold:
                out[i] = (baseline, score)
        return out

    def _score(
        self, observed: Decimal, baseline: Decimal, window: list[Decimal]
    ) -> float:
        mad = Decimal(str(statistics.median([abs(v - baseline) for v in window])))

        if mad > 0:
            return clamp_score(float(MAD_TO_SIGMA * (observed - baseline) / mad))

        # A perfectly flat series has MAD 0, which would make every score
        # infinite. Fall back to relative change, expressed on the same
        # scale so one threshold still works.
        if baseline > 0:
            rel = float((observed - baseline) / baseline)
            return clamp_score(self.z_threshold * (rel / self.min_rel_delta)) if rel > 0 else 0.0

        # baseline == 0 AND mad == 0: a SPARSE series does this as soon
        # as it is densified -- billed on 12 of 28 days, the median lands
        # on zero however large the charges are. So score against the
        # series' OWN ACTIVE DAYS: a gap is missing data, not a
        # measurement of nothing.
        #
        #   Glue        active median ~$0.03, observed $224  -> flags
        #   AWS Support active median  $500,  observed $500  -> does not
        #   first charge no active days at all               -> does not
        #
        # Both earlier answers here were wrong in opposite directions;
        # CONTEXT.md "The anomaly detector" has the measurements.
        active = [v for v in window if v > 0]
        if not active:
            # A genuinely first-ever charge is a NEW SERVICE, not an
            # anomaly. Detecting those is a separate feature with a
            # different message.
            return 0.0

        active_baseline = Decimal(str(statistics.median(active)))
        active_mad = Decimal(
            str(statistics.median([abs(v - active_baseline) for v in active]))
        )
        if active_mad > 0:
            return clamp_score(float(MAD_TO_SIGMA * (observed - active_baseline) / active_mad))
        if active_baseline > 0:
            rel = float((observed - active_baseline) / active_baseline)
            return clamp_score(self.z_threshold * (rel / self.min_rel_delta)) if rel > 0 else 0.0
        return 0.0

    def _group(
        self, points: Sequence[Point], flagged: dict[int, tuple[Decimal, float]]
    ) -> list[Finding]:
        """Collapse consecutive flagged days into one finding.

        Without this a step change reports once per day for as long as it
        persists, which trains people to ignore the feed.
        """
        if not flagged:
            return []

        findings: list[Finding] = []
        indices = sorted(flagged)
        run: list[int] = [indices[0]]

        for idx in indices[1:]:
            # Tolerate small gaps, so one rising phenomenon stays one finding.
            if idx - run[-1] <= self.merge_gap_days:
                run.append(idx)
            else:
                findings.append(self._from_run(points, flagged, run))
                run = [idx]
        findings.append(self._from_run(points, flagged, run))
        return findings

    def _classify(self, points: Sequence[Point], run: list[int]) -> str:
        """What shape is this?

        Steepness is not the question -- the operator's next action is.
        A jump to a new plateau means "something was switched on, go find
        it". A continuing climb means "something is growing". So compare
        the start of the run against its end.
        """
        span = run[-1] - run[0] + 1
        if span < self.min_step_days:
            return "spike"

        values = [points[i][1] for i in range(run[0], run[-1] + 1)]
        third = max(1, len(values) // 3)
        early = Decimal(str(statistics.median(values[:third])))
        late = Decimal(str(statistics.median(values[-third:])))

        if early > 0 and float(late / early) >= self.climb_ratio:
            return "creep"
        return "step"

    def _from_run(
        self,
        points: Sequence[Point],
        flagged: dict[int, tuple[Decimal, float]],
        run: list[int],
    ) -> Finding:
        # Date the finding at the day the change began, not the latest day
        # it is still true -- that is what someone will go looking for.
        start = run[0]
        baseline, _ = flagged[start]
        peak = max(run, key=lambda i: flagged[i][1])
        observed = max(points[i][1] for i in run)

        return Finding(
            detected_for_date=points[start][0],
            kind=self._classify(points, run),  # type: ignore[arg-type]
            baseline_value=baseline,
            observed_value=observed,
            delta_abs=observed - baseline,
            delta_pct=pct(observed, baseline),
            score=round(flagged[peak][1], 4),
            method=self.name,
        )

    def _creep(self, points: Sequence[Point]) -> Finding | None:
        """A drift no single day trips.

        Compare the recent block against the block before it. Nothing here
        is an outlier; the level has simply moved.
        """
        block = max(self.min_step_days, self.scan_days)
        if len(points) < block * 2 + self.min_history:
            return None

        recent = [v for _, v in points[-block:]]
        prior = [v for _, v in points[-(block + self.window): -block]]
        if not prior:
            return None

        now = Decimal(str(statistics.median(recent)))
        was = Decimal(str(statistics.median(prior)))

        if was <= 0 or now - was < self.min_abs_delta:
            return None
        if float(now / was) < self.creep_ratio:
            return None

        return Finding(
            detected_for_date=points[-block][0],
            kind="creep",
            baseline_value=was,
            observed_value=now,
            delta_abs=now - was,
            delta_pct=pct(now, was),
            score=round(float(now / was), 4),
            method=self.name,
        )
