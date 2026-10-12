/**
 * The dashboard, built from API aggregates.
 *
 * THE SHAPE PROBLEM, AND WHAT WAS DECIDED
 *
 * `getDashboardData` reads a 40,000-row fact table held in memory and
 * groups it six ways. The API has no such endpoint and should not: it
 * returns aggregates, which is the whole point of putting the query in
 * SQL behind a grant predicate. So each part of the screen is either
 * REQUESTED AS DISPLAYED or COMPUTED FROM A CHEAPER REQUEST, and the
 * split is deliberate:
 *
 *  * THE TIME AXIS is computed. One `/cost/series?grain=day` per
 *    provider over the whole history window answers the daily chart,
 *    the weekly / monthly / yearly chart, the previous-period overlay,
 *    month-to-date, the forecast and last month's total -- six things
 *    off one request each. Asking for them separately would be ten
 *    round-trips for data that is one array of (day, cost) pairs, and
 *    the coarser granularities would then disagree with the daily one
 *    at the boundaries.
 *  * THE DIMENSION AXIS is requested. Reconstructing it is impossible
 *    -- there is no (day, service) grouping endpoint, and adding one
 *    would mean shipping the fact table to the browser.
 *  * SERVICES are requested PER PROVIDER. The service dimension is
 *    keyed by bare name, and a bare name cannot colour a row or label
 *    it "AWS". One call per provider (there is one today, three ever)
 *    attaches the provider that the key alone cannot carry.
 *
 * WHY `/cost/breakdown` TWICE AND NOT `/cost/compare` ONCE
 *
 * `/cost/compare` is the natural fit -- it returns current, previous
 * and both deltas per key in one call. It is not used because it
 * SILENTLY TRUNCATES: `scoped.compare` calls `by_dimension` without a
 * limit, so it takes the signature default of 50, and the route
 * exposes no `limit` for a caller to raise. An estate with 120 billed
 * services would show 50 rows whose shares summed to ~70%, with
 * nothing on screen saying 70 were missing -- while the filter
 * dropdown, which uses `/cost/breakdown`, listed all 120. Two
 * breakdown calls cost one extra round-trip and let the limit be
 * stated. The percent delta is then computed here with the same rule
 * the server uses (`pctChange` -> null when the baseline was zero).
 *
 * WHAT IS LEFT NULL, AND WHY IT IS NOT ZERO
 *
 *  * BUDGETS. No table stores one. `kpis.budget` is null and the KPI
 *    card says so, rather than showing 0% of $0.
 *  * SAVINGS. `computeOpportunities` is a heuristic pass over
 *    individual fact rows; the browser does not have them, and there
 *    is no optimization endpoint. `savings` is null -- an empty list
 *    would claim the estate was examined.
 *  * ACCOUNT METADATA (environment, team, owner, region) and SERVICE
 *    CATEGORIES. No columns.
 *
 * Everything else on the dashboard is real or absent. Nothing is
 * approximated.
 */
import { fetchBreakdown, fetchSeries, type DimensionRow } from '@/lib/api/cost-api';
import { addDays } from '@/lib/dates';
import { liveHistoryStart, type LiveOptions } from '@/lib/live/options';
import {
  dailyTotals,
  inWindow,
  monthStats,
  MONTH_NAMES,
  pctChange,
  sum,
} from '@/lib/selectors/dashboard';
import { resolveRange } from '@/lib/selectors/range';
import { isActive } from '@/lib/selectors/anomaly-views';
import { bucketDefs, buildSeries, dailyBuckets } from '@/lib/selectors/time-series';
import type {
  AccountSummary,
  AnomalyView,
  BreakdownItem,
  ComparisonPoint,
  DashboardData,
  DashboardKpis,
  Filters,
  ResolvedRange,
} from '@/types/analytics';
import type { ProviderCostRow, ProviderId } from '@/types/domain';

/**
 * The API's own ceiling (`Query(ge=1, le=500)`), asked for explicitly.
 *
 * Sitting exactly on the limit is deliberate: the alternative is
 * accepting a default chosen for a different caller. If an estate ever
 * exceeds 500 keys in one dimension the request still succeeds and the
 * tail is dropped, so this number is a known limit rather than an
 * accident -- but raising it means raising the server's cap too.
 */
export const BREAKDOWN_LIMIT = 500;

/** `filters` narrowed to the query parameters the cost endpoints take. */
export function scopeOf(filters: Filters): { provider?: string; accountId?: string; service?: string } {
  return {
    provider: filters.providerId === 'all' ? undefined : filters.providerId,
    accountId: filters.accountId === 'all' ? undefined : filters.accountId,
    service: filters.serviceId === 'all' ? undefined : filters.serviceId,
  };
}

/** Which providers a set of filters can possibly return rows for. */
export function providersInScope(filters: Filters, options: LiveOptions): ProviderId[] {
  if (filters.providerId !== 'all') {
    return options.providers.some((p) => p.id === filters.providerId) ? [filters.providerId] : [];
  }
  if (filters.accountId !== 'all') {
    const account = options.accounts.find((a) => a.id === filters.accountId);
    return account ? [account.providerId] : [];
  }
  return options.providers.map((p) => p.id);
}

/**
 * How far back the day-grain series must reach.
 *
 * The three-year horizon is what the coarse-granularity charts want.
 * But `hasPrevious` is decided by whether rows came back for the
 * comparison window, so a comparison window OUTSIDE the fetch would
 * read as "no earlier data" when there is plenty -- and every row's
 * "vs previous" would blank out. The window always reaches whichever
 * is earlier.
 */
export function seriesStartFor(range: Pick<ResolvedRange, 'from' | 'prevFrom'>, dataEnd: string): string {
  const horizon = liveHistoryStart(dataEnd);
  return [horizon, range.from, range.prevFrom].reduce((min, d) => (d < min ? d : min));
}

/**
 * Daily (provider, day, cost) rows.
 *
 * One request per provider, in parallel. A three-year day-grain
 * series is about a thousand rows per provider, which is smaller than
 * most of the images on the page.
 */
export async function loadProviderDays(
  filters: Filters,
  options: LiveOptions,
  providers: readonly ProviderId[],
  start: string,
): Promise<ProviderCostRow[]> {
  const scope = scopeOf(filters);
  const envelopes = await Promise.all(
    providers.map((provider) =>
      fetchSeries({ ...scope, provider, start, end: options.dataEnd, grain: 'day' }),
    ),
  );
  return envelopes.flatMap((envelope, i) =>
    envelope.data.map((row): ProviderCostRow => ({
      date: row.period,
      providerId: providers[i] as ProviderId,
      cost: row.cost,
    })),
  );
}

/** Current and baseline totals for one dimension, keyed. */
export interface WindowedBreakdown {
  current: Map<string, number>;
  previous: Map<string, number>;
  keys: string[];
}

const toMap = (rows: readonly DimensionRow[]): Map<string, number> =>
  new Map(rows.map((r) => [r.key, r.cost]));

export async function loadWindowedBreakdown(
  dimension: 'account' | 'service',
  scope: { provider?: string; accountId?: string; service?: string },
  current: { start: string; end: string },
  previous: { start: string; end: string },
): Promise<WindowedBreakdown> {
  const [now, was] = await Promise.all([
    fetchBreakdown({ ...scope, dimension, start: current.start, end: current.end, limit: BREAKDOWN_LIMIT }),
    fetchBreakdown({ ...scope, dimension, start: previous.start, end: previous.end, limit: BREAKDOWN_LIMIT }),
  ]);
  const currentMap = toMap(now.data);
  const previousMap = toMap(was.data);
  return {
    current: currentMap,
    previous: previousMap,
    keys: [...new Set([...currentMap.keys(), ...previousMap.keys()])],
  };
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

export interface LiveDashboardInput {
  filters: Filters;
  options: LiveOptions;
  /** Already scoped to the filters and the range by the caller. */
  anomalies: AnomalyView[];
}

export async function loadLiveDashboard({
  filters,
  options,
  anomalies,
}: LiveDashboardInput): Promise<DashboardData> {
  const scope = scopeOf(filters);
  const providers = providersInScope(filters, options);

  // THE RANGE IS RESOLVED EXACTLY ONCE.
  //
  // An earlier version resolved it twice -- before the fetch against
  // the query horizon, and again afterwards against the first day that
  // actually returned a row -- so that the `partial` flag on the
  // coarse charts would be right. For every preset the two agreed,
  // because only the `custom` branch of `resolveRange` reads
  // `bounds.start`. For a custom range starting before the data they
  // did not, and the requests then covered a different window from the
  // one the page was labelled with: account rows summed to many times
  // the headline total and `sharePct` went past 100%. The measured
  // start now feeds ONLY the `partial` flag, which is all it was ever
  // for.
  const range = { ...resolveRange(filters, { start: liveHistoryStart(options.dataEnd), end: options.dataEnd }) };
  const start = seriesStartFor(range, options.dataEnd);

  const [days, accountBreakdown, serviceBreakdowns] = await Promise.all([
    loadProviderDays(filters, options, providers, start),
    loadWindowedBreakdown(
      'account',
      scope,
      { start: range.from, end: range.to },
      { start: range.prevFrom, end: range.prevTo },
    ),
    Promise.all(
      providers.map(async (provider) => ({
        provider,
        breakdown: await loadWindowedBreakdown(
          'service',
          { ...scope, provider },
          { start: range.from, end: range.to },
          { start: range.prevFrom, end: range.prevTo },
        ),
      })),
    ),
  ]);

  const firstDay = days.reduce<string | null>((min, r) => (min === null || r.date < min ? r.date : min), null);
  const bounds = { start: firstDay ?? start, end: options.dataEnd };

  const previousRows = inWindow(days, range.prevFrom, range.prevTo);
  // Only claim a previous period when rows came back for it. An empty
  // previous window is not a $0 period -- the backend drops zero rows
  // -- so "vs previous" must read as "no comparison" rather than as a
  // 100% increase.
  range.hasPrevious = previousRows.length > 0;

  const currentRows = inWindow(days, range.from, range.to);
  const totalSpend = sum(currentRows);
  const previousSpend = range.hasPrevious ? sum(previousRows) : null;

  const share = (cost: number): number => (totalSpend > 0 ? (cost / totalSpend) * 100 : 0);

  // ---- Breakdowns -------------------------------------------------------

  const providerItems: BreakdownItem[] = options.providers
    .filter((p) => providers.includes(p.id))
    .map((p) => {
      const cost = sum(currentRows.filter((r) => r.providerId === p.id));
      const previousCost = sum(previousRows.filter((r) => r.providerId === p.id));
      return {
        id: p.id,
        label: p.name,
        providerId: p.id,
        cost,
        previousCost,
        deltaPct: range.hasPrevious ? pctChange(cost, previousCost) : null,
        sharePct: share(cost),
      };
    })
    .filter((item) => item.cost > 0 || item.previousCost > 0)
    .sort((a, b) => b.cost - a.cost);

  const accountById = new Map(options.accounts.map((a) => [a.id, a]));
  const accountItems: BreakdownItem[] = accountBreakdown.keys
    .map((key): BreakdownItem => {
      const account = accountById.get(key);
      const cost = accountBreakdown.current.get(key) ?? 0;
      const previousCost = accountBreakdown.previous.get(key) ?? 0;
      return {
        id: key,
        // An account with cost but no dim_account row cannot be named
        // or coloured; dropping it would lose money from the total, so
        // it keeps its id as its label.
        label: account?.name ?? key,
        providerId: account?.providerId ?? (providers[0] ?? 'aws'),
        cost,
        previousCost,
        deltaPct: pctChange(cost, previousCost),
        sharePct: share(cost),
      };
    })
    .filter((item) => item.cost > 0 || item.previousCost > 0)
    .sort((a, b) => b.cost - a.cost);

  const serviceItems: BreakdownItem[] = serviceBreakdowns
    .flatMap(({ provider, breakdown }) =>
      breakdown.keys.map((key): BreakdownItem => {
        const cost = breakdown.current.get(key) ?? 0;
        const previousCost = breakdown.previous.get(key) ?? 0;
        return {
          id: key,
          label: key,
          providerId: provider,
          category: null,
          cost,
          previousCost,
          deltaPct: pctChange(cost, previousCost),
          sharePct: share(cost),
        };
      }),
    )
    .filter((item) => item.cost > 0 || item.previousCost > 0)
    .sort((a, b) => b.cost - a.cost);

  // ---- Time series ------------------------------------------------------

  const series = {
    day: buildSeries(currentRows, dailyBuckets(range.from, range.to), bounds),
    week: buildSeries(days, bucketDefs('week', bounds), bounds),
    month: buildSeries(days, bucketDefs('month', bounds), bounds),
    year: buildSeries(days, bucketDefs('year', bounds), bounds),
  };

  const currentDaily = series.day.map((p) => p.total);
  const previousDaily = range.hasPrevious ? dailyTotals(previousRows, range.prevFrom, range.prevTo) : [];
  const comparison: ComparisonPoint[] = currentDaily.map((value, index) => ({
    index,
    currentDate: addDays(range.from, index),
    previousDate: addDays(range.prevFrom, index),
    current: round2(value),
    previous: range.hasPrevious ? round2(previousDaily[index] ?? 0) : null,
  }));

  // ---- KPIs -------------------------------------------------------------

  const month = monthStats(days, options.dataEnd);

  const kpis: DashboardKpis = {
    totalSpend: {
      value: totalSpend,
      previous: previousSpend,
      deltaPct: previousSpend === null ? null : pctChange(totalSpend, previousSpend),
      series: currentDaily,
      avgDaily: range.days > 0 ? totalSpend / range.days : 0,
    },
    previousSpend: {
      value: previousSpend,
      from: range.prevFrom,
      to: range.prevTo,
      changeAbs: previousSpend === null ? null : totalSpend - previousSpend,
      changePct: previousSpend === null ? null : pctChange(totalSpend, previousSpend),
    },
    monthToDate: {
      value: month.mtd,
      previous: month.prevMonthSameDays,
      deltaPct: pctChange(month.mtd, month.prevMonthSameDays),
      series: month.cumulativeSeries,
    },
    forecast: {
      value: month.projected,
      previous: month.prevMonthTotal,
      deltaPct: pctChange(month.projected, month.prevMonthTotal),
      series: month.cumulativeSeries,
      daysRemaining: month.daysRemaining,
      monthLabel: MONTH_NAMES[Number(options.dataEnd.slice(5, 7)) - 1] ?? '',
    },
    // No budget column exists anywhere in the schema.
    budget: null,
    services: {
      inUse: new Set(serviceItems.filter((s) => s.cost > 0).map((s) => s.id)).size,
      // `dim_service.service_category` is not exposed by any endpoint.
      categories: null,
    },
    anomalies: {
      active: anomalies.filter((a) => isActive(a.status)).length,
      total: anomalies.length,
      criticalOrHigh: anomalies.filter((a) => isActive(a.status) && (a.severity === 'critical' || a.severity === 'high')).length,
    },
    // No optimization endpoint. See TODO-18.
    savings: null,
  };

  // ---- Account summaries ------------------------------------------------
  //
  // Every account the caller may see is listed, including ones with no
  // charges in the window: zero spend for an account that exists is a
  // fact, and omitting it would make an idle account look revoked.

  const visible = options.accounts.filter(
    (a) =>
      (filters.providerId === 'all' || a.providerId === filters.providerId) &&
      (filters.accountId === 'all' || a.id === filters.accountId),
  );
  const accounts: AccountSummary[] = visible
    .map((account): AccountSummary => {
      const cost = accountBreakdown.current.get(account.id) ?? 0;
      const previousCost = accountBreakdown.previous.get(account.id) ?? 0;
      return {
        accountId: account.id,
        name: account.name,
        providerId: account.providerId,
        environment: null,
        team: null,
        owner: null,
        region: null,
        externalId: account.externalId,
        cost,
        previousCost,
        deltaPct: pctChange(cost, previousCost),
        sharePct: share(cost),
        monthlyBudget: null,
        mtdSpend: null,
        projectedSpend: null,
        mtdPct: null,
        projectedPct: null,
        budgetStatus: null,
      };
    })
    .sort((a, b) => b.cost - a.cost);

  return {
    range,
    kpis,
    series,
    comparison,
    breakdowns: { provider: providerItems, account: accountItems, service: serviceItems },
    accounts,
    anomalies,
    savings: null,
  };
}
