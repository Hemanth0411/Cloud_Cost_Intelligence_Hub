"""Alert types and the delivery port."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal, Protocol

RuleType = Literal["threshold", "forecast", "digest", "anomaly"]
Frequency = Literal["immediate", "daily", "weekly", "monthly"]

FREQUENCY_HOURS: dict[str, float] = {
    "immediate": 0.0,
    "daily": 23.0,      # a little under 24, so a daily job never skips a day
    "weekly": 167.0,
    "monthly": 719.0,
}


@dataclass(frozen=True)
class Rule:
    id: str
    name: str
    owner_user_id: str
    owner_email: str
    owner_role: str
    type: RuleType
    scope_provider: str | None
    scope_account: str | None
    scope_service: str | None
    metric: str
    comparator: str | None
    threshold_value: Decimal | None
    window_days: int
    frequency: Frequency
    channels: list[str]

    @property
    def owner_is_superadmin(self) -> bool:
        return self.owner_role == "superadmin"


@dataclass(frozen=True)
class Event:
    """A rule that fired, with the numbers that made it fire."""

    rule: Rule
    observed_value: Decimal | None
    expected_value: Decimal | None
    subject: str
    body: str
    payload: dict[str, Any] = field(default_factory=dict)
    fired_for: date | None = None


@dataclass
class Delivery:
    channel: str
    sent: bool
    error: str | None = None


class Notifier(Protocol):
    channel: str

    def send(self, event: Event, *, recipients: list[str]) -> Delivery:
        """Deliver one event. Must not raise -- return a failed Delivery."""
        ...


def due(rule: Rule, last_fired_at: datetime | None, now: datetime) -> bool:
    """Has enough time passed since this rule last fired?

    Without this a daily job re-sends every still-true threshold every
    run, and the feed becomes noise within a week.

    `now` must come from the SAME clock that wrote `last_fired_at` --
    i.e. the database. Measured skew between this machine and Neon was
    +4.1s, which silently made just-fired `immediate` rules "not due".
    `runner.run()` therefore reads `now()` from Postgres rather than the
    local clock.
    """
    # "immediate" means do not throttle at all. Expressing that as a
    # 0-hour gap turned a sub-second clock difference into a skipped run.
    if rule.frequency == "immediate":
        return True
    if last_fired_at is None:
        return True
    gap = FREQUENCY_HOURS.get(rule.frequency, 23.0)
    return (now - last_fired_at).total_seconds() >= gap * 3600
