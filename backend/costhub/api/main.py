"""The API application.

    uvicorn costhub.api.main:app --reload

Swagger UI at /docs, ReDoc at /redoc, the schema at /openapi.json.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from costhub.api import deps
from costhub.api.routes import admin, alerts, anomalies, connections, cost, meta
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
    # 3000 only: `next dev`. 5173 was the previous (Vite) frontend's
    # port and there is no Vite app in this repo any more -- `git ls-files`
    # finds no vite.config, and the only VITE_ strings left were in prose.
    origins += ["http://localhost:3000"]

# AN UNHANDLED 500 MUST STILL CARRY CORS HEADERS, and the ORDER below is
# the whole fix.
#
# Starlette's ServerErrorMiddleware sits outside user middleware, so the
# response it synthesises for an uncaught exception never passes through
# CORSMiddleware. The browser rejects it for a missing
# Access-Control-Allow-Origin and `fetch` rejects -- indistinguishable,
# client-side, from the API being unreachable. Genuine server faults were
# being reported to the operator as a CORS misconfiguration.
#
# `@app.exception_handler(Exception)` does NOT fix this, which is worth
# recording because it looks like it should: Starlette routes a handler
# registered for `Exception` (or 500) to ServerErrorMiddleware itself,
# i.e. the outermost layer, so its response is outside CORS too.
# Measured, with CORSMiddleware installed and an Origin on the request:
#
#   no handler         500  ACAO=None
#   exception_handler  500  ACAO=None
#   this middleware    500  ACAO='http://localhost:3000'
#
# `add_middleware` PREPENDS, so the last one added is the outermost. This
# must therefore be registered BEFORE CORSMiddleware to end up inside it.
# Swapping these two lines silently reverts the fix.
class _UnhandledErrors(BaseHTTPMiddleware):
    """Turn an uncaught exception into a 500 from inside the CORS layer."""

    async def dispatch(self, request: Request, call_next):
        try:
            return await call_next(request)
        except Exception:
            # The detail belongs in CloudWatch, not in a browser.
            log.exception("unhandled error on %s %s", request.method, request.url.path)
            return JSONResponse(
                status_code=500,
                content={"detail": "Internal server error. The failure has been logged."},
            )


app.add_middleware(_UnhandledErrors)

# Never `origins or ["*"]`: an unset CORS_ORIGINS used to serve a
# wildcard WITH credentials enabled. No origins configured means no
# cross-origin access, which is the safe reading of "unconfigured".
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["authorization", "content-type"]
    + (["x-dev-user"] if deps.dev_mode() else []),
)

app.include_router(cost.router)
app.include_router(meta.router)
app.include_router(anomalies.router)
app.include_router(alerts.router)
app.include_router(admin.router)
app.include_router(connections.router)


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
