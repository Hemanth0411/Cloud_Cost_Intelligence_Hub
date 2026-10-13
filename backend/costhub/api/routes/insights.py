"""Narrated cost insights.

Figures first: every number here is computed by `insights/facts` through
query/scoped with the caller's Principal, exactly as the cost screens
are. The sentences are written by the backend from those figures; a
model on Bedrock only chooses among them, and that choice can be absent
-- `narration.status` says why. See docs/16-insights-api.md.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, status

from costhub.api.deps import CurrentUser
from costhub.api.envelope import as_of, is_partial
from costhub.api.routes import anomalies
from costhub.insights import coverage, facts, service
from costhub.query.scoped import Filters

router = APIRouter(prefix="/insights", tags=["insights"])

Metric = Literal["effective_cost", "billed_cost"]

DEFAULT_DAYS = 30
MAX_DAYS = 366
EARLIEST = date(2006, 1, 1)     # before any cloud bill this could hold
# Above the /anomalies page size on purpose: the cards are the largest
# findings in the window, so the candidate list must not be one page.
FINDINGS_LIMIT = 200


@router.get("", summary="Computed insights, with optional narration")
def insights(
    who: CurrentUser,
    start: Annotated[date | None, Query(description="Inclusive. Default: 30 days ending at `end`.")] = None,
    end: Annotated[date | None, Query(description="Inclusive. Default: the last day whose cost is final, three days ago (UTC).")] = None,
    provider: str | None = None,
    account_id: str | None = None,
    service_name: Annotated[str | None, Query(alias="service")] = None,
    metric: Metric = "effective_cost",
    narrate: Annotated[bool, Query(description="false returns the figures and makes no model call.")] = True,
) -> dict:
    """Insight cards for the caller's own scope.

    Each card carries its `figures` and, when available, a `text`
    sentence about exactly those figures. The model never computes or
    writes anything: the server writes the candidate sentences and the
    model picks one per card. A card whose `text` is null is still a
    valid card.

    The previous period is the immediately preceding window of equal
    length, as in `/cost/compare`.
    """
    if end is None:
        # Not yesterday: providers restate the most recent days, and a
        # window ending on one reads as a fall that is only missing data.
        end = coverage.last_final_day()
    if start is None:
        start = end - timedelta(days=DEFAULT_DAYS - 1)
    if start > end:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "start is after end")
    if start < EARLIEST:
        # Also keeps the previous window representable: a start near
        # date.min overflowed in window_before and became a 500.
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, f"start is before {EARLIEST}"
        )
    if (end - start).days + 1 > MAX_DAYS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, f"window exceeds {MAX_DAYS} days"
        )

    prev_start, prev_end = facts.window_before(start, end)
    current = Filters(start=start, end=end, provider=provider,
                      account_id=account_id, service_name=service_name, metric=metric)
    previous = Filters(start=prev_start, end=prev_end, provider=provider,
                       account_id=account_id, service_name=service_name, metric=metric)

    # The same reader, with the same caller, as GET /anomalies -- so a
    # finding can appear in a sentence only if it appears on that screen.
    findings = anomalies.list_findings(who, "new", FINDINGS_LIMIT)["data"]

    fresh_as_of = as_of()
    cards, summary, narration = service.build(
        who, current, previous, findings, fresh_as_of, want_narration=narrate,
        # A full page may not be every finding, so counts are not stated.
        findings_complete=len(findings) < FINDINGS_LIMIT,
    )
    return {
        "data": cards,
        "as_of": fresh_as_of,
        "metric": metric,
        "currency": summary.currency,
        "partial_period": is_partial(end),
        "row_count": len(cards),
        "windows": {
            "current": {"start": start, "end": end},
            "previous": {"start": prev_start, "end": prev_end},
        },
        "comparison": summary.comparison,
        "narration": narration,
    }
