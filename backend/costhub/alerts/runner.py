"""Alert orchestration: evaluate rules, record events, deliver.

The step that is easy to leave out is FR-34: **grants are re-checked at
send time**, not trusted from the rule's stored scope. A rule can outlive
the grant that justified it, and emailing someone about an account they
can no longer open is a disclosure.

When that check fails the event is still recorded, with a delivery error
saying why. Suppressing silently would hide both the spend and the
permission change.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timezone

from costhub.alerts import evaluate as evaluator
from costhub.alerts.inapp import InAppNotifier
from costhub.alerts.ports import Delivery, Event, Notifier, Rule, due
from costhub.alerts.ses import SesNotifier
from costhub.db import connect, fetch_all, fetch_one
from costhub.query.scoped import SYSTEM_EMAIL
from costhub.rbac import resolve

log = logging.getLogger(__name__)

RULES = """
SELECT r.id, r.name, r.owner_user_id, r.type,
       r.scope_provider, r.scope_account, r.scope_service,
       r.metric, r.comparator, r.threshold_value, r.window_days,
       r.frequency, r.channels,
       u.email AS owner_email, u.role AS owner_role, u.status AS owner_status,
       (SELECT max(e.fired_at) FROM alert_events e WHERE e.rule_id = r.id)
         AS last_fired_at
FROM alert_rules r
JOIN users u ON u.id = r.owner_user_id
WHERE r.enabled AND r.deleted_at IS NULL AND u.deleted_at IS NULL
ORDER BY r.created_at
"""

INSERT_EVENT = """
INSERT INTO alert_events
  (rule_id, observed_value, expected_value, payload, status,
   delivered_at, delivery_error, created_by, updated_by)
VALUES
  (%(rule_id)s, %(observed)s, %(expected)s, %(payload)s, 'new',
   %(delivered_at)s, %(error)s, %(actor)s, %(actor)s)
RETURNING id
"""


@dataclass
class AlertResult:
    evaluated: int = 0
    skipped_not_due: int = 0
    skipped_owner_disabled: int = 0
    fired: int = 0
    delivered: int = 0
    suppressed_no_access: int = 0
    delivery_failures: int = 0
    details: list[str] = field(default_factory=list)

    def __str__(self) -> str:
        return (
            f"{self.evaluated} rules evaluated, {self.fired} fired, "
            f"{self.delivered} delivered, "
            f"{self.suppressed_no_access} suppressed (no access), "
            f"{self.delivery_failures} delivery failures, "
            f"{self.skipped_not_due} not due"
        )


def _db_now() -> datetime:
    """Wall clock as the database sees it."""
    row = fetch_one("SELECT now() AS t")
    assert row is not None
    return row["t"]


def _load_rules() -> list[tuple[Rule, datetime | None, str]]:
    out = []
    for r in fetch_all(RULES):
        channels = r["channels"]
        if isinstance(channels, str):
            channels = json.loads(channels)
        rule = Rule(
            id=str(r["id"]),
            name=r["name"],
            owner_user_id=str(r["owner_user_id"]),
            owner_email=r["owner_email"],
            owner_role=r["owner_role"],
            type=r["type"],
            scope_provider=r["scope_provider"],
            scope_account=r["scope_account"],
            scope_service=r["scope_service"],
            metric=r["metric"],
            comparator=r["comparator"],
            threshold_value=r["threshold_value"],
            window_days=r["window_days"],
            frequency=r["frequency"],
            channels=list(channels or ["inapp"]),
        )
        out.append((rule, r["last_fired_at"], r["owner_status"]))
    return out


def _notifiers(extra: dict[str, Notifier] | None = None) -> dict[str, Notifier]:
    built: dict[str, Notifier] = {
        InAppNotifier.channel: InAppNotifier(),
        SesNotifier.channel: SesNotifier(),
    }
    built.update(extra or {})
    return built


def run(
    *,
    today: date | None = None,
    now: datetime | None = None,
    notifiers: dict[str, Notifier] | None = None,
    actor: str = SYSTEM_EMAIL,
) -> AlertResult:
    today = today or date.today()
    # The DATABASE clock, not this process's. fired_at is written by
    # Postgres now(), so comparing it against a local clock makes
    # throttling depend on skew -- measured at +4.1s against Neon, which
    # was enough to make a just-fired rule look "not due".
    now = now or _db_now()
    channels = _notifiers(notifiers)
    result = AlertResult()

    for rule, last_fired, owner_status in _load_rules():
        if owner_status == "disabled":
            result.skipped_owner_disabled += 1
            continue
        if not due(rule, last_fired, now):
            result.skipped_not_due += 1
            continue

        # ---- FR-34, checked BEFORE evaluating ------------------------
        # Rules are evaluated as their owner, through query/scoped, so a
        # lapsed grant already yields no data and therefore no alert. That
        # is the safe outcome but a silent one: the owner stops hearing
        # anything and assumes spend is fine.
        #
        # So the access check comes first and, when it fails, records a
        # notice carrying no figures -- the signal survives without
        # leaking amounts into a feed its owner may no longer read.
        if not resolve.can_see(
            rule.owner_user_id,
            provider=rule.scope_provider,
            account_id=rule.scope_account,
            service_name=rule.scope_service,
            is_superadmin=rule.owner_is_superadmin,
        ):
            if _lapse_already_recorded(rule.id, now):
                result.skipped_not_due += 1
            else:
                _record_lapse(rule, actor)
                result.suppressed_no_access += 1
                result.details.append(f"SUPPRESSED {rule.name}: access lapsed")
            continue

        result.evaluated += 1
        try:
            event = evaluator.evaluate(rule, today=today, since=last_fired)
        except Exception:
            log.exception("rule %s (%s): evaluation failed", rule.name, rule.id)
            continue

        if event is None:
            continue

        result.fired += 1
        _deliver(event, channels, result, actor)

    log.info("alerts: %s", result)
    return result


LAST_LAPSE = """
SELECT max(e.fired_at) AS t
FROM alert_events e
WHERE e.rule_id = %(rule_id)s
  AND e.delivery_error LIKE 'not delivered:%%'
"""


def _lapse_already_recorded(rule_id: str, now: datetime) -> bool:
    """Throttle the lapse notice to once a day, whatever the frequency.

    Otherwise an `immediate` rule whose grant has gone would record a
    notice on every single run.

    `now` is the database clock (see `_db_now`), matching `fired_at`.
    """
    row = fetch_all(LAST_LAPSE, {"rule_id": rule_id})
    last = row[0]["t"] if row else None
    return bool(last and (now - last).total_seconds() < 23 * 3600)


def _record_lapse(rule: Rule, actor: str) -> None:
    """Record that a rule is inactive because its owner lost access.

    Deliberately carries no cost figures: the owner can read their own
    feed, and they are no longer entitled to the numbers.
    """
    scope = resolve.describe(
        rule.scope_provider, rule.scope_account, rule.scope_service
    )
    notice = Event(
        rule=rule,
        observed_value=None,
        expected_value=None,
        subject=f"[cost] {rule.name} is inactive",
        body=(
            f"This rule is not running because {rule.owner_email} no longer "
            f"has access to {scope}. Ask a superadmin to restore the grant, "
            f"or delete the rule."
        ),
        payload={"scope": scope, "reason": "access_lapsed"},
    )
    _record(
        notice, actor,
        delivered_at=None,
        error=f"not delivered: {rule.owner_email} no longer has access to {scope}",
    )


def _deliver(
    event: Event,
    channels: dict[str, Notifier],
    result: AlertResult,
    actor: str,
) -> None:
    rule = event.rule
    known = [c for c in rule.channels if c in channels]
    unknown = [c for c in rule.channels if c not in channels]

    deliveries = [
        channels[c].send(event, recipients=[rule.owner_email]) for c in known
    ]
    # An unmatched channel is an explicit failure. Silently dropping it
    # left ok and bad both empty, so the event was recorded with neither
    # delivered_at nor delivery_error, no counter moved, and the feed
    # showed HELD with a blank reason -- forever.
    deliveries += [
        Delivery(c, False, f"no notifier registered for channel {c!r}")
        for c in unknown
    ]

    ok = [d for d in deliveries if d.sent]
    bad = [d for d in deliveries if not d.sent]

    _record(
        event, actor,
        delivered_at=datetime.now(timezone.utc) if ok else None,
        error="; ".join(f"{d.channel}: {d.error}" for d in bad) or None,
    )

    if ok:
        result.delivered += 1
    if bad:
        result.delivery_failures += 1
    result.details.append(
        f"{'FIRED' if ok else 'FAILED'} {rule.name}: {event.subject}"
    )


def _record(event: Event, actor: str, *, delivered_at, error: str | None) -> str:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            INSERT_EVENT,
            {
                "rule_id": event.rule.id,
                "observed": event.observed_value,
                "expected": event.expected_value,
                "payload": json.dumps(
                    {"subject": event.subject, "body": event.body, **event.payload},
                    default=str,
                ),
                "delivered_at": delivered_at,
                "error": error,
                "actor": actor,
            },
        )
        row = cur.fetchone()
        assert row is not None
        return str(row["id"])
