"""Human-readable rendering of ingest results.

Split out of `runner.py` purely to keep that module under the 300-line
limit (NFR-18). There is no DB access and no I/O here -- it is string
formatting over `RunResult`, which is why it was the part safe to move:
the fact-table SQL has to stay in `runner.py`, because the invariant test
asserts that `fact_cost_daily` is written from exactly two modules.
"""
from __future__ import annotations

from typing import Sequence

from costhub.ingest.runner import RunResult


def _trim(error: str | None, r: RunResult) -> str:
    """Drop the adapter's own "name (account):" prefix; the line already has it."""
    msg = error or ""
    prefix = f"{r.connection} ({r.account_id}): "
    return (msg[len(prefix):] if msg.startswith(prefix) else msg)[:140]


def summarize(results: Sequence[RunResult]) -> str:
    if not results:
        return "no connections ingested"
    lines = []
    for r in results:
        mark = "ok  " if r.ok else "FAIL"
        detail = f"{r.rows} rows" if r.ok else _trim(r.error, r)
        lines.append(f"  {mark} {r.connection} ({r.account_id}): {detail}")
    total = sum(r.rows for r in results)
    failed = sum(1 for r in results if not r.ok)
    lines.append(f"  -- {total} rows, {failed} failed of {len(results)}")
    return "\n".join(lines)
