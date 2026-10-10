"""Generated cost data, so the backend can be built without AWS access.

Dev only. This is NOT the demo's showcase data -- that lives in the
frontend as fixtures (see docs/06-frontend.md). Two different jobs, and
conflating them is how a demo ends up proving nothing.

The series carry three planted anomalies, one of each kind, so the
detector has something real to find:

  step   something switched on and stayed on  <- the common real case
  spike  one bad day
  creep  a slow upward drift
"""
from __future__ import annotations

import random
from datetime import date, timedelta
from decimal import Decimal
from typing import Iterator

from costhub.connections.credentials import Connection
from costhub.ingest.ports import CostRow

# Shapes chosen so the mix looks like a real small account: a couple of
# dominant services and a long tail.
SERVICES: list[tuple[str, float, str]] = [
    ("AmazonEC2", 12.0, "us-east-1"),
    ("AmazonS3", 3.5, "us-east-1"),
    ("AWSGlue", 8.0, "us-east-1"),
    ("AmazonAthena", 2.0, "us-east-1"),
    ("AWSLambda", 0.4, "us-east-1"),
    ("AmazonRDS", 6.0, "us-east-1"),
    ("AmazonCloudWatch", 0.9, "us-east-1"),
]

PLANTED = {
    # service        kind     starts N days ago   multiplier
    "AWSGlue": ("step", 12, 3.2),
    "AmazonAthena": ("spike", 5, 9.0),
    "AmazonRDS": ("creep", 25, 2.4),
}


class DevSeedSource:
    """A CostSource that invents plausible data."""

    name = "dev_seed"

    def __init__(self, conn: Connection, *, seed: int | None = None) -> None:
        self.conn = conn
        # Deterministic per account, so re-running produces the same series
        # and the upsert path is genuinely exercised.
        self.rng = random.Random(seed if seed is not None else hash(conn.account_id) & 0xFFFF)

    def fetch(self, *, account_id: str, start: date, end: date) -> Iterator[CostRow]:
        today = date.today()
        day = start
        while day < end:
            days_ago = (today - day).days
            for service, base, region in SERVICES:
                amount = self._amount(service, base, days_ago)
                if amount <= 0:
                    continue
                yield CostRow(
                    provider=self.conn.provider,
                    account_id=account_id,
                    service_name=service,
                    region=region,
                    charge_category="Usage",
                    usage_date=day,
                    billed_cost=amount,
                    effective_cost=amount,
                    currency="USD",
                )
            day += timedelta(days=1)

    def _amount(self, service: str, base: float, days_ago: int) -> Decimal:
        # Weekday/weekend rhythm plus noise -- a flat line would make the
        # anomaly detector look better than it is.
        value = base * self.rng.uniform(0.85, 1.15)

        planted = PLANTED.get(service)
        if planted:
            kind, starts_days_ago, factor = planted
            if kind == "step" and days_ago <= starts_days_ago:
                value *= factor
            elif kind == "spike" and days_ago == starts_days_ago:
                value *= factor
            elif kind == "creep" and days_ago <= starts_days_ago:
                progress = 1 - (days_ago / starts_days_ago)
                value *= 1 + (factor - 1) * progress

        return Decimal(f"{value:.6f}")


def source_factory(conn: Connection) -> DevSeedSource:
    return DevSeedSource(conn)


def planted_summary() -> str:
    lines = ["planted anomalies:"]
    for service, (kind, days, factor) in PLANTED.items():
        lines.append(f"  {service:<18} {kind:<6} from {days}d ago, x{factor}")
    return "\n".join(lines)
