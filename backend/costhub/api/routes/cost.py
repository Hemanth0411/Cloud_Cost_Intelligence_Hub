"""Cost reporting endpoints.

Every one of these reads through query/scoped, which always applies the
grant predicate. None of them touch the fact table directly.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Query

from costhub.api.deps import CurrentUser
from costhub.api.envelope import wrap
from costhub.query import scoped
from costhub.query.scoped import Filters

router = APIRouter(prefix="/cost", tags=["cost"])

Grain = Literal["day", "week", "month", "quarter", "year"]
Dimension = Literal["provider", "account", "service", "region", "charge_category"]
Metric = Literal["effective_cost", "billed_cost"]


def _filters(
    start: date,
    end: date,
    provider: str | None,
    account_id: str | None,
    service: str | None,
    metric: Metric,
    include_tax_and_credits: bool,
) -> Filters:
    return Filters(
        start=start,
        end=end,
        provider=provider,
        account_id=account_id,
        service_name=service,
        metric=metric,
        include_tax_and_credits=include_tax_and_credits,
    )


@router.get("/series", summary="Cost over time")
def series(
    who: CurrentUser,
    start: Annotated[date, Query(description="Inclusive")],
    end: Annotated[date, Query(description="Inclusive")],
    grain: Grain = "day",
    provider: str | None = None,
    account_id: str | None = None,
    service: str | None = None,
    metric: Metric = "effective_cost",
    include_tax_and_credits: bool = False,
) -> dict:
    """Totals per period.

    Tax and Credit rows are excluded by default: they are real charges but
    they skew any per-service comparison.
    """
    f = _filters(start, end, provider, account_id, service, metric,
                 include_tax_and_credits)
    rows = scoped.series(who, f, grain=grain)
    return wrap(rows, metric=metric, end=end)


@router.get("/breakdown", summary="Cost grouped by one dimension")
def breakdown(
    who: CurrentUser,
    start: date,
    end: date,
    dimension: Dimension = "service",
    provider: str | None = None,
    account_id: str | None = None,
    service: str | None = None,
    metric: Metric = "effective_cost",
    include_tax_and_credits: bool = False,
    limit: Annotated[int, Query(ge=1, le=500)] = 50,
) -> dict:
    f = _filters(start, end, provider, account_id, service, metric,
                 include_tax_and_credits)
    rows = scoped.by_dimension(who, f, dimension, limit=limit)
    return wrap(rows, metric=metric, end=end)


@router.get("/compare", summary="Period-over-period by dimension")
def compare(
    who: CurrentUser,
    current_start: date,
    current_end: date,
    dimension: Dimension = "service",
    previous_start: date | None = None,
    previous_end: date | None = None,
    provider: str | None = None,
    account_id: str | None = None,
    service: str | None = None,
    metric: Metric = "effective_cost",
) -> dict:
    """Deltas as both absolute currency and percent.

    Percent alone is noise on small numbers: $2 to $6 is +200% and also
    +$4, and only one of those is worth acting on. `delta_pct` is null
    when the previous period was zero.

    When the previous window is omitted it defaults to the immediately
    preceding window of equal length.
    """
    span = (current_end - current_start).days
    if previous_start is None or previous_end is None:
        previous_end = current_start - timedelta(days=1)
        previous_start = previous_end - timedelta(days=span)

    cur = _filters(current_start, current_end, provider, account_id, service,
                   metric, False)
    prev = _filters(previous_start, previous_end, provider, account_id, service,
                    metric, False)

    rows = scoped.compare(who, cur, prev, dimension)
    out = wrap(rows, metric=metric, end=current_end)
    out["windows"] = {
        "current": {"start": current_start, "end": current_end},
        "previous": {"start": previous_start, "end": previous_end},
    }
    return out
