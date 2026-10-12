/**
 * The comparison screen, built from API aggregates.
 *
 * Same split as the dashboard: the day-by-day overlay comes from the
 * per-provider series (computed), and every per-entity figure comes
 * from two `/cost/breakdown` calls, one per window (requested). See
 * the headnote in `live/dashboard.ts` for why not `/cost/compare` --
 * it truncates silently to 50 keys and exposes no limit.
 *
 * THE RANGE IS RESOLVED ONCE, against the query horizon, and the
 * baseline window is derived from it. Resolving it a second time
 * against the first day that returned data made the two disagree for
 * a `custom` range starting before the data: the baseline tiles then
 * summed a window twenty times longer than the current one and read
 * as a catastrophic drop, while the overlay chart plotted only the
 * first N days of it. The measured start is used for nothing but the
 * `partial` flag.
 *
 * TWO THINGS THE MOCK SHOWS AND THIS DOES NOT:
 *
 *  * `topChild` -- "the biggest service inside this account". That is
 *    a second grouping (account x service), and no endpoint produces
 *    it. It is null and the table prints "n/a".
 *  * `dailyCurrent` / `dailyBaseline` -- the head-to-head curve. One
 *    `/cost/series` per entity, and the services dimension routinely
 *    carries fifty. Null, and the chart is withheld rather than drawn
 *    flat at zero.
 *
 * `hasBaseline` IS MEASURED, NOT ASSUMED. The mock knows its dataset
 * starts on 1 Jan 2024 and compares dates against it. Here the only
 * way to know whether a baseline window has data is that rows came
 * back for it, which is also the more honest test: a window inside
 * the data range but with no ingested rows is equally uncomparable.
 */
import { addDays, shiftYears } from '@/lib/dates';
import { loadProviderDays, loadWindowedBreakdown, providersInScope, scopeOf } from '@/lib/live/dashboard';
import { liveHistoryStart, type LiveOptions } from '@/lib/live/options';
import { inWindow, sum } from '@/lib/selectors/dashboard';
import { resolveRange } from '@/lib/selectors/range';
import type {
  BaselineKind,
  ComparisonEntity,
  ComparisonPoint,
  ComparisonResult,
  Filters,
} from '@/types/analytics';
import type { ProviderCostRow, ProviderId } from '@/types/domain';

const round2 = (v: number): number => Math.round(v * 100) / 100;
const pct = (current: number, baseline: number): number | null =>
  baseline > 0 ? ((current - baseline) / baseline) * 100 : null;

function dailyMap(rows: readonly ProviderCostRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.date, (out.get(r.date) ?? 0) + r.cost);
  return out;
}

export async function loadLiveComparison(
  filters: Filters,
  baselineKind: BaselineKind,
  options: LiveOptions,
): Promise<ComparisonResult> {
  const scope = scopeOf(filters);
  const providers = providersInScope(filters, options);
  const horizonStart = liveHistoryStart(options.dataEnd);
  const range = resolveRange(filters, { start: horizonStart, end: options.dataEnd });

  const baselineFrom = baselineKind === 'previous' ? range.prevFrom : shiftYears(range.from, -1);
  // Always the SAME LENGTH as the current window, whichever baseline
  // was chosen. Comparing windows of different lengths is the single
  // easiest way to manufacture a dramatic and meaningless percentage.
  const baselineTo = baselineKind === 'previous' ? range.prevTo : addDays(baselineFrom, range.days - 1);

  // The series has to reach the baseline, or `hasBaseline` would be
  // decided by the fetch horizon rather than by the data.
  const seriesStart = [horizonStart, range.from, baselineFrom].reduce((min, d) => (d < min ? d : min));

  const [days, accountBreakdown, serviceBreakdowns] = await Promise.all([
    loadProviderDays(filters, options, providers, seriesStart),
    loadWindowedBreakdown(
      'account',
      scope,
      { start: range.from, end: range.to },
      { start: baselineFrom, end: baselineTo },
    ),
    Promise.all(
      providers.map(async (provider) => ({
        provider,
        breakdown: await loadWindowedBreakdown(
          'service',
          { ...scope, provider },
          { start: range.from, end: range.to },
          { start: baselineFrom, end: baselineTo },
        ),
      })),
    ),
  ]);

  const currentRows = inWindow(days, range.from, range.to);
  const baselineRows = inWindow(days, baselineFrom, baselineTo);
  const hasBaseline = baselineRows.length > 0;

  const current = sum(currentRows);
  const baseline = hasBaseline ? sum(baselineRows) : 0;
  const totalDiff = current - baseline;

  const entity = (
    id: string,
    label: string,
    providerId: ProviderId,
    cur: number,
    base: number,
  ): ComparisonEntity => ({
    id,
    label,
    providerId,
    category: null,
    current: cur,
    baseline: hasBaseline ? base : 0,
    diff: cur - (hasBaseline ? base : 0),
    diffPct: hasBaseline ? pct(cur, base) : null,
    sharePct: current > 0 ? (cur / current) * 100 : 0,
    contributionPct: hasBaseline && totalDiff !== 0 ? ((cur - base) / totalDiff) * 100 : null,
    dailyCurrent: null,
    dailyBaseline: null,
    topChild: null,
  });

  const providerEntities = options.providers
    .filter((p) => providers.includes(p.id))
    .map((p) =>
      entity(
        p.id,
        p.name,
        p.id,
        sum(currentRows.filter((r) => r.providerId === p.id)),
        sum(baselineRows.filter((r) => r.providerId === p.id)),
      ),
    )
    .filter((e) => e.current > 0 || e.baseline > 0)
    .sort((a, b) => b.current - a.current);

  const accountById = new Map(options.accounts.map((a) => [a.id, a]));
  const accountEntities = accountBreakdown.keys
    .map((key) => {
      const account = accountById.get(key);
      return entity(
        key,
        account?.name ?? key,
        account?.providerId ?? (providers[0] ?? 'aws'),
        accountBreakdown.current.get(key) ?? 0,
        accountBreakdown.previous.get(key) ?? 0,
      );
    })
    .filter((e) => e.current > 0 || e.baseline > 0)
    .sort((a, b) => b.current - a.current);

  const serviceEntities = serviceBreakdowns
    .flatMap(({ provider, breakdown }) =>
      breakdown.keys.map((key) =>
        entity(
          key,
          key,
          provider,
          breakdown.current.get(key) ?? 0,
          breakdown.previous.get(key) ?? 0,
        ),
      ),
    )
    .filter((e) => e.current > 0 || e.baseline > 0)
    .sort((a, b) => b.current - a.current);

  const currentByDay = dailyMap(currentRows);
  const baselineByDay = dailyMap(baselineRows);
  const points: ComparisonPoint[] = Array.from({ length: range.days }, (_, index) => {
    const currentDate = addDays(range.from, index);
    const previousDate = addDays(baselineFrom, index);
    return {
      index,
      currentDate,
      previousDate,
      current: round2(currentByDay.get(currentDate) ?? 0),
      previous: hasBaseline ? round2(baselineByDay.get(previousDate) ?? 0) : null,
    };
  });

  return {
    baselineKind,
    range,
    baselineFrom,
    baselineTo,
    hasBaseline,
    totals: {
      current,
      baseline,
      diff: totalDiff,
      diffPct: hasBaseline ? pct(current, baseline) : null,
      avgCurrent: range.days > 0 ? current / range.days : 0,
      avgBaseline: hasBaseline && range.days > 0 ? baseline / range.days : 0,
    },
    points,
    providers: providerEntities,
    accounts: accountEntities,
    services: serviceEntities,
  };
}
