"""Narration over numbers the backend already computed.

The rule this package exists to keep: **nothing a model wrote is ever
shown.** The backend computes the figures and writes every sentence
that could describe them; the model only chooses which sentence to show
for each card and which card to lead with.

    facts.py    which cards exist, read through query/scoped with the
                CALLER'S Principal -- the only place figures come from
    cards.py    a card: its figures, their display, a safe name
    fmt.py      how a figure is written out
    frames.py   every sentence that can be shown, true by construction
    narrate.py  the prompt and the single Bedrock call
    cache.py    the Postgres ledger: cache, call meter and lock
    service.py  the order those happen in, and every way it degrades

Read frames.py first. Its docstring records why the model does not
write the prose: an earlier version let it, behind a verifier, and a
review showed the verifier could not hold.
"""
