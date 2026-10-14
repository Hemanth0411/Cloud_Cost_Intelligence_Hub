"""Clamps for the two columns `anomaly_findings` persists as numeric.

Both live here rather than beside the arithmetic because they are not
statistics -- they are what the schema can hold. `score` and `delta_pct`
are each `numeric(10,4)`, and a sparse series divides by an active-day
MAD of a fraction of a cent, so both can reach the millions on perfectly
real data.

That is not a hypothetical. Unclamped, a single overflowing finding
raised "numeric field overflow" from inside the per-series loop and took
the WHOLE scan down, because the insert happens there rather than at the
end -- so one absurd percentage cost every other finding in the run.

Clamping rather than widening the columns is deliberate: past a certain
point "definitely anomalous" is the entire content of the number, and
ordering among absurd values is not information worth a migration.
"""
from __future__ import annotations

from decimal import Decimal

SCORE_CEILING = 9999.0
PCT_CEILING = 99999.99


def clamp_score(score: float) -> float:
    if score != score:  # NaN, from 0/0 in a degenerate window
        return 0.0
    return max(-SCORE_CEILING, min(SCORE_CEILING, score))


def pct(observed: Decimal, baseline: Decimal) -> float | None:
    """None, not infinity, when there is nothing to compare against.

    Beyond about 100,000% the number has stopped being informative, and
    the UI already renders anything that large as new-service territory.
    """
    if baseline == 0:
        return None
    value = round(float((observed - baseline) / baseline * 100), 2)
    return max(-PCT_CEILING, min(PCT_CEILING, value))
