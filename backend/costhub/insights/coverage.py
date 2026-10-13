"""May a change between two periods be reported at all?

Every false sentence this package could still produce after the model
stopped writing came from here: the arithmetic was right and the data
under it was incomplete. Flat spend with yesterday's rows not yet
ingested read as "Total spend fell 3.3%". A newly connected account
read as "rose from $0.00". A stalled ingest read as a fall.

Two earlier rules, and why each was wrong:

  * "The windows have about the same number of days with data (within
    10%)." The tolerance was itself the error: it let a three-day gap
    through as a ten percent change.
  * "Every account has cost ROWS on every day." Stricter, and wrong the
    other way. Zero-cost days are not stored, so an account that was
    fully ingested and simply spent nothing looked like a gap. On the
    first real estate this ran against, one quiet account blocked every
    comparison -- while having been ingested end to end.

Rows cannot tell "nothing was spent" from "nothing was loaded". The
ingest log can, so that is what is asked now:

  * FINAL. Providers restate recent days, and ingest runs once a day.
    The detector skips the last two days for the same reason
    (`MadDetector.exclude_recent_days`); so does this.
  * INGESTED, PER ACCOUNT. For every account in view, successful ingest
    runs must together cover every day of BOTH windows. Per account,
    because ingestion is per account: one healthy account otherwise
    hides another's gap.

When it fails, no card states a change and `note` says which condition
failed, for which account and from which day.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone

import psycopg

from costhub.db import fetch_all
from costhub.insights.cards import sentence_name
from costhub.query import scoped
from costhub.query.scoped import Filters, Principal

log = logging.getLogger(__name__)

# Days before today still treated as unfinal. Matches the detector.
FINAL_LAG_DAYS = 2
# Past this, do not claim a change rather than verify only some accounts.
MAX_ACCOUNTS = 200

Span = tuple[date, date]        # [start, end) -- the end day is NOT included


def last_final_day() -> date:
    """The most recent day whose cost is settled enough to compare."""
    return datetime.now(timezone.utc).date() - timedelta(days=FINAL_LAG_DAYS + 1)


def ingested(accounts: list[str], provider: str | None, lo: date, hi: date) -> dict[str, list[Span]]:
    """Per account, the periods successful ingest runs covered.

    Reads the ingest log, not cost: it holds dates and statuses, no
    figures. It is only ever asked about accounts the caller's own
    scoped read has already returned, so it cannot reveal one.

    `period_end` is exclusive, as the runner writes it
    (`cost_explorer.default_window`: "[today - days, today + 1)").
    """
    rows = fetch_all(
        """
        SELECT account_id, period_start, period_end
        FROM ingest_runs
        WHERE status = 'success'
          AND account_id = ANY(%(accounts)s)
          AND (%(provider)s::text IS NULL OR provider = %(provider)s)
          AND period_end > %(lo)s AND period_start <= %(hi)s
        ORDER BY account_id, period_start
        """,
        {"accounts": accounts, "provider": provider, "lo": lo, "hi": hi},
    )
    out: dict[str, list[Span]] = {}
    for r in rows:
        out.setdefault(r["account_id"], []).append((r["period_start"], r["period_end"]))
    return out


def first_gap(spans: list[Span], lo: date, hi: date) -> date | None:
    """The first day in [lo, hi] no span covers, or None if all are."""
    need = lo
    for start, end in sorted(spans):
        if start > need:
            break
        need = max(need, end)
        if need > hi:
            return None
    return need if need <= hi else None


def check(who: Principal, current: Filters, previous: Filters) -> tuple[bool, str | None, int]:
    """(comparable, note, accounts checked). Reads as the caller, like everything else."""
    if current.end > last_final_day():
        return False, (
            f"The period includes days after {last_final_day():%d %b %Y}, whose cost "
            "is still being finalised by the provider, so it is not compared with "
            "an earlier one."), 0

    # Both windows at once, and no service filter: whether an account
    # was ingested is not a property of one service.
    both = Filters(start=previous.start, end=current.end, provider=current.provider,
                   account_id=current.account_id, metric=current.metric)
    accounts = [r["key"] for r in
                scoped.by_dimension(who, both, "account", limit=MAX_ACCOUNTS + 1)]
    if len(accounts) > MAX_ACCOUNTS:
        return False, (
            f"More than {MAX_ACCOUNTS} accounts are in view, too many to confirm "
            "each was fully ingested, so no change is reported. Filter to fewer."), 0
    if not accounts:
        return False, None, 0

    try:
        runs = ingested(accounts, current.provider, previous.start, current.end)
    except psycopg.Error as exc:
        log.error("insights: ingest log unreadable, no change reported: %s", exc)
        return False, ("Whether the cost data is complete could not be confirmed, "
                       "so no change is reported."), 0

    for account in sorted(accounts):
        gap = first_gap(runs.get(account, []), previous.start, current.end)
        if gap is not None:
            name = sentence_name(account) or "one account"
            return False, (
                f"Account {name} has no successful ingest covering {gap:%d %b %Y}. "
                "A change is only reported when every account in view was ingested "
                "for every day of both periods."), len(accounts)
    return True, None, len(accounts)
