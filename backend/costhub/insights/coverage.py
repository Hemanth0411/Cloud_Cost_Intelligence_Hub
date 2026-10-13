"""May a change between two periods be reported at all?

Every false sentence this package could still produce after the model
stopped writing came from here: the arithmetic was right and the data
under it was incomplete. Flat spend with yesterday's rows not yet
ingested read as "Total spend fell 3.3%". A newly connected account
read as "rose from $0.00". A stalled ingest read as a fall.

An earlier rule compared how many days each window had data for and
allowed a 10% difference. That tolerance was itself the error: it let a
three-day gap through as a ten percent change.

So the rule is now strict, and stated in terms of what makes a
comparison true:

  * FINAL. Providers restate recent days, and ingest runs once a day.
    The detector skips the last two days for the same reason
    (`MadDetector.exclude_recent_days`); so does this.
  * COMPLETE, PER ACCOUNT. Every account in view must have cost rows on
    every day of BOTH windows. Per account, because ingestion is per
    account: one healthy account otherwise hides another's gap. Without
    the service filter, because a service that is idle on a Sunday is
    not missing data, but an account with no rows at all is.

When it fails, no card states a change and `note` says exactly which
condition failed. This is conservative on purpose: an account with a
genuinely free day loses its change cards. That is the cheap error.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from costhub.insights.cards import sentence_name
from costhub.query import scoped
from costhub.query.scoped import Filters, Principal

# Days before today still treated as unfinal. Matches the detector.
FINAL_LAG_DAYS = 2
# Each account costs one query. Past this, do not claim a change rather
# than verify only some of them.
MAX_ACCOUNTS = 25


def last_final_day() -> date:
    """The most recent day whose cost is settled enough to compare."""
    return datetime.now(timezone.utc).date() - timedelta(days=FINAL_LAG_DAYS + 1)


def check(who: Principal, current: Filters, previous: Filters) -> tuple[bool, str | None, int]:
    """(comparable, note, accounts checked). Reads as the caller, like everything else."""
    if current.end > last_final_day():
        return False, (
            f"The period includes days after {last_final_day():%d %b %Y}, whose cost "
            "is still being finalised by the provider, so it is not compared with "
            "an earlier one."), 0

    # Both windows at once, and no service filter: completeness is a
    # property of an account's ingestion, not of one service's activity.
    both = Filters(start=previous.start, end=current.end, provider=current.provider,
                   account_id=current.account_id, metric=current.metric)
    accounts = scoped.by_dimension(who, both, "account", limit=MAX_ACCOUNTS + 1)
    if len(accounts) > MAX_ACCOUNTS:
        return False, (
            f"More than {MAX_ACCOUNTS} accounts are in view, too many to confirm "
            "each has complete data, so no change is reported. Filter to fewer."), 0

    span = (current.end - current.start).days + 1
    for row in accounts:
        account = row["key"]
        days = {r["period"] for r in scoped.series(
            who, Filters(start=both.start, end=both.end, provider=both.provider,
                         account_id=account, metric=both.metric), grain="day")}
        now = sum(1 for d in days if current.start <= d <= current.end)
        was = sum(1 for d in days if previous.start <= d <= previous.end)
        if now < span or was < span:
            name = sentence_name(account) or "one account"
            return False, (
                f"Account {name} has cost data for {now} of {span} days in the "
                f"current period and {was} of {span} in the previous one. A change "
                "is only reported when every account in view has data for every "
                "day of both periods."), len(accounts)
    return bool(accounts), None, len(accounts)
