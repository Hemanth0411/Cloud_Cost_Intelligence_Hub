"""The only reader of fact_cost_daily.

Invariant: no other module queries the fact table. Every read goes
through this one, and this one always applies GRANT_PREDICATE. That keeps
the authorization decision in a single reviewable place -- if it holds,
the RBAC is sound regardless of what the API or UI later does.

It fails CLOSED: a principal with no grants sees zero rows, never all
rows. test_scoped.py asserts that first.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from typing import Any, Literal

from costhub.audit import log as audit_log
from costhub.db import connect, fetch_all

log = logging.getLogger(__name__)

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

# Superadmins bypass the predicate. The API records the bypass in
# audit_log (see api/deps.py:_audit_bypass) -- an unlogged bypass is
# indistinguishable from a leak. That used to be asserted here and
# implemented nowhere.
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


SYSTEM_EMAIL = "system@costhub.internal"


def system_principal() -> Principal:
    """The identity background jobs read with.

    Detection and alert evaluation have to see every account by design --
    an anomaly in an account nobody has been granted is still an anomaly.
    This is deliberately a named, greppable function rather than scattered
    `role="superadmin"` literals, and callers log one audit entry per run
    rather than per query.
    """
    return Principal(
        user_id="00000000-0000-0000-0000-000000000000",
        email=SYSTEM_EMAIL,
        role="superadmin",
    )


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


BYPASS_SEEN = """
SELECT 1 FROM audit_log
WHERE actor = %(actor)s
  AND action = 'access.superadmin_bypass'
  AND after->>'scope' = %(scope)s
  AND at > now() - interval '1 hour'
LIMIT 1
"""


def _scope_key(f: Filters) -> str:
    """What was read, as a stable string for throttling and for the log."""
    return "|".join(
        [
            f.provider or "*",
            f.account_id or "*",
            f.service_name or "*",
            f"{f.start}..{f.end}",
        ]
    )


def _note_bypass(principal: Principal, f: Filters) -> None:
    """Record that a superadmin read outside every grant (FR-38).

    This lives here, not in api/deps.py, for two reasons the first
    version got wrong. It was logging at AUTHENTICATION time, so it
    recorded "a superadmin signed in" -- true of a superadmin who only
    ever opened the settings page -- and it recorded no scope at all, so
    the audit trail could not answer the one question it exists for:
    WHICH accounts did they look at. `_where` is the only place that
    knows the bypass was actually used and what it was used on.

    Throttled per (actor, scope) per hour, so a dashboard refresh does
    not bury the log, but reading a DIFFERENT account still shows up.

    The system principal is excluded: background jobs are supposed to see
    everything, and they log once per run (see `system_principal`). One
    row per detector query would be noise, not evidence.
    """
    if principal.email == SYSTEM_EMAIL:
        return

    scope = _scope_key(f)
    try:
        with connect() as conn, conn.cursor() as cur:
            cur.execute(BYPASS_SEEN, {"actor": principal.email, "scope": scope})
            if cur.fetchone():
                return
            audit_log(
                cur,
                actor=principal.email,
                action="access.superadmin_bypass",
                entity_type="fact_cost_daily",
                entity_id=principal.user_id,
                after={"role": principal.role, "scope": scope, "window": "1h"},
            )
    except Exception:
        # Never fail a read because the audit write failed -- but say so
        # loudly, because a silent gap here is the whole problem.
        log.exception("could not record superadmin bypass for %s", principal.email)


def _where(
    principal: Principal, f: Filters, *, audit_bypass: bool = True
) -> tuple[str, dict[str, Any]]:
    """Assemble WHERE. The grant predicate is not optional here.

    `audit_bypass=False` is for reads that return NAMES rather than
    money. The audit entry claims a superadmin read cost data, and for a
    dropdown that listed service names it had not -- see
    `visible_services`.
    """
    if principal.is_superadmin:
        scope = SUPERADMIN_BYPASS
        if audit_bypass:
            _note_bypass(principal, f)
    else:
        scope = GRANT_PREDICATE

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
        # Decimal throughout: float64 is coarser than the 6 decimal
        # places numeric(18,6) carries, so delta_abs could be wrong in
        # the sub-cent digits it claims to report (NFR-7).
        c = Decimal(str(now_rows.get(key) or 0))
        p = Decimal(str(was_rows.get(key) or 0))
        delta = c - p
        out.append(
            {
                "key": key,
                "current": c,
                "previous": p,
                "delta_abs": delta,
                # Percent stays a float: it is a ratio for display, not
                # money, and None rather than infinity when there is
                # nothing to compare against.
                "delta_pct": round(float(delta / p * 100), 2) if p else None,
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
        WHERE d.is_active
          AND g.user_id     = %(user_id)s
          AND g.revoked_at IS NULL
          AND g.deleted_at IS NULL
          AND now() >= g.valid_from
          AND (g.valid_until IS NULL OR now() < g.valid_until)
        ORDER BY 1, 2
        """,
        {"user_id": principal.user_id},
    )


def all_series(
    principal: Principal, *, start: date, end: date
) -> list[dict]:
    """Every (provider, account, service, day) series in the window.

    For background jobs that must consider all accounts -- detection,
    primarily. Still goes through `_where`, so it is scoped like anything
    else; the system principal is what widens it, not a bypass of this
    module.

    Zero-cost days are **densified** to 0 here. Both ingest adapters drop
    zero rows, so the stored series is non-contiguous -- and the detector
    does index arithmetic that assumes one index is one day. A
    weekday-only service produced a "28-day window" spanning 38 calendar
    days, and `exclude_recent_days` dropped the last two POINTS (possibly
    a week old) instead of the last two days. Filling the gaps makes the
    detector's assumption true instead of merely intended.
    """
    f = Filters(start=start, end=end)
    where, params = _where(principal, f)
    rows = fetch_all(
        f"""
        SELECT f.provider, f.account_id, f.service_name, f.usage_date,
               SUM(f.effective_cost) AS cost
        FROM fact_cost_daily f
        WHERE {where}
        GROUP BY 1, 2, 3, 4
        ORDER BY 1, 2, 3, 4
        """,
        params,
    )
    return _densify(rows, start=start, end=end)


def _densify(rows: list[dict], *, start: date, end: date) -> list[dict]:
    """Insert explicit zero rows for days a series has no data."""
    from collections import defaultdict

    by_key: dict[tuple[str, str, str], dict[date, Decimal]] = defaultdict(dict)
    for r in rows:
        key = (r["provider"], r["account_id"], r["service_name"])
        by_key[key][r["usage_date"]] = r["cost"]

    span = (end - start).days + 1
    out: list[dict] = []
    for (provider, account_id, service_name), days in sorted(by_key.items()):
        # Fill only BETWEEN the series' own first and last day. The
        # first-day guard stops a service that started last week
        # acquiring months of fabricated zeroes; the last-day guard is
        # the same argument at the other end, and it matters more.
        #
        # Without it, a service that was switched off reads as a long
        # run of real $0 days. The detector then treats "deleted" as
        # "dropped to zero", which is both a false anomaly and a way to
        # drag a baseline down so the next genuine charge looks like a
        # step change. A gap at the END of a window is missing data, not
        # a measurement.
        first, last = min(days), max(days)
        for i in range(span):
            day = start + timedelta(days=i)
            if day < first or day > last:
                continue
            out.append(
                {
                    "provider": provider,
                    "account_id": account_id,
                    "service_name": service_name,
                    "usage_date": day,
                    "cost": days.get(day, Decimal("0")),
                }
            )
    return out


def visible_services(principal: Principal, provider: str, account_id: str) -> list[str]:
    """Services this principal may see within one account.

    NOT audited as a superadmin bypass. This returns service NAMES and
    no figures, and the audit entry `_note_bypass` writes says
    `entity_type='fact_cost_daily'` with the scope that was read -- i.e.
    it claims a superadmin looked at cost data for that account.

    The throttle key includes the account id, so one row was written per
    account. The grant dialog calls this every time the operator changes
    the account in a dropdown, which meant clicking through ten accounts
    manufactured ten bypass records before anyone had been granted
    anything -- and the audit screen headlines that count as evidence of
    superadmin reads. An audit log that overstates is as hard to trust
    as one that understates.

    Still scoped: the grant predicate is applied exactly as before, so a
    non-superadmin sees only their own services. Only the bypass NOTE is
    suppressed.
    """
    f = Filters(
        start=date(1970, 1, 1),
        end=date(2999, 12, 31),
        provider=provider,
        account_id=account_id,
        include_tax_and_credits=True,
    )
    where, params = _where(principal, f, audit_bypass=False)
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
