"""The API application.

    uvicorn costhub.api.main:app --reload

Swagger UI at /docs, ReDoc at /redoc, the schema at /openapi.json.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from costhub.api import deps
from costhub.api.routes import admin, alerts, anomalies, cost, meta
from costhub.config import settings
from costhub.db import fetch_one

log = logging.getLogger(__name__)

DESCRIPTION = """
One scoped view of cloud cost across **independent** AWS accounts.

### Authorization

Every cost response is filtered by the caller's grants, in SQL. A user with
no grants receives **zero rows** -- never all rows. Filter options from
`/meta/*` are scoped the same way, so a dropdown cannot reveal an account
the caller may not see.

### Reading the numbers

* `effective_cost` is amortised and is what period comparisons should use;
  `billed_cost` reconciles to the invoice. Every response states which.
* `as_of` is the last successful ingest. Cost data lags 8-24h and finalises
  monthly, so nothing here is real-time.
* `partial_period: true` means the window includes an incomplete period.
  Comparing a month-to-date against a full month otherwise reads as a large
  false drop.
* `Tax` and `Credit` rows are excluded by default; they are real charges but
  they skew per-service comparisons.

### Authentication

Send `Authorization: Bearer <cognito-jwt>`.

In local development (`APP_ENV=dev` with no Cognito pool configured) send
`X-Dev-User: someone@chryselys.com` instead, so the frontend can be built
before Cognito exists. Both conditions are required, and the mode is
reported by `GET /health`.
"""

app = FastAPI(
    title="Cloud Cost Intelligence Hub",
    version="0.1.0",
    description=DESCRIPTION,
    openapi_tags=[
        {"name": "cost", "description": "Series, breakdowns and comparisons."},
        {"name": "meta", "description": "Scoped filter options and the caller."},
        {"name": "anomalies", "description": "Detected cost anomalies."},
        {"name": "alerts", "description": "Alert rules and the in-app feed."},
        {"name": "admin", "description": "Superadmin: users, grants, connections, audit."},
        {"name": "ops", "description": "Health and diagnostics."},
    ],
)

# The frontend is served from a different origin (Amplify), so CORS is
# required. Dev allows localhost; deployed origins come from settings.
origins = [o for o in settings().cors_origins.split(",") if o.strip()]
if settings().app_env == "dev":
    origins += ["http://localhost:5173", "http://localhost:3000"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins or ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(cost.router)
app.include_router(meta.router)
app.include_router(anomalies.router)
app.include_router(alerts.router)
app.include_router(admin.router)


@app.get("/health", tags=["ops"], summary="Liveness and configuration")
def health() -> dict:
    """Unauthenticated. Reports which auth mode is active, which is the
    thing most likely to be misconfigured."""
    try:
        fetch_one("SELECT 1 AS ok")
        db_ok = True
    except Exception as exc:  # pragma: no cover
        log.error("health: database unreachable: %s", exc)
        db_ok = False

    return {
        "status": "ok" if db_ok else "degraded",
        "env": settings().app_env,
        "database": "up" if db_ok else "down",
        "auth_mode": "dev-header" if deps.dev_mode() else "cognito-jwt",
    }


@app.on_event("startup")
def _warn_about_dev_auth() -> None:
    if deps.dev_mode():
        log.warning(
            "AUTH IS IN DEV MODE: the X-Dev-User header is accepted. "
            "Set COGNITO_USER_POOL_ID or APP_ENV != dev before deploying."
        )
