"""Which cards exist, and the figures on them.

Each read goes through `query/scoped` with the caller's own Principal,
so a card can only hold what that caller's grants let them chart. There
is no SQL in this module and no Principal is constructed in it.

All arithmetic happens here, in Decimal, before any model is involved.
This module also decides what must NOT be claimed. A card is left out
whenever its title or its sentences could be false of the data: a
change between periods that `coverage.check` will not vouch for, a
"largest" that is a tie, a share when a refund is in the mix, anything
at all when two currencies would have been added together.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from costhub.insights import cards, coverage
from costhub.insights.cards import Card, cents
from costhub.query import scoped
from costhub.query.scoped import Filters, Principal

# A mover below this is not worth a sentence: $0.40 -> $0.90 is +125%
# and nobody should be shown it as a finding.
MIN_DELTA = Decimal("1.00")
DIMENSION_LIMIT = 5000
MAX_ANOMALIES = 3
ZERO = Decimal(0)


@dataclass
class Summary:
    cards: list[Card] = field(default_factory=list)
    currency: str = "USD"
    comparison: dict[str, Any] = field(default_factory=dict)


@dataclass
class _Read:
    """The scoped reads, remembering every currency seen in them."""

    currencies: set[str] = field(default_factory=set)

    def totals(self, who: Principal, f: Filters) -> tuple[Decimal, int]:
        rows = scoped.series(who, f, grain="day")
        self.currencies |= {r["currency"] for r in rows if r.get("currency")}
        return cents(sum((Decimal(str(r["cost"] or 0)) for r in rows), ZERO)), len(rows)

    def by(self, who: Principal, f: Filters, dimension: str) -> tuple[dict[str, Decimal], bool]:
        """Cost per key, and whether the list was cut off.

        `scoped.compare` is not used: it compares two top-50 lists, so in
        a wide estate a service ranked 51st in one window reads as $0
        there -- and "no spend in the previous period" would be a
        sentence about a LIMIT clause.
        """
        rows = scoped.by_dimension(who, f, dimension, limit=DIMENSION_LIMIT)
        self.currencies |= {r["currency"] for r in rows if r.get("currency")}
        return {r["key"]: cents(r["cost"]) for r in rows}, len(rows) >= DIMENSION_LIMIT


def _the_one(values: dict[str, Decimal], *, largest: bool = True) -> str | None:
    """The key with the largest (or smallest) value -- or None on a tie.

    "The largest" is a claim, and with two services at the same figure
    it is true of neither. No card is better than a coin toss.
    """
    if not values:
        return None
    best = (max if largest else min)(values.values())
    keys = [k for k, v in values.items() if v == best]
    return keys[0] if len(keys) == 1 else None


def _service_cards(now: dict, was: dict, total: Decimal, ccy: str,
                   comparable: bool, cut: bool) -> list[Card]:
    out: list[Card] = []
    if cut:
        return out          # the list is incomplete: rank nothing from it
    # A share needs every part to be non-negative: with a refund in the
    # mix, the biggest service can be "167% of total spend".
    top = _the_one(now)
    if top and total > 0 and min(now.values()) >= 0:
        out.append(cards.share(top, now[top], total, ccy))
    if not comparable:
        return out

    deltas = {k: now.get(k, ZERO) - was.get(k, ZERO) for k in set(now) | set(was)}

    def card(kind: str, title: str, k: str) -> Card:
        return cards.mover(kind, title, "service", k, now.get(k, ZERO),
                           was.get(k, ZERO), ccy)

    # Over EVERY service, new ones included: a service that went from
    # nothing to $900 is an increase. Ranked by amount, and the title
    # says so -- another service may have the larger percentage.
    up = _the_one(deltas)
    if up and deltas[up] >= MIN_DELTA:
        out.append(card("top_increase", "Largest increase in spend, by service", up))
    down = _the_one(deltas, largest=False)
    if down and deltas[down] <= -MIN_DELTA:
        out.append(card("top_decrease", "Largest decrease in spend, by service", down))

    # `k not in was`, not `was[k] == 0`: a third of a cent last period
    # rounds to $0.00, and "no recorded spend" would then be false.
    fresh = {k: v for k, v in now.items() if k not in was and v >= MIN_DELTA}
    new = _the_one(fresh)
    # If the largest new service already has the increase card, there is
    # no second card: the runner-up is not "the largest new service".
    if new and new != up:
        out.append(card("new_service",
                        "Largest service with no recorded spend in the previous period", new))
    return out


def _account_card(now: dict, was: dict, ccy: str) -> Card | None:
    keys = set(now) | set(was)
    if len(keys) < 2:
        return None
    sizes = {k: abs(now.get(k, ZERO) - was.get(k, ZERO)) for k in keys}
    k = _the_one(sizes)
    if k is None or sizes[k] < MIN_DELTA:
        return None
    return cards.mover("account_mover", "Largest change in spend, by account", "account",
                       k, now.get(k, ZERO), was.get(k, ZERO), ccy)


def _anomaly_cards(findings: list[dict], f: Filters, ccy: str, complete: bool) -> list[Card]:
    """Unacknowledged findings dated inside the window: one per series.

    `findings` arrives already scoped to the caller -- see the route.
    This narrows it to the filters on screen and removes repeats. The
    detector re-scans a trailing week every night and dates a finding at
    the first flagged day it can still SEE, so a step that began three
    weeks ago is on file a dozen times with a dozen dates. Showing three
    of those as three anomalies would be showing one thing three times,
    so each (account, service) gets one card: its largest finding, with
    a count of the others.
    """
    if f.metric != "effective_cost":
        return []           # the detector only ever reads effective_cost
    by_series: dict[tuple, list[dict]] = {}
    for r in findings:
        if (f.start <= r["detected_for_date"] <= f.end
                and (f.provider is None or r["provider"] == f.provider)
                and (f.account_id is None or r["account_id"] == f.account_id)
                and (f.service_name is None or r["service_name"] == f.service_name)
                # Only what this module knows how to describe truthfully.
                and r.get("method") == "mad"
                and r.get("baseline_value") is not None
                and r.get("observed_value") is not None
                and cents(r["observed_value"]) > cents(r["baseline_value"])):
            by_series.setdefault(
                (r["provider"], r["account_id"], r["service_name"]), []).append(r)

    def size(r: dict) -> tuple:
        return (cents(r["observed_value"]) - cents(r["baseline_value"]),
                r["detected_for_date"], str(r["id"]))

    biggest = sorted((max(rows, key=size) for rows in by_series.values()),
                     key=size, reverse=True)
    return [
        cards.anomaly(i, r, ccy,
                      len(by_series[(r["provider"], r["account_id"], r["service_name"])])
                      if complete else None)
        for i, r in enumerate(biggest[:MAX_ANOMALIES], start=1)
    ]


def summarize(
    who: Principal, current: Filters, previous: Filters, findings: list[dict],
    *, findings_complete: bool = True,
) -> Summary:
    """Build every card for this caller and these filters."""
    read = _Read()
    total, days_now = read.totals(who, current)
    was_total, days_was = read.totals(who, previous)
    span = (current.end - current.start).days + 1
    comparable, note, checked = (
        coverage.check(who, current, previous) if days_now else (False, None, 0))

    services: tuple[dict, dict, bool] | None = None
    accounts: tuple[dict, dict, bool] | None = None
    if days_now and current.service_name is None:
        now, cut_a = read.by(who, current, "service")
        was, cut_b = read.by(who, previous, "service") if comparable else ({}, False)
        services = (now, was, cut_a or cut_b)
    if days_now and current.account_id is None:
        # Read even when no change is reportable: accounts are where two
        # currencies meet, and that has to be noticed either way.
        now, cut_a = read.by(who, current, "account")
        was, cut_b = read.by(who, previous, "account") if comparable else ({}, False)
        accounts = (now, was, cut_a or cut_b)

    ccy = min(read.currencies) if read.currencies else "USD"
    out = Summary(currency=ccy, comparison={
        "comparable": comparable,
        "current_days_with_data": days_now,
        "previous_days_with_data": days_was,
        "days_in_period": span,
        "accounts_checked": checked,
        "note": note,
    })
    if days_now == 0:
        return out          # nothing visible: no cards, and no model call
    if len(read.currencies) > 1:
        # The store adds amounts without converting them. A total of
        # dollars plus euros is not a figure, so none is shown.
        out.comparison.update(comparable=False, note=(
            "Spend in more than one currency is in view "
            f"({', '.join(sorted(read.currencies))}) and is not added together "
            "here. Filter to one provider or account."))
        return out

    out.cards.append(cards.total(total, was_total if comparable else None, ccy))
    if services:
        now, was, cut = services
        out.cards += _service_cards(now, was, total, ccy, comparable, cut)
    # Not under a service filter: "spend in account X" would then mean
    # one service's spend there, and could move the opposite way.
    if accounts and comparable and not accounts[2] and current.service_name is None:
        card = _account_card(accounts[0], accounts[1], ccy)
        if card:
            out.cards.append(card)
    out.cards += _anomaly_cards(findings, current, ccy, findings_complete)
    return out


def window_before(start: date, end: date) -> tuple[date, date]:
    """The immediately preceding window of equal length (as /cost/compare)."""
    prev_end = start - timedelta(days=1)
    return prev_end - (end - start), prev_end
