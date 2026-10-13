"""A card: one checkable claim, with the figures it rests on.

Built by `facts.py` from scoped reads. Everything a sentence about the
card can say is in `figures`; `display` is the same figures formatted
for a person, so the UI can put them beside the sentence.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from costhub.insights import fmt

CENT = Decimal("0.01")

# Percent is noise on a small base (scoped.compare says the same), so it
# is withheld rather than shown when the previous value is under this.
MIN_PCT_BASE = Decimal("1.00")


@dataclass(frozen=True)
class Card:
    id: str
    kind: str
    title: str            # where rank is stated ("Largest increase ...")
    direction: str        # up | down | flat | none
    subject: dict[str, Any]
    figures: dict[str, Any]
    display: dict[str, str]
    # How the subject is written inside a sentence. None means the name
    # cannot be written safely, and the card gets figures and no prose.
    name: str | None = None


def cents(v: Any) -> Decimal:
    return Decimal(str(v or 0)).quantize(CENT, rounding=ROUND_HALF_UP)


def pct_of(delta: Decimal, base: Decimal) -> float | None:
    """Percent change, or None when it would mislead or round to nothing."""
    if base < MIN_PCT_BASE:
        return None
    value = round(float(delta / base * 100), 1)
    return value or None            # 0.0 and -0.0 both say nothing


def direction_of(delta: Decimal) -> str:
    return "up" if delta > 0 else "down" if delta < 0 else "flat"


# A name is data from a cloud bill -- a marketplace seller chooses theirs
# -- and it is printed inside a sentence. "EC2 dropped to zero. RDS" as
# a service name would otherwise read as two claims.
#
# The first attempt at this was a list of words a name must not contain.
# A review walked straight past it ("dropped", "halved", "All services"),
# which is the lesson of this whole package again: do not list what is
# bad, define what is good. So a name is printed bare only if it LOOKS
# like a name -- every word capitalised or a number, no sentence
# punctuation. Anything else goes in quotation marks, where it can only
# be read as a name. And a name containing anything that could close
# those marks early, or hide text, is not put in a sentence at all.
MAX_NAME = 120
JOINERS = frozenset({"-", "&", "and", "for", "of"})
NAME_WORD = re.compile(r"^[A-Z0-9][A-Za-z0-9]*$")
# Capitalised words that would still turn a name into a claim about
# everything ("All Services rose by ..."). Deliberately short: the shape
# rule above does the work, and "Service" and "Cost" are in half of
# every provider's catalogue.
CLAIM_WORDS = frozenset(
    "all every each other others everything total spend spending "
    "rose fell up down more less".split())
OPEN_QUOTE, CLOSE_QUOTE = "“", "”"


def _looks_like_a_name(text: str) -> bool:
    words = text.split(" ")
    return all(w in JOINERS or NAME_WORD.match(w) for w in words) and not any(
        w.lower() in CLAIM_WORDS for w in words)


def _quotable(text: str) -> bool:
    """Only characters that cannot end the quotation or hide inside it."""
    for ch in text:
        if ch == " " or (ch.isascii() and ch.isprintable() and ch != chr(34)):
            continue
        # Beyond ASCII: letters, marks and digits of any script, nothing else.
        if unicodedata.category(ch)[0] not in "LMN":
            return False
    return True


def sentence_name(raw: object) -> str | None:
    text = str(raw or "")
    if not text or text != text.strip() or len(text) > MAX_NAME or "  " in text:
        return None
    if not _quotable(text):
        return None
    return text if _looks_like_a_name(text) else f"{OPEN_QUOTE}{text}{CLOSE_QUOTE}"


def change(cur: Decimal, prev: Decimal, ccy: str) -> tuple[dict, dict]:
    """Figures and display for a period-over-period change.

    Rounded to cents FIRST, then subtracted, so a reader who takes
    `previous` from `current` gets exactly `delta_abs`.
    """
    cur, prev = cents(cur), cents(prev)
    delta = cur - prev
    pct = pct_of(delta, prev)
    figures = {"current": cur, "previous": prev, "delta_abs": delta, "delta_pct": pct}
    display = {
        "current": fmt.money(cur, ccy),
        "previous": fmt.money(prev, ccy),
        "delta_abs": fmt.signed_money(delta, ccy),
    }
    if pct is not None:
        display["delta_pct"] = fmt.signed_pct(pct)
    return figures, display


def total(cur: Decimal, prev: Decimal | None, ccy: str) -> Card:
    if prev is None:
        cur = cents(cur)
        return Card("total", "total", "Total spend in this view", "none",
                    {"type": "total"}, {"current": cur},
                    {"current": fmt.money(cur, ccy)}, name="Total spend")
    figures, display = change(cur, prev, ccy)
    return Card("total_change", "total_change",
                "Total spend in this view, period over period",
                direction_of(figures["delta_abs"]), {"type": "total"},
                figures, display, name="Total spend")


def mover(kind: str, title: str, dimension: str, key: str,
          cur: Decimal, prev: Decimal, ccy: str) -> Card:
    figures, display = change(cur, prev, ccy)
    subject_key = "service_name" if dimension == "service" else "account_id"
    return Card(kind, kind, title, direction_of(figures["delta_abs"]),
                {"type": dimension, subject_key: key}, figures,
                {dimension: fmt.entity(dimension, key), **display},
                name=sentence_name(key))


def share(key: str, cur: Decimal, whole: Decimal, ccy: str) -> Card:
    part = round(float(cur / whole * 100), 1)
    return Card(
        "top_service", "top_service", "Largest service by spend", "none",
        {"type": "service", "service_name": key},
        {"current": cur, "total": whole, "share_pct": part},
        {"service": str(key), "current": fmt.money(cur, ccy),
         "total": fmt.money(whole, ccy), "share": fmt.pct(part)},
        name=sentence_name(key),
    )


def anomaly(i: int, row: dict, ccy: str, on_file: int | None) -> Card:
    """One unacknowledged finding from the MAD detector.

    The wording follows what `anomaly/mad.py` actually stores, which is
    not what the column names suggest:

      * `observed_value` is the HIGHEST single day in the flagged run
        (or, for a slow drift, a median that some day reached). So it is
        "daily cost as high as X" -- not a rate that held, and not the
        cost on the finding's date.
      * `detected_for_date` is the first flagged day the detector could
        still see when it ran. For an anomaly that has gone on for
        weeks, that is not when it began. So the finding is "dated",
        not "beginning".
      * nothing ever closes a finding; `status = 'new'` means nobody
        has acknowledged it. So it is "unacknowledged", not "open" or
        "ongoing".
      * `kind` is re-derived every night from a sliding week and is not
        stable for one event, so it is shown as the detector's label in
        `display` and left out of the sentence.

    `on_file` is how many unacknowledged findings this account and
    service have in the window (None if that could not be counted).
    """
    base, seen = cents(row["baseline_value"]), cents(row["observed_value"])
    delta = seen - base
    pct = pct_of(delta, base)
    display = {
        "service": str(row["service_name"]),
        "account": fmt.entity("account", row["account_id"]),
        "date": fmt.day(row["detected_for_date"]),
        "kind": fmt.ANOMALY_KINDS.get(row["kind"], "anomaly"),
        "baseline": f"{fmt.money(base, ccy)} a day",
        # Bare, because the two code paths mean different things by it;
        # the sentence supplies "daily cost as high as", true of both.
        "observed": fmt.money(seen, ccy),
        "delta_abs": fmt.signed_money(delta, ccy),
    }
    if pct is not None:
        display["delta_pct"] = fmt.signed_pct(pct)
    service, account = sentence_name(row["service_name"]), sentence_name(row["account_id"])
    return Card(
        f"anomaly_{i}", "anomaly", "Unacknowledged anomaly finding", direction_of(delta),
        {"type": "anomaly", "finding_id": str(row["id"]),
         "provider": row["provider"], "account_id": row["account_id"],
         "service_name": row["service_name"],
         "detected_for_date": row["detected_for_date"], "method": row["method"]},
        {"baseline": base, "observed": seen, "delta_abs": delta, "delta_pct": pct,
         "anomaly_kind": row["kind"], "per": "day", "metric": "effective_cost",
         "findings_on_file": on_file},
        display,
        # A finding is per account AND service, so the name is both.
        name=f"{service} in account {account}" if service and account else None,
    )
