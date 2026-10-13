"""Every sentence /insights can show. The model writes none of them.

The first version of this package let a model write sentence templates
and checked them against a word allowlist with rules about which
placeholder could follow which word. A review broke it in an afternoon:

    "{service} saw an increase in spend of {current}."
    -> Amazon RDS saw an increase in spend of $1,980.00.   (it was $769.60)

One ordinary word between "increase" and the figure detached the number
from its meaning, and no finite list of rules stops English doing that.
The lesson is that free prose cannot be PROVEN to be supported by the
figures -- only made less likely to be wrong -- and "less likely" is not
the bar this feature has.

So the roles are split the other way. This module writes the candidate
sentences for each card, each one true by construction from that card's
own figures. The model's only job is to CHOOSE: which candidate to show
for each card, and which card to lead with. It answers with card ids and
integers. No text the model wrote is ever stored or shown, so there is
nothing left to verify except that an integer is in range.

A second review then showed where the remaining risk is: not in the
wording but in what the figures MEAN. A sentence can be well-formed and
still false if the periods should not have been compared (coverage.py),
if "the detector's observed value" is one peak day (cards.anomaly), or
if "total spend" is really one service's under a filter. Hence the two
habits below.

Every candidate must be true for EVERY card of its kind that facts.py
can build. That is the whole review burden, and it is all in this file.

Every amount is "in this view". The caller's grants and filters decide
what a total or an account's spend includes, so a bare "Total spend" or
"Spend in account X" can be false of the estate while true of the page.
"""
from __future__ import annotations

from costhub.insights.cards import Card

# Bump when candidates change: it is part of the cache key, because a
# stored choice is an index into this exact list.
FRAMES_VERSION = "2"


def _mag(signed: str) -> str:
    """Drop a leading sign. Used only after a word that states the direction."""
    return signed.lstrip("+-")


def _change(subject: str, card: Card) -> list[str]:
    """Sentences for a period-over-period change in `subject`'s spend."""
    d = card.display
    prev, cur = d["previous"], d["current"]
    span = f"from {prev} in the previous period to {cur} in the current period"
    if card.direction == "flat":
        return [
            f"{subject} was {cur} in both periods.",
            f"{subject} was {cur} in the current period, the same as in the previous period.",
        ]
    up = card.direction == "up"
    rose, grew, more, way = (
        ("rose", "increased", "more", "up") if up else ("fell", "decreased", "less", "down")
    )
    amount = _mag(d["delta_abs"])
    out = [
        f"{subject} {rose} by {amount}, {span}.",
        f"{subject} {grew} by {amount} to {cur}, {way} from {prev} in the previous period.",
        f"{subject} was {cur} in the current period, {amount} {more} than in the previous period.",
    ]
    if "delta_pct" in d:
        rate = _mag(d["delta_pct"])
        out += [
            f"{subject} {rose} {rate}, {span}.",
            f"{subject} was {cur} in the current period, {way} {rate} from {prev} in the previous period.",
        ]
    return out


def _anomaly(card: Card) -> list[str]:
    """See cards.anomaly for why each of these words was chosen."""
    d, f = card.display, card.figures
    seen, base, dated = d["observed"], d["baseline"], d["date"]
    out = [
        f"The detector has an unacknowledged finding for {card.name}, dated {dated}: "
        f"daily cost as high as {seen}, against a baseline of {base}.",
        f"An unacknowledged anomaly finding for {card.name}, dated {dated}, records "
        f"daily cost as high as {seen} against a baseline of {base}.",
        f"For {card.name}, an unacknowledged finding dated {dated} records daily cost "
        f"as high as {seen}, {_mag(d['delta_abs'])} above its baseline of {base}.",
    ]
    others = f.get("findings_on_file")
    if isinstance(others, int) and others > 1:
        out.append(
            f"The detector has {others} unacknowledged findings for {card.name} in this "
            f"period; the largest, dated {dated}, records daily cost as high as {seen} "
            f"against a baseline of {base}."
        )
    return out


def candidates(card: Card) -> list[str]:
    """Every sentence that may be shown for this card. Empty = figures only."""
    d, name = card.display, card.name
    if name is None:
        return []           # a name that cannot be written safely: no prose
    if card.kind == "total":
        return [
            f"Total spend in this view was {d['current']} in the current period.",
            f"Spend in this view came to {d['current']} in the current period.",
        ]
    if card.kind == "total_change":
        return _change("Total spend in this view", card)
    if card.kind == "top_service":
        cur, part, whole = d["current"], d["share"], d["total"]
        return [
            f"{name} was the largest service by spend in this view, at {cur} "
            "in the current period.",
            f"{name} accounted for {part} of the {whole} spent in this view "
            "in the current period.",
            f"The largest share of spend in this view in the current period went to "
            f"{name}: {cur}, which is {part} of the {whole} total.",
        ]
    if card.kind == "new_service":
        cur = d["current"]
        return [
            f"{name} had no recorded spend in this view in the previous period "
            f"and {cur} in the current period.",
            f"Spend on {name} in this view was {cur} in the current period, with none "
            "recorded in the previous period.",
        ]
    if card.kind in ("top_increase", "top_decrease"):
        return _change(f"Spend on {name} in this view", card)
    if card.kind == "account_mover":
        return _change(f"Spend in account {name} in this view", card)
    if card.kind == "anomaly" and card.direction == "up":
        return _anomaly(card)
    return []


def select(
    cards: list[Card], choices: object,
) -> tuple[dict[str, str], dict[str, str], dict[str, int]]:
    """Apply the model's choices.

    Returns the sentence per card id, the reason for each card left
    without one, and the choices that were valid (the only thing worth
    storing). A reason is one of this module's own constants -- never
    anything the model said.
    """
    picked = choices if isinstance(choices, dict) else {}
    texts: dict[str, str] = {}
    refused: dict[str, str] = {}
    kept: dict[str, int] = {}
    for card in cards:
        options = candidates(card)
        choice = picked.get(card.id)
        if not options:
            refused[card.id] = "name_withheld"
        elif isinstance(choice, bool) or not isinstance(choice, int):
            refused[card.id] = "not_chosen"
        elif not 0 <= choice < len(options):
            refused[card.id] = "out_of_range"
        else:
            texts[card.id] = options[choice]
            kept[card.id] = choice
    return texts, refused, kept


def lead(cards: list[Card], wanted: object, texts: dict[str, str]):
    """The card the model would show first -- if it named a real, narrated one."""
    return wanted if isinstance(wanted, str) and wanted in texts else None
