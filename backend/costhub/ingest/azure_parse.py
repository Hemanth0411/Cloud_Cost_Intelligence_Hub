"""Parsing Azure Cost Management responses. No I/O.

Split out of `azure_cm` for two reasons: it kept that module over the
300-line limit (NFR-18), and this is the half that can actually be
tested -- there is no Azure subscription, so the transport is exercised
through a mock while this is exercised directly.

Two things about this API that bite, both handled here:

**Rows are parallel arrays.** The response gives `columns` and `rows`
separately, so values are addressed by index -- and the column ORDER IS
NOT CONTRACTUAL: it shifts with the grouping requested. Everything below
maps by column NAME. A positional read silently swaps cost and date.

**UsageDate is an integer.** Daily granularity returns `20261010`, not a
date string. Both forms are accepted.
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from costhub.ingest.errors import ExpectedIngestError
from costhub.ingest.ports import CostRow


class AzureQueryFailed(ExpectedIngestError):
    """The response was reachable but unusable."""


# Candidate column names, most preferred first. Azure varies these by
# scope type and agreement: EA gives PreTaxCost, MCA gives Cost.
COST_COLUMNS = ("Cost", "PreTaxCost", "CostUSD", "PreTaxCostUSD")
DATE_COLUMNS = ("UsageDate", "Date", "BillingMonth")
SERVICE_COLUMNS = ("ServiceName", "MeterCategory", "ServiceTier")
REGION_COLUMNS = ("ResourceLocation", "Location", "ResourceLocationNormalized")
CURRENCY_COLUMNS = ("Currency", "BillingCurrency", "BillingCurrencyCode")



def _retry_after(header: str | None, attempt: int) -> float:
    """Seconds to wait. Retry-After may be a delay OR an HTTP date.

    float() on the date form raised ValueError, which escaped as an
    unexpected exception -- a traceback and a generic failure instead of
    this adapter's own clean error.
    """
    fallback = float(2 ** attempt)
    if not header:
        return fallback
    try:
        return float(header)
    except ValueError:
        pass
    try:
        from email.utils import parsedate_to_datetime

        when = parsedate_to_datetime(header)
        delta = (when - datetime.now(when.tzinfo)).total_seconds()
        return max(0.0, delta) if delta < 300 else fallback
    except (TypeError, ValueError):
        return fallback


def _index_of(columns: list[dict], candidates: tuple[str, ...]) -> int | None:
    """Find a column by name, case-insensitively.

    By name and never by position: the order changes with the grouping
    requested, so an index literal is a latent bug.
    """
    lookup = {str(c.get("name", "")).lower(): i for i, c in enumerate(columns)}
    for want in candidates:
        if want.lower() in lookup:
            return lookup[want.lower()]
    return None


def _as_date(value: Any) -> date | None:
    """Daily granularity returns 20261010; monthly returns an ISO string."""
    if value is None:
        return None
    if isinstance(value, int) or (isinstance(value, str) and value.isdigit()):
        text = str(value)
        if len(text) == 8:
            try:
                return date(int(text[:4]), int(text[4:6]), int(text[6:]))
            except ValueError:
                return None
        return None
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).date()
        except ValueError:
            return None
    return None


def _as_decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value if value is not None else 0))
    except (InvalidOperation, ValueError):
        return Decimal("0")


def parse_response(
    payload: dict, *, provider: str, account_id: str, fallback_currency: str = "USD"
) -> list[CostRow]:
    """Turn one Query API page into CostRows.

    Pure, so it can be tested against recorded payloads without any Azure
    access -- which is the only way this adapter can be tested at all
    right now.
    """
    props = payload.get("properties") or payload
    columns = props.get("columns") or []
    rows = props.get("rows") or []

    i_cost = _index_of(columns, COST_COLUMNS)
    i_date = _index_of(columns, DATE_COLUMNS)
    i_service = _index_of(columns, SERVICE_COLUMNS)
    i_region = _index_of(columns, REGION_COLUMNS)
    i_currency = _index_of(columns, CURRENCY_COLUMNS)

    if i_cost is None or i_date is None:
        names = [c.get("name") for c in columns]
        raise AzureQueryFailed(
            f"response has no recognisable cost/date column; got {names}"
        )

    out: list[CostRow] = []
    for row in rows:
        usage_date = _as_date(row[i_date]) if i_date < len(row) else None
        if usage_date is None:
            continue

        amount = _as_decimal(row[i_cost]) if i_cost < len(row) else Decimal("0")
        if amount == 0:
            continue  # Azure emits a row per grouping per day regardless

        service = (
            str(row[i_service]) if i_service is not None and i_service < len(row)
            else "Unknown"
        )
        region = (
            str(row[i_region]) if i_region is not None and i_region < len(row)
            else ""
        )
        currency = (
            str(row[i_currency]) if i_currency is not None and i_currency < len(row)
            else fallback_currency
        )

        out.append(
            CostRow(
                provider=provider,
                account_id=account_id,
                service_name=service or "Unknown",
                region=region,
                charge_category="Usage",
                usage_date=usage_date,
                billed_cost=amount,
                # The Query API's ActualCost has no amortised counterpart,
                # so the two measures are equal here. A FOCUS export would
                # distinguish them; noted rather than faked.
                effective_cost=amount,
                currency=(currency or fallback_currency)[:3].upper(),
            )
        )
    return out


def build_query(start: date, end: date) -> dict:
    """Daily cost grouped by service and location.

    `end` is exclusive upstream (matching Cost Explorer), but Azure's
    timePeriod is inclusive, so a day is subtracted.
    """
    last = end.toordinal() - 1
    return {
        "type": "ActualCost",
        "timeframe": "Custom",
        "timePeriod": {
            "from": start.isoformat(),
            "to": date.fromordinal(max(last, start.toordinal())).isoformat(),
        },
        "dataset": {
            "granularity": "Daily",
            "aggregation": {"totalCost": {"name": "Cost", "function": "Sum"}},
            "grouping": [
                {"type": "Dimension", "name": "ServiceName"},
                {"type": "Dimension", "name": "ResourceLocation"},
            ],
        },
    }


