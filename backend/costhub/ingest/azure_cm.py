"""Azure Cost Management adapter.

Same `CostSource` port as Cost Explorer, so nothing downstream changes --
`provider='azure'`, and the columns are already FOCUS-aligned.

Written against raw HTTP rather than azure-identity/azure-mgmt-costmanagement
on purpose: those pull in a large dependency tree for two calls, and this
bundle ships to Lambda.

Two things about this API that bite:

**Rows are parallel arrays.** The response gives `columns` and `rows`
separately, so values are addressed by index. The column *order is not
contractual* -- it shifts with the grouping you ask for -- so this maps by
column NAME every time. Hard-coding positions is the bug waiting to happen.

**UsageDate is an integer.** Daily granularity returns `20261010`, not a
date string. Both forms are handled.

Status: **written but unverified.** There is no Azure subscription to run
it against, so the parsing is tested against recorded response shapes and
the live path is untested. Say so rather than implying otherwise.
"""
from __future__ import annotations

import logging
import time
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Iterator

import httpx

from costhub.connections.credentials import Connection, azure_credentials
from costhub.ingest.errors import AccessNotGranted, ExpectedIngestError
from costhub.ingest.ports import CostRow

log = logging.getLogger(__name__)

AUTHORITY = "https://login.microsoftonline.com"
MANAGEMENT = "https://management.azure.com"
API_VERSION = "2023-03-01"
SCOPE = f"{MANAGEMENT}/.default"

# Candidate column names, most preferred first. Azure varies these by
# scope type and agreement: EA gives PreTaxCost, MCA gives Cost.
COST_COLUMNS = ("Cost", "PreTaxCost", "CostUSD", "PreTaxCostUSD")
DATE_COLUMNS = ("UsageDate", "Date", "BillingMonth")
SERVICE_COLUMNS = ("ServiceName", "MeterCategory", "ServiceTier")
REGION_COLUMNS = ("ResourceLocation", "Location", "ResourceLocationNormalized")
CURRENCY_COLUMNS = ("Currency", "BillingCurrency", "BillingCurrencyCode")

MAX_PAGES = 50
RETRY_STATUSES = {429, 500, 502, 503, 504}


class AzureQueryFailed(ExpectedIngestError):
    pass


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


class AzureCostManagementSource:
    name = "azure_cm"

    def __init__(
        self,
        conn: Connection,
        *,
        client: httpx.Client | None = None,
        credentials: dict[str, str] | None = None,
    ) -> None:
        self.conn = conn
        # Injectable so tests exercise the real request/response path
        # without an Azure tenant.
        self._client = client
        self._creds = credentials
        self._token: tuple[str, float] | None = None

    # ------------------------------------------------------------------

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(timeout=60.0)
        return self._client

    @property
    def creds(self) -> dict[str, str]:
        if self._creds is None:
            self._creds = azure_credentials(self.conn)
        return self._creds

    def _access_token(self) -> str:
        """Client-credentials token, cached until shortly before expiry.

        Azure has no cross-cloud equivalent of AssumeRole, so a long-lived
        client secret is unavoidable here. It lives in Secrets Manager and
        is read at call time.
        """
        if self._token and self._token[1] > time.time() + 60:
            return self._token[0]

        c = self.creds
        resp = self.client.post(
            f"{AUTHORITY}/{c['tenant_id']}/oauth2/v2.0/token",
            data={
                "grant_type": "client_credentials",
                "client_id": c["client_id"],
                "client_secret": c["client_secret"],
                "scope": SCOPE,
            },
        )
        if resp.status_code in (400, 401, 403):
            raise AccessNotGranted(
                f"{self.conn.display_name}: Entra token request rejected "
                f"({resp.status_code}). Check the app registration's client "
                f"secret has not expired."
            )
        resp.raise_for_status()
        body = resp.json()
        token = body["access_token"]
        self._token = (token, time.time() + int(body.get("expires_in", 3600)))
        return token

    def _scope_path(self) -> str:
        """Subscription scope, or a billing account when the id looks like one."""
        account = self.conn.account_id
        if account.startswith("/"):
            return account.strip("/")
        if "-" in account and len(account) >= 36:
            return f"subscriptions/{account}"
        return f"providers/Microsoft.Billing/billingAccounts/{account}"

    def _post(self, url: str, body: dict | None) -> dict:
        for attempt in range(4):
            resp = self.client.post(
                url,
                json=body,
                headers={
                    "Authorization": f"Bearer {self._access_token()}",
                    "Content-Type": "application/json",
                },
            )

            if resp.status_code in (401, 403):
                raise AccessNotGranted(
                    f"{self.conn.display_name}: Azure denied the cost query "
                    f"({resp.status_code}). The service principal needs the "
                    f"'Cost Management Reader' role at this scope."
                )

            if resp.status_code in RETRY_STATUSES:
                # Cost Management is aggressively rate-limited and tells
                # you how long to wait; honour it rather than hammering.
                wait = float(resp.headers.get("Retry-After", 2 ** attempt))
                log.warning(
                    "azure %s on %s, retrying in %.0fs",
                    resp.status_code, self.conn.display_name, wait,
                )
                time.sleep(min(wait, 30))
                continue

            if resp.status_code >= 400:
                raise AzureQueryFailed(
                    f"{self.conn.display_name}: {resp.status_code} {resp.text[:300]}"
                )
            return resp.json()

        raise AzureQueryFailed(
            f"{self.conn.display_name}: still rate-limited after 4 attempts"
        )

    # ------------------------------------------------------------------

    def fetch(self, *, account_id: str, start: date, end: date) -> Iterator[CostRow]:
        url = (
            f"{MANAGEMENT}/{self._scope_path()}"
            f"/providers/Microsoft.CostManagement/query"
            f"?api-version={API_VERSION}"
        )
        body: dict | None = build_query(start, end)

        for _ in range(MAX_PAGES):
            payload = self._post(url, body)
            yield from parse_response(
                payload, provider="azure", account_id=account_id
            )

            props = payload.get("properties") or {}
            nxt = props.get("nextLink") or payload.get("nextLink")
            if not nxt:
                return
            # Continuation carries the query, so the body is dropped.
            url, body = nxt, None

        log.warning("azure: stopped after %d pages", MAX_PAGES)


def source_factory(conn: Connection) -> AzureCostManagementSource:
    return AzureCostManagementSource(conn)
