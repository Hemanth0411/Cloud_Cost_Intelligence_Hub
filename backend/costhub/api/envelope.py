"""The response envelope.

Every cost response states which measure it used and how fresh the data
is. An unlabelled cost chart gets disputed: `billed_cost` reconciles to
the invoice, `effective_cost` is amortised, and they differ.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any, Generic, TypeVar

from pydantic import BaseModel, Field

from costhub.db import fetch_one

T = TypeVar("T")


class Envelope(BaseModel, Generic[T]):
    data: list[T]
    as_of: datetime | None = Field(
        None, description="When cost data was last ingested successfully."
    )
    metric: str | None = Field(None, description="effective_cost | billed_cost")
    currency: str = "USD"
    partial_period: bool = Field(
        False,
        description=(
            "True when the requested range includes an incomplete period. "
            "Comparing a month-to-date against a full month otherwise reads "
            "as a large false drop."
        ),
    )
    row_count: int = 0


def as_of() -> datetime | None:
    """Freshness: the last successful ingest.

    Cost data lags 8-24h and finalises monthly, so this is never 'now'
    and the UI must not imply it is.
    """
    row = fetch_one(
        """
        SELECT max(finished_at) AS t
        FROM ingest_runs
        WHERE status = 'success'
        """
    )
    return row["t"] if row else None


def is_partial(end: date) -> bool:
    """Does the window run past the last day we have complete data for?

    Yesterday is the most recent day worth trusting; today is always
    partial, and the previous day is often still being restated.
    """
    today = datetime.now(timezone.utc).date()
    return end >= today


def wrap(
    rows: list[Any],
    *,
    metric: str | None = None,
    end: date | None = None,
    currency: str = "USD",
) -> dict:
    return {
        "data": rows,
        "as_of": as_of(),
        "metric": metric,
        "currency": currency,
        "partial_period": is_partial(end) if end else False,
        "row_count": len(rows),
    }
