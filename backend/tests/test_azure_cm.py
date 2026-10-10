"""Azure adapter tests.

No Azure subscription exists, so the live path cannot be verified. What
CAN be verified is everything that actually breaks in practice:

  * mapping parallel column/row arrays by NAME, not position
  * the integer UsageDate format (20261010)
  * the EA/MCA column-name differences
  * 401/403 -> an actionable error, 429 -> honour Retry-After

The transport is exercised through a mock httpx client, so the request
shape and pagination are real even though the service is not.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import httpx
import pytest

from costhub.connections.credentials import Connection
from costhub.ingest.azure_cm import (
    AzureCostManagementSource,
    AzureQueryFailed,
    build_query,
    parse_response,
)
from costhub.ingest.errors import AccessNotGranted

CONN = Connection(
    id="c1",
    provider="azure",
    account_id="11111111-2222-3333-4444-555555555555",
    display_name="azure-dev",
    credential_mode="secret",
    secret_arn="arn:aws:secretsmanager:us-east-1:1:secret:x",
)

CREDS = {"tenant_id": "t", "client_id": "c", "client_secret": "s"}


def page(columns: list[str], rows: list[list], next_link: str | None = None) -> dict:
    props: dict = {
        "columns": [{"name": c, "type": "String"} for c in columns],
        "rows": rows,
    }
    if next_link:
        props["nextLink"] = next_link
    return {"properties": props}


# ------------------------------------------------------------- parsing

def test_parses_mca_shape():
    payload = page(
        ["Cost", "UsageDate", "ServiceName", "ResourceLocation", "Currency"],
        [
            [12.5, 20261001, "Virtual Machines", "eastus", "USD"],
            [3.25, 20261002, "Storage", "westus", "USD"],
        ],
    )
    rows = parse_response(payload, provider="azure", account_id="sub1")

    assert len(rows) == 2
    assert rows[0].usage_date == date(2026, 10, 1)
    assert rows[0].service_name == "Virtual Machines"
    assert rows[0].region == "eastus"
    assert rows[0].billed_cost == Decimal("12.5")
    assert rows[0].currency == "USD"
    assert rows[0].provider == "azure"


def test_parses_ea_shape_with_pretaxcost():
    """EA agreements return PreTaxCost where MCA returns Cost."""
    payload = page(
        ["PreTaxCost", "UsageDate", "MeterCategory"],
        [[7.0, 20261003, "Bandwidth"]],
    )
    rows = parse_response(payload, provider="azure", account_id="sub1")
    assert rows[0].billed_cost == Decimal("7.0")
    assert rows[0].service_name == "Bandwidth"


def test_columns_are_mapped_by_name_not_position():
    """THE test for this adapter.

    Azure reorders columns depending on the grouping requested, so a
    positional read silently swaps cost and date. Same data, shuffled
    columns, must parse identically.
    """
    normal = page(
        ["Cost", "UsageDate", "ServiceName", "ResourceLocation"],
        [[9.0, 20261005, "Functions", "eastus"]],
    )
    shuffled = page(
        ["ResourceLocation", "ServiceName", "UsageDate", "Cost"],
        [["eastus", "Functions", 20261005, 9.0]],
    )

    a = parse_response(normal, provider="azure", account_id="s")[0]
    b = parse_response(shuffled, provider="azure", account_id="s")[0]

    assert (a.usage_date, a.service_name, a.region, a.billed_cost) == \
           (b.usage_date, b.service_name, b.region, b.billed_cost)


def test_iso_date_string_also_works():
    payload = page(["Cost", "UsageDate"], [[1.0, "2026-10-07T00:00:00Z"]])
    rows = parse_response(payload, provider="azure", account_id="s")
    assert rows[0].usage_date == date(2026, 10, 7)


def test_zero_rows_are_dropped():
    """Azure emits a row per grouping per day whether or not it cost anything."""
    payload = page(
        ["Cost", "UsageDate", "ServiceName"],
        [[0, 20261001, "Idle"], [4.0, 20261001, "Active"]],
    )
    rows = parse_response(payload, provider="azure", account_id="s")
    assert [r.service_name for r in rows] == ["Active"]


def test_missing_optional_columns_are_tolerated():
    payload = page(["Cost", "UsageDate"], [[2.0, 20261001]])
    row = parse_response(payload, provider="azure", account_id="s")[0]
    assert row.service_name == "Unknown"
    assert row.region == ""
    assert row.currency == "USD"


def test_unrecognisable_response_raises_with_the_columns():
    """Fail loudly and say what arrived, rather than returning nothing."""
    payload = page(["Something", "Else"], [[1, 2]])
    with pytest.raises(AzureQueryFailed) as exc:
        parse_response(payload, provider="azure", account_id="s")
    assert "Something" in str(exc.value)


def test_unparseable_date_row_is_skipped_not_fatal():
    payload = page(["Cost", "UsageDate"], [[1.0, "not-a-date"], [2.0, 20261001]])
    rows = parse_response(payload, provider="azure", account_id="s")
    assert len(rows) == 1


# --------------------------------------------------------------- query

def test_query_timeperiod_is_inclusive():
    """Upstream `end` is exclusive (matching Cost Explorer); Azure's is not."""
    q = build_query(date(2026, 10, 1), date(2026, 10, 11))
    assert q["timePeriod"] == {"from": "2026-10-01", "to": "2026-10-10"}
    assert q["dataset"]["granularity"] == "Daily"


def test_single_day_window_does_not_invert():
    q = build_query(date(2026, 10, 5), date(2026, 10, 5))
    assert q["timePeriod"]["from"] == q["timePeriod"]["to"] == "2026-10-05"


# ----------------------------------------------------------- transport

def _source(handler) -> AzureCostManagementSource:
    return AzureCostManagementSource(
        CONN,
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        credentials=CREDS,
    )


def test_fetch_paginates_and_stops():
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth2" in str(request.url):
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})
        calls.append(str(request.url))
        if len(calls) == 1:
            return httpx.Response(200, json=page(
                ["Cost", "UsageDate", "ServiceName"],
                [[1.0, 20261001, "A"]],
                next_link="https://management.azure.com/next?skip=1",
            ))
        return httpx.Response(200, json=page(
            ["Cost", "UsageDate", "ServiceName"], [[2.0, 20261002, "B"]]
        ))

    rows = list(_source(handler).fetch(
        account_id="sub1", start=date(2026, 10, 1), end=date(2026, 10, 3)
    ))
    assert [r.service_name for r in rows] == ["A", "B"]
    assert len(calls) == 2, "must follow nextLink exactly once"


def test_403_becomes_an_actionable_error():
    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth2" in str(request.url):
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        return httpx.Response(403, json={"error": {"message": "denied"}})

    with pytest.raises(AccessNotGranted) as exc:
        list(_source(handler).fetch(
            account_id="s", start=date(2026, 10, 1), end=date(2026, 10, 2)
        ))
    # The message must name the fix, not just the status code.
    assert "Cost Management Reader" in str(exc.value)


def test_expired_client_secret_is_reported_as_such():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "invalid_client"})

    with pytest.raises(AccessNotGranted) as exc:
        list(_source(handler).fetch(
            account_id="s", start=date(2026, 10, 1), end=date(2026, 10, 2)
        ))
    assert "client secret" in str(exc.value)


def test_429_is_retried_honouring_retry_after(monkeypatch):
    monkeypatch.setattr("costhub.ingest.azure_cm.time.sleep", lambda s: None)
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth2" in str(request.url):
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        attempts["n"] += 1
        if attempts["n"] == 1:
            return httpx.Response(429, headers={"Retry-After": "1"}, json={})
        return httpx.Response(200, json=page(
            ["Cost", "UsageDate", "ServiceName"], [[5.0, 20261001, "A"]]
        ))

    rows = list(_source(handler).fetch(
        account_id="s", start=date(2026, 10, 1), end=date(2026, 10, 2)
    ))
    assert attempts["n"] == 2
    assert rows[0].billed_cost == Decimal("5.0")


def test_token_is_reused_across_pages():
    tokens = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth2" in str(request.url):
            tokens["n"] += 1
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        return httpx.Response(200, json=page(
            ["Cost", "UsageDate", "ServiceName"], [[1.0, 20261001, "A"]]
        ))

    src = _source(handler)
    for _ in range(3):
        list(src.fetch(account_id="s", start=date(2026, 10, 1), end=date(2026, 10, 2)))
    assert tokens["n"] == 1, "token must be cached, not refetched per call"


# -------------------------------------------------------------- scope

@pytest.mark.parametrize(
    "account_id,expected",
    [
        ("11111111-2222-3333-4444-555555555555",
         "subscriptions/11111111-2222-3333-4444-555555555555"),
        ("1234567", "providers/Microsoft.Billing/billingAccounts/1234567"),
        ("/subscriptions/abc/resourceGroups/rg", "subscriptions/abc/resourceGroups/rg"),
    ],
)
def test_scope_path(account_id, expected):
    conn = Connection(
        id="c", provider="azure", account_id=account_id,
        display_name="x", credential_mode="secret",
    )
    src = AzureCostManagementSource(conn, credentials=CREDS)
    assert src._scope_path() == expected


# ------------------------------------------------------------ dispatch

def test_dispatch_picks_the_adapter_by_provider():
    from costhub.ingest.sources import source_for
    from costhub.ingest.azure_cm import AzureCostManagementSource
    from costhub.ingest.cost_explorer import CostExplorerSource

    aws = Connection(id="a", provider="aws", account_id="self",
                     display_name="aws", credential_mode="self")
    azure = Connection(id="b", provider="azure", account_id="sub",
                       display_name="az", credential_mode="secret",
                       secret_arn="arn:x")

    assert isinstance(source_for(aws), CostExplorerSource)
    assert isinstance(source_for(azure), AzureCostManagementSource)


def test_unknown_provider_names_the_available_adapters():
    """A GCP connection added before the adapter exists must say so
    clearly, and must not abort the other accounts."""
    from costhub.ingest.sources import NoAdapter, source_for

    gcp = Connection(id="c", provider="gcp", account_id="p",
                     display_name="gcp", credential_mode="secret")
    with pytest.raises(NoAdapter) as exc:
        source_for(gcp)
    assert "aws" in str(exc.value) and "azure" in str(exc.value)
