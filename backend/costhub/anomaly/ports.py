"""The detection port."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Literal, Protocol, Sequence

Kind = Literal["step", "spike", "creep"]

Point = tuple[date, Decimal]


@dataclass(frozen=True)
class Finding:
    """One detected anomaly, carrying its own explanation.

    baseline/observed/delta are part of the finding rather than derived
    later: the output of this system is "you may be wasting money", and
    that claim has to arrive with its evidence attached.
    """

    detected_for_date: date
    kind: Kind
    baseline_value: Decimal
    observed_value: Decimal
    delta_abs: Decimal
    delta_pct: float | None
    score: float
    method: str


class Detector(Protocol):
    name: str

    def detect(self, series: Sequence[Point]) -> list[Finding]:
        """Findings for one account/service series, oldest point first."""
        ...
