"""How a figure is written out.

Every display string says what it is as well as how much -- "$2,676.10
in the current period", "+18.2%", "a baseline of $40.00". That is on
purpose. The model arranges these strings into a sentence, and a value
that carries its own label cannot be passed off as a different one:
swapping `{current}` and `{previous}` still prints each with the right
period attached, and a delta always shows its sign.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

ANOMALY_KINDS = {
    "step": "step change",
    "spike": "one-off spike",
    "creep": "gradual creep",
}

MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def money(v: Decimal, currency: str = "USD") -> str:
    body = f"{abs(v):,.2f}"
    sign = "-" if v < 0 else ""
    if currency == "USD":
        return f"{sign}${body}"
    return f"{sign}{body} {currency}"


def signed_money(v: Decimal, currency: str = "USD") -> str:
    """Always signed, so the direction is in the number itself."""
    if v == 0:
        return money(v, currency)
    sign = "+" if v > 0 else "-"
    return f"{sign}{money(abs(v), currency)}"


def pct(v: float) -> str:
    return f"{v:,.1f}%"


def signed_pct(v: float) -> str:
    if v == 0:
        return pct(v)
    return f"{'+' if v > 0 else '-'}{pct(abs(v))}"


def day(d: date) -> str:
    return f"{d.day} {MONTHS[d.month - 1]} {d.year}"


def entity(dimension: str, key: str) -> str:
    """A service name is shown as it is stored; an account says it is one."""
    if dimension == "account":
        return f"account {key}"
    return str(key)
