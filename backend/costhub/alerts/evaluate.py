"""Rule evaluation.

Every rule is evaluated **as its owner**, through query/scoped. That
means the data is already filtered by their grants, so an unscoped rule
("all accounts") can never show its owner more than they may see.

Four types:

  threshold  spend over the window crosses a value
  forecast   current run-rate projects past the value before period end
  digest     unconditional periodic summary
  anomaly    a new finding appeared in scope
"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from costhub.alerts.ports import Event, Rule
from costhub.db import fetch_all
from costhub.query import scoped
from costhub.query.scoped import Filters, Principal
from costhub.rbac.resolve import describe

# Findings are scoped exactly as facts are.
ANOMALY_SCOPE = """
SELECT a.account_id, a.service_name, a.detected_for_date, a.kind,
       a.baseline_value, a.observed_value, a.delta_abs, a.delta_pct
FROM anomaly_findings a
WHERE a.status = 'new'
  AND a.created_at >= %(since)s
  AND (%(provider)s::text IS NULL OR a.provider     = %(provider)s::text)
  AND (%(account)s::text  IS NULL OR a.account_id   = %(account)s::text)
  AND (%(service)s::text  IS NULL OR a.service_name = %(service)s::text)
  AND (%(admin)s::boolean OR EXISTS (
        SELECT 1 FROM access_grants g
        WHERE g.user_id     = %(user_id)s
          AND g.revoked_at IS NULL
          AND g.deleted_at IS NULL
          AND g.provider    = a.provider
          AND g.account_id  = a.account_id
          AND (g.service_name IS NULL OR g.service_name = a.service_name)
          AND now() >= g.valid_from
          AND (g.valid_until IS NULL OR now() < g.valid_until)))
ORDER BY abs(a.delta_abs) DESC
LIMIT 20
"""


def _principal(rule: Rule) -> Principal:
    return Principal(
        user_id=rule.owner_user_id, email=rule.owner_email, role=rule.owner_role
    )


def _metric_of(rule: Rule) -> str:
    """The rule's metric, coerced to something `Filters` accepts.

    _window coerced an unknown metric while _forecast passed it raw, so
    the two paths disagreed: the resulting ValueError was swallowed by
    runner's broad except and the forecast rule silently never fired.
    """
    return rule.metric if rule.metric in {"effective_cost", "billed_cost"}         else "effective_cost"


def _window(rule: Rule, today: date) -> Filters:
    """The rule's window, as INCLUSIVE dates.

    `Filters.end` is inclusive in query/scoped (`usage_date <= end`), so
    a window of N days spans [today - (N-1), today]. Subtracting N gave
    N+1 days: a window_days=1 rule summed two days, and the default rule
    therefore fired on twice the intended spend while its own subject
    line said "over 1d".
    """
    return Filters(
        start=today - timedelta(days=rule.window_days - 1),
        end=today,
        provider=rule.scope_provider,
        account_id=rule.scope_account,
        service_name=rule.scope_service,
        metric=_metric_of(rule),
    )


def _total(rule: Rule, today: date) -> Decimal:
    rows = scoped.series(_principal(rule), _window(rule, today), grain="day")
    return Decimal(str(sum(Decimal(str(r["cost"])) for r in rows))) if rows else Decimal("0")


def _breached(comparator: str | None, value: Decimal, threshold: Decimal) -> bool:
    return {
        "gt": value > threshold,
        "gte": value >= threshold,
        "lt": value < threshold,
        "lte": value <= threshold,
    }.get(comparator or "gt", value > threshold)


# --------------------------------------------------------------------- types

def _threshold(rule: Rule, today: date) -> Event | None:
    if rule.threshold_value is None:
        return None
    total = _total(rule, today)
    if not _breached(rule.comparator, total, rule.threshold_value):
        return None

    scope = describe(rule.scope_provider, rule.scope_account, rule.scope_service)
    return Event(
        rule=rule,
        observed_value=total,
        expected_value=rule.threshold_value,
        subject=f"[cost] {rule.name}: ${total:,.2f} over {rule.window_days}d",
        body=(
            f"{scope}\n"
            f"{rule.metric} over the last {rule.window_days} day(s): "
            f"${total:,.2f}\n"
            f"threshold: {rule.comparator or 'gt'} ${rule.threshold_value:,.2f}"
        ),
        payload={"total": str(total), "window_days": rule.window_days,
                 "scope": scope},
        fired_for=today,
    )


def _forecast(rule: Rule, today: date) -> Event | None:
    """Linear run-rate projection to the end of the calendar month.

    Deliberately linear: it is explainable, and at this data volume a
    fancier model would be false precision. The value is catching an
    overrun early, not predicting it to the cent.
    """
    if rule.threshold_value is None:
        return None

    month_start = today.replace(day=1)
    nxt = (month_start + timedelta(days=32)).replace(day=1)
    days_in_month = (nxt - month_start).days
    # NOT (today - month_start) + 1: that counts today as fully elapsed
    # while the numerator cannot contain today's cost, since Cost
    # Explorer lags 8-24h. On the 3rd of the month that made a $1,000/day
    # account project ~$10k instead of ~$31k -- a 3x under-read in
    # exactly the window where an early warning is worth having.
    settled_through = today - timedelta(days=1)
    elapsed = (settled_through - month_start).days + 1
    if elapsed < 3:
        return None  # too early for a run-rate to mean anything

    f = Filters(
        start=month_start, end=settled_through,
        provider=rule.scope_provider, account_id=rule.scope_account,
        service_name=rule.scope_service, metric=_metric_of(rule),
    )
    rows = scoped.series(_principal(rule), f, grain="day")
    so_far = Decimal(str(sum(Decimal(str(r["cost"])) for r in rows))) if rows else Decimal("0")
    if so_far <= 0:
        return None

    projected = (so_far / elapsed) * days_in_month
    if not _breached(rule.comparator, projected, rule.threshold_value):
        return None

    scope = describe(rule.scope_provider, rule.scope_account, rule.scope_service)
    return Event(
        rule=rule,
        observed_value=projected,
        expected_value=rule.threshold_value,
        subject=f"[cost] {rule.name}: projected ${projected:,.2f} this month",
        body=(
            f"{scope}\n"
            f"${so_far:,.2f} spent over {elapsed} of {days_in_month} days\n"
            f"projected month total: ${projected:,.2f}\n"
            f"threshold: ${rule.threshold_value:,.2f}"
        ),
        payload={"so_far": str(so_far), "projected": str(projected),
                 "elapsed_days": elapsed, "days_in_month": days_in_month,
                 "scope": scope},
        fired_for=today,
    )


def _digest(rule: Rule, today: date) -> Event | None:
    """Unconditional summary. Fires on frequency, not on a condition."""
    f = _window(rule, today)
    who = _principal(rule)
    total = _total(rule, today)
    top = scoped.by_dimension(who, f, "service", limit=5)

    lines = [f"  {r['key']}: ${Decimal(str(r['cost'])):,.2f}" for r in top]
    scope = describe(rule.scope_provider, rule.scope_account, rule.scope_service)
    return Event(
        rule=rule,
        observed_value=total,
        expected_value=None,
        subject=f"[cost] {rule.name}: ${total:,.2f} over {rule.window_days}d",
        body=f"{scope}\ntotal ${total:,.2f}\n\ntop services:\n" + "\n".join(lines),
        payload={"total": str(total), "top": top, "scope": scope},
        fired_for=today,
    )


def _anomaly(rule: Rule, today: date, since) -> Event | None:
    rows = fetch_all(
        ANOMALY_SCOPE,
        {
            "since": since,
            "provider": rule.scope_provider,
            "account": rule.scope_account,
            "service": rule.scope_service,
            "user_id": rule.owner_user_id,
            "admin": rule.owner_is_superadmin,
        },
    )
    if not rows:
        return None

    lines = [
        f"  {r['kind']:<6} {r['account_id']}/{r['service_name']} "
        f"{r['detected_for_date']}: "
        f"${r['baseline_value']:,.2f} -> ${r['observed_value']:,.2f}"
        + (f" ({r['delta_pct']:+.0f}%)" if r["delta_pct"] is not None else "")
        for r in rows
    ]
    worst = rows[0]
    return Event(
        rule=rule,
        observed_value=worst["observed_value"],
        expected_value=worst["baseline_value"],
        subject=f"[cost] {rule.name}: {len(rows)} new anomal"
                f"{'y' if len(rows) == 1 else 'ies'}",
        body="\n".join(lines),
        payload={"count": len(rows), "findings": [dict(r) for r in rows]},
        fired_for=today,
    )


def evaluate(rule: Rule, *, today: date | None = None, since=None) -> Event | None:
    """Evaluate one rule. Returns an Event if it should fire."""
    today = today or date.today()
    if rule.type == "threshold":
        return _threshold(rule, today)
    if rule.type == "forecast":
        return _forecast(rule, today)
    if rule.type == "digest":
        return _digest(rule, today)
    if rule.type == "anomaly":
        return _anomaly(rule, today, since or (today - timedelta(days=rule.window_days)))
    return None
