/**
 * What an "Import now" of N days actually fetches, and what it costs.
 *
 * MIRRORS THE BACKEND, it does not decide anything. The window is
 * `cost_explorer.default_window(days)` -- [today - days, today + 1),
 * today included, end exclusive -- and the call count is
 * `_monthly_windows`: one Cost Explorer call per calendar month the
 * range TOUCHES, not per 30 days of length. A 7-day import on the 3rd
 * spans two months and is two calls; 31 days always spans two and
 * sometimes three. `tests/test_stale_runs.py` pins the same arithmetic
 * on the Python side.
 *
 * "Today" is the UTC date, because the Lambda's `date.today()` is UTC.
 * A browser east of Greenwich in the early morning would otherwise
 * promise a window one day off from the one it gets.
 *
 * The count is a FLOOR: a month that paginates costs another call. It is
 * labelled "at least" on screen for that reason.
 */

/** The route's own cap, `Query(ge=1, le=31)`. It bounds a request to
 *  three Cost Explorer calls inside API Gateway's 29-second limit, which
 *  is why the UI offers nothing longer. */
export const MAX_IMPORT_DAYS = 31;

export const IMPORT_DAY_OPTIONS = [7, 14, 31] as const;
export type ImportDays = (typeof IMPORT_DAY_OPTIONS)[number];

/** AWS's list price for a Cost Explorer API request. */
export const CE_USD_PER_CALL = 0.01;

/** What the CLI backfills by default, and what it costs per account. */
export const BACKFILL_MONTHS = 14;

export interface ImportWindow {
  /** First date fetched, ISO yyyy-mm-dd. */
  start: string;
  /** Last date fetched (inclusive) -- today, UTC. */
  end: string;
  /** Dates in the window: `days + 1`, because today is re-fetched too. */
  dates: number;
  /** Calendar months touched = the minimum Cost Explorer calls. */
  calls: number;
}

function utcToday(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function importWindow(days: number, now: Date = new Date()): ImportWindow {
  const today = utcToday(now);
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - days);
  const months =
    (today.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (today.getUTCMonth() - start.getUTCMonth()) +
    1;
  return { start: iso(start), end: iso(today), dates: days + 1, calls: months };
}

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** The command for anything longer than the route allows. `do.sh` runs
 *  the ingest from the operator's machine, outside the 29-second limit. */
export function backfillCommand(accountId: string): string {
  return `./do.sh cli dev backfill --months ${BACKFILL_MONTHS} --account-id ${accountId}`;
}
