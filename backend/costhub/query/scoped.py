"""The only reader of fact_cost_daily.

Invariant: no other module queries the fact table. Every read goes
through this one, and this one always applies GRANT_PREDICATE. That keeps
the authorization decision in a single reviewable place -- if it holds,
the RBAC is sound regardless of what the API or UI later does.

It fails CLOSED: a principal with no grants sees zero rows, never all
rows. test_scoped.py asserts that first.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any, Literal

from costhub.db import fetch_all

# --------------------------------------------------------------------------
# The security boundary. Read this carefully; everything else is plumbing.
#
#  * NULL service_name on a grant  = all services in that account
#  * NULL valid_until on a grant   = indefinite
#  * revoked / soft-deleted grants never match
#  * the time window is evaluated per query, so a revoke takes effect at once
# --------------------------------------------------------------------------
GRANT_PREDICATE = """
EXISTS (
  SELECT 1
  FROM access_grants g
  WHERE g.user_id      = %(user_id)s
    AND g.revoked_at  IS NULL
    AND g.deleted_at  IS NULL
    AND g.provider     = f.provider
    AND g.account_id   = f.account_id
    AND (g.service_name IS NULL OR g.service_name = f.service_name)
    AND now() >= g.valid_from
    AND (g.valid_until IS NULL OR now() < g.valid_until)
)
"""

# Superadmins bypass the predicate. Callers record the bypass in the audit
# log -- an unlogged bypass is indistinguishable from a leak.
SUPERADMIN_BYPASS = "TRUE"

# GROUP BY targets are interpolated into SQL, so they come from an
# allowlist, never from caller input.
DIMENSIONS: dict[str, str] = {
    "provider": "f.provider",
    "account": "f.account_id",
    "service": "f.service_name",
    "region": "f.region",
    "charge_category": "f.charge_category",
}

GRAINS: dict[str, str] = {
    "day": "f.usage_date",
    "week": "date_trunc('week', f.usage_date)::date",
    "month": "date_trunc('month', f.usage_date)::date",
    "quarter": "date_trunc('quarter', f.usage_date)::date",
    "year": "date_trunc('year', f.usage_date)::date",
}

METRICS = {"effective_cost", "billed_cost"}

Grain = Literal["day", "week", "month", "quarter", "year"]


@dataclass(frozen=True)
class Principal:
    """Who is asking. Built from the verified token, never a request body."""

    user_id: str
    email: str
    role: str = "user"

    @property
    def is_superadmin(self) -> bool:
        return self.role == "superadmin"


@dataclass(frozen=True)
class Filters:
    start: date
    end: date
    provider: str | None = None
    account_id: str | None = None
    service_name: str | None = None
    metric: str = "effective_cost"
    include_tax_and_credits: bool = False

    def metric_column(self) -> str:
        if self.metric not in METRICS:
            raise ValueError(f"unknown metric: {self.metric}")
        return f"f.{self.metric}"


def _where(principal: Principal, f: Filters) -> tuple[str, dict[str, Any]]:
    """Assemble WHERE. The grant predicate is not optional here."""
    scope = SUPERADMIN_BYPASS if principal.is_superadmin else GRANT_PREDICATE

    clauses = [
        "f.deleted_at IS NULL",
        "f.usage_date >= %(start)s",
        "f.usage_date <= %(end)s",
        f"({scope})",
    ]
    params: dict[str, Any] = {
        "user_id": principal.user_id,
        "start": f.start,
        "end": f.end,
    }

    # Tax and Credit rows skew any per-service comparison, so they are
    # excluded unless explicitly requested.
    if not f.include_tax_and_credits:
        clauses.append("f.charge_category NOT IN ('Tax','Credit')")

    for field, column in (
        ("provider", "f.provider"),
        ("account_id", "f.account_id"),
        ("service_name", "f.service_name"),
    ):
        value = getattr(f, field)
        if value is not None:
            clauses.append(f"{column} = %({field})s")
            params[field] = value

    return " AND ".join(clauses), params


def series(principal: Principal, f: Filters, grain: Grain = "day") -> list[dict]:
    """Cost over time at the requested grain."""
    if grain not in GRAINS:
        raise ValueError(f"unknown grain: {grain}")
    where, params = _where(principal, f)
    sql = f"""
    SELECT {GRAINS[grain]} AS period,
           SUM({f.metric_column()}) AS cost,
           MIN(f.currency) AS currency
    FROM fact_cost_daily f
    WHERE {where}
    GROUP BY 1
    ORDER BY 1
    """
    return fetch_all(sql, params)


def by_dimension(
    principal: Principal, f: Filters, dimension: str, limit: int = 50
) -> list[dict]:
    """Cost grouped by one dimension: powers service and account breakdowns."""
    if dimension not in DIMENSIONS:
        raise ValueError(f"unknown dimension: {dimension}")
    where, params = _where(principal, f)
    params["limit"] = limit
    sql = f"""
    SELECT {DIMENSIONS[dimension]} AS key,
           SUM({f.metric_column()}) AS cost,
           MIN(f.currency) AS currency
    FROM fact_cost_daily f
    WHERE {where}
    GROUP BY 1
    ORDER BY 2 DESC
    LIMIT %(limit)s
    """
    return fetch_all(sql, params)


def compare(
    principal: Principal,
    current: Filters,
    previous: Filters,
    dimension: str,
) -> list[dict]:
    """Period-over-period by dimension, with absolute and percent delta.

    Both deltas are returned on purpose: percent alone is noise on small
    numbers, where 2 -> 6 reads as +200%.
    """
    now_rows = {r["key"]: r["cost"] for r in by_dimension(principal, current, dimension)}
    was_rows = {
        r["key"]: r["cost"] for r in by_dimension(principal, previous, dimension)
    }

    out = []
    for key in sorted(set(now_rows) | set(was_rows)):
        c = float(now_rows.get(key) or 0)
        p = float(was_rows.get(key) or 0)
        out.append(
            {
                "key": key,
                "current": c,
                "previous": p,
                "delta_abs": round(c - p, 6),
                "delta_pct": round((c - p) / p * 100, 2) if p else None,
            }
        )
    out.sort(key=lambda r: abs(r["delta_abs"]), reverse=True)
    return out


def visible_accounts(principal: Principal) -> list[dict]:
    """Accounts this principal may see.

    Drives the cascading filters. A restricted user's dropdown contains
    only their accounts, which is what makes the scoping visible rather
    than merely claimed.
    """
    if principal.is_superadmin:
        return fetch_all(
            """
            SELECT provider, account_id, account_name
            FROM dim_account WHERE is_active
            ORDER BY provider, account_id
            """
        )
    return fetch_all(
        """
        SELECT DISTINCT d.provider, d.account_id, d.account_name
        FROM dim_account d
        JOIN access_grants g
          ON g.provider = d.provider AND g.account_id = d.account_id
        WHERE g.user_id     = %(user_id)s
          AND g.revoked_at IS NULL
          AND g.deleted_at IS NULL
          AND now() >= g.valid_from
          AND (g.valid_until IS NULL OR now() < g.valid_until)
        ORDER BY 1, 2
        """,
        {"user_id": principal.user_id},
    )


def visible_services(principal: Principal, provider: str, account_id: str) -> list[str]:
    """Services this principal may see within one account."""
    f = Filters(
        start=date(1970, 1, 1),
        end=date(2999, 12, 31),
        provider=provider,
        account_id=account_id,
        include_tax_and_credits=True,
    )
    where, params = _where(principal, f)
    rows = fetch_all(
        f"""
        SELECT DISTINCT f.service_name
        FROM fact_cost_daily f
        WHERE {where}
        ORDER BY 1
        """,
        params,
    )
    return [r["service_name"] for r in rows]
