"""The ingest port.

One protocol, several adapters. Swapping mock data for Cost Explorer --
or Cost Explorer for a FOCUS export, or adding Azure -- is a new class
here and a one-line change in runner.py. Nothing downstream moves.

Field names follow FOCUS deliberately, so the FOCUS adapter needs no
translation layer when it arrives.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Iterable, Protocol


@dataclass(frozen=True)
class CostRow:
    """One day of cost for one account/service/region/charge-category."""

    provider: str
    account_id: str
    service_name: str
    usage_date: date
    billed_cost: Decimal
    effective_cost: Decimal
    currency: str
    region: str = ""
    charge_category: str = "Usage"


class CostSource(Protocol):
    """Anything that can produce CostRows for a period."""

    name: str

    def fetch(
        self, *, account_id: str, start: date, end: date
    ) -> Iterable[CostRow]:
        """Rows for [start, end). Implementations must be re-runnable:
        the same call twice must produce the same rows, because cost data
        is restated as it finalizes and we re-fetch recent days."""
        ...
