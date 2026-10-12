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
from datetime import date
from typing import Iterator

import httpx

from costhub.connections.credentials import Connection, azure_credentials
from costhub.ingest.errors import AccessNotGranted
from costhub.ingest.ports import CostRow

# Re-exported so the adapter stays the single public face of this
# provider: callers and tests import from costhub.ingest.azure_cm.
from costhub.ingest.azure_parse import (  # noqa: F401
    AzureQueryFailed,
    build_query,
    parse_response,
    _retry_after,
)

log = logging.getLogger(__name__)

AUTHORITY = "https://login.microsoftonline.com"
MANAGEMENT = "https://management.azure.com"
API_VERSION = "2023-03-01"
SCOPE = f"{MANAGEMENT}/.default"

# Transport limits (the parsing half has no I/O and needs neither).
MAX_PAGES = 50
RETRY_STATUSES = {429, 500, 502, 503, 504}

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
                wait = _retry_after(resp.headers.get("Retry-After"), attempt)
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

    def close(self) -> None:
        """Release the HTTP transport.

        A warm Lambda container builds one source per connection per
        invocation, so an unclosed client accumulates a transport pool
        on every run.
        """
        if self._client is not None:
            self._client.close()
            self._client = None

    def __enter__(self) -> "AzureCostManagementSource":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def source_factory(conn: Connection) -> AzureCostManagementSource:
    return AzureCostManagementSource(conn)
