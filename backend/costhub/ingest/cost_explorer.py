"""AWS Cost Explorer adapter.

Notes that shaped this, all of them things the API will otherwise teach you
the hard way:

* the endpoint is **us-east-1 only**, wherever else the code runs
* `GroupBy` accepts at most **2** dimensions, so SERVICE + REGION is the
  limit and charge category has to come from elsewhere
* `End` is **exclusive**
* each call costs $0.01, which is why ingest is scheduled, not polled
* ~14 months of daily history is available by default
* `LINKED_ACCOUNT` returns a single value in a standalone account, so
  multi-account coverage comes from iterating connections, not grouping
"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from typing import Iterator

from botocore.exceptions import ClientError

from costhub.connections.credentials import Connection, aws_session
from costhub.ingest.errors import AccessNotGranted
from costhub.ingest.ports import CostRow

CE_REGION = "us-east-1"
METRICS = ["UnblendedCost", "AmortizedCost"]


class CostExplorerDenied(AccessNotGranted):
    """Raised when the account has not granted cost access.

    Distinct from a transport failure: this one is actionable (enable
    billing-info IAM access at the root, then attach the ce:Get* policy)
    and should be reported as such rather than retried.
    """


class CostExplorerSource:
    name = "cost_explorer"

    def __init__(self, conn: Connection) -> None:
        self.conn = conn
        self._client = None

    @property
    def client(self):
        if self._client is None:
            self._client = aws_session(self.conn).client("ce", region_name=CE_REGION)
        return self._client

    def fetch(self, *, account_id: str, start: date, end: date) -> Iterator[CostRow]:
        """Daily cost for [start, end), grouped by service and region."""
        for window_start, window_end in _monthly_windows(start, end):
            yield from self._fetch_window(window_start, window_end)

    def _fetch_window(self, start: date, end: date) -> Iterator[CostRow]:
        token: str | None = None
        while True:
            kwargs = {
                "TimePeriod": {"Start": start.isoformat(), "End": end.isoformat()},
                "Granularity": "DAILY",
                "Metrics": METRICS,
                "GroupBy": [
                    {"Type": "DIMENSION", "Key": "SERVICE"},
                    {"Type": "DIMENSION", "Key": "REGION"},
                ],
            }
            if token:
                kwargs["NextPageToken"] = token

            try:
                page = self.client.get_cost_and_usage(**kwargs)
            except ClientError as exc:
                code = exc.response.get("Error", {}).get("Code", "")
                if code in {"AccessDeniedException", "AccessDenied"}:
                    raise CostExplorerDenied(
                        f"{self.conn.display_name} ({self.conn.account_id}): "
                        "Cost Explorer access denied. Check that the root user has "
                        "enabled IAM access to billing information, and that the "
                        "principal has ce:GetCostAndUsage."
                    ) from exc
                raise

            yield from self._rows(page)

            token = page.get("NextPageToken")
            if not token:
                return

    def _rows(self, page: dict) -> Iterator[CostRow]:
        for day in page.get("ResultsByTime", []):
            usage_date = date.fromisoformat(day["TimePeriod"]["Start"])
            for group in day.get("Groups", []):
                service, region = (group["Keys"] + ["", ""])[:2]
                metrics = group["Metrics"]

                billed = _amount(metrics, "UnblendedCost")
                # AmortizedCost spreads commitment purchases across the
                # term, which is what period comparisons should use.
                #
                # PRESENCE, not truthiness: Decimal("0") is falsy, and a
                # zero AmortizedCost is exactly what an RI or Savings Plan
                # upfront looks like on the day it is charged. The old
                # `or billed` wrote the whole upfront into effective_cost
                # -- the one-day spike amortization exists to remove --
                # which then surfaced as a 'spike' finding.
                effective = (
                    _amount(metrics, "AmortizedCost")
                    if _has_amount(metrics, "AmortizedCost")
                    else billed
                )

                if billed == 0 and effective == 0:
                    continue  # CE emits a row per group per day regardless

                yield CostRow(
                    provider="aws",
                    account_id=self.conn.account_id,
                    service_name=service,
                    region=region or "",
                    charge_category=_charge_category(service),
                    usage_date=usage_date,
                    billed_cost=billed,
                    effective_cost=effective,
                    currency=_unit(metrics) or "USD",
                )


# Cost Explorer has no charge-category dimension: grouping by SERVICE
# returns "Tax", "Refund" and discounts AS service values. Hardcoding
# "Usage" therefore made the downstream NOT IN ('Tax','Credit') filter
# match nothing, so breakdowns showed a Tax row while claiming to exclude
# it and the detector scanned Tax as if it were a service (FR-23).
# Only values that can actually appear in a SERVICE grouping. An earlier
# version also listed EDP/SPP/bundled/private-rate discounts and
# savings-plan negation -- those are RECORD_TYPE values, so they were
# dead entries that made this look more complete than it was.
#
# LIMITATION, stated rather than implied: discounts and credits mostly
# arrive as NEGATIVE amounts attached to the real service name, not as a
# separate service, so they are still labelled 'Usage' and still net
# against that service's spend. Separating them needs a second CE call
# grouped by RECORD_TYPE -- the GroupBy ceiling of 2 is why it cannot
# come from this one. FR-23 is therefore only partly satisfied: Tax and
# explicit Refund rows are excluded, inline credits are not. TODO-27.
NON_USAGE_SERVICES: dict[str, str] = {
    "tax": "Tax",
    "refund": "Credit",
    "credit": "Credit",
    "credits": "Credit",
}


def _charge_category(service_name: str) -> str:
    """Classify a Cost Explorer service value into a FOCUS ChargeCategory."""
    return NON_USAGE_SERVICES.get(service_name.strip().lower(), "Usage")


def _has_amount(metrics: dict, key: str) -> bool:
    """Is this metric present WITH a value?

    `key in metrics` alone accepted {"AmortizedCost": {}} and yielded
    effective_cost = 0 against a non-zero billed_cost -- so the DEFAULT
    metric would read $0 for that service/day in every dashboard. The
    old `or billed` masked this; presence-checking Amount closes it.
    """
    try:
        return metrics[key]["Amount"] is not None
    except (KeyError, TypeError):
        return False


def _amount(metrics: dict, key: str) -> Decimal:
    # InvalidOperation is caught too: a non-numeric Amount (e.g. "")
    # otherwise raises out of the generator INSIDE the write transaction
    # and fails the entire connection's ingest.
    try:
        return Decimal(metrics[key]["Amount"])
    except (KeyError, TypeError, InvalidOperation):
        return Decimal("0")


def _unit(metrics: dict) -> str | None:
    for key in METRICS:
        unit = metrics.get(key, {}).get("Unit")
        if unit:
            return unit
    return None


def _monthly_windows(start: date, end: date) -> Iterator[tuple[date, date]]:
    """Split [start, end) into calendar-month chunks.

    Cost Explorer tolerates long ranges at DAILY granularity but the
    responses get unwieldy and paginate heavily. Month chunks also make a
    14-month backfill a predictable ~14 calls per account.

    One chunk is at least one Cost Explorer call, and the count is the
    number of calendar months the range TOUCHES, not its length: a
    2-day range across a month end is two calls. See `default_window`
    before reasoning about how many calls an incremental run makes.
    """
    cursor = start
    while cursor < end:
        if cursor.month == 12:
            nxt = date(cursor.year + 1, 1, 1)
        else:
            nxt = date(cursor.year, cursor.month + 1, 1)
        yield cursor, min(nxt, end)
        cursor = nxt


def default_window(days: int = 7, today: date | None = None) -> tuple[date, date]:
    """The incremental window: trailing `days` plus today.

    Recent days are re-fetched on every run because AWS restates cost as it
    finalises. The fact table's natural key makes that idempotent.

    The range is [today - days, today + 1): `days` + 1 dates, today
    included. So `days=31` is 32 dates, which no month can hold -- it
    always touches two calendar months, and three whenever the month
    before this one is short enough to be spanned whole: the 1st of
    May, July, October and December, and the 1st-3rd of March (1st-2nd
    in a leap year). Even `days=7` is two months on the 1st-7th.
    `_monthly_windows` makes at least one call per month touched (more
    if a month paginates), so "a week is one call" is false for a
    quarter of every month. `tests/test_stale_runs.py` pins these
    counts, through this function -- which is what `today` is for.
    """
    today = today or date.today()
    return today - timedelta(days=days), today + timedelta(days=1)
