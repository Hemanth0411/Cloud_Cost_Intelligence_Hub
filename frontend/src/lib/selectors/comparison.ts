import { addDays, eachDay, shiftYears } from '@/lib/dates';
import type { Dataset } from '@/lib/mock/dataset';
import type { BaselineKind, ComparisonDimension, ComparisonEntity, ComparisonPoint, ComparisonResult, Filters } from '@/types/analytics';
import type { ProviderId, ServiceCategory } from '@/types/domain';
import { resolveRange } from './range';
import { getScope } from './scope';

interface Acc {
  id: string;
  label: string;
  providerId: ProviderId;
  category?: ServiceCategory;
  cur: number[];
  base: number[];
  children: Map<string, number>;
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
const round2 = (v: number): number => Math.round(v * 100) / 100;
const pct = (current: number, baseline: number): number | null => (baseline > 0 ? ((current - baseline) / baseline) * 100 : null);

/**
 * Compares the selected period with a baseline: the previous period (identical to the dashboard's
 * "vs previous") or the same dates one year earlier. Providers, accounts and services are built in a
 * single pass over the same scoped rows the dashboard uses, so the numbers always reconcile.
 */
export function getComparison(ds: Dataset, filters: Filters, baselineKind: BaselineKind): ComparisonResult {
  const range = resolveRange(filters, { start: ds.startDate, end: ds.endDate });
  const baselineFrom = baselineKind === 'previous' ? range.prevFrom : shiftYears(range.from, -1);
  const baselineTo = baselineKind === 'previous' ? range.prevTo : addDays(baselineFrom, range.days - 1);
  const hasBaseline = baselineFrom >= ds.startDate && baselineTo <= ds.endDate;

  const curIndex = new Map(eachDay(range.from, range.to).map((d, i) => [d, i] as const));
  const baseIndex = hasBaseline ? new Map(eachDay(baselineFrom, baselineTo).map((d, i) => [d, i] as const)) : new Map<string, number>();

  const newAcc = (id: string, label: string, providerId: ProviderId, category?: ServiceCategory): Acc => ({
    id, label, providerId, category, cur: new Array<number>(range.days).fill(0), base: new Array<number>(range.days).fill(0), children: new Map(),
  });

  const providerAcc = new Map<string, Acc>();
  const accountAcc = new Map<string, Acc>();
  const serviceAcc = new Map<string, Acc>();
  const totalCur = new Array<number>(range.days).fill(0);
  const totalBase = new Array<number>(range.days).fill(0);

  for (const row of getScope(ds, filters).rows) {
    const ci = curIndex.get(row.date);
    const bi = baseIndex.get(row.date);
    if (ci === undefined && bi === undefined) continue;

    const account = ds.accountById.get(row.accountId);
    const service = ds.serviceById.get(row.serviceId);
    const provider = ds.providerById.get(row.providerId);
    if (!account || !service || !provider) continue;

    let p = providerAcc.get(provider.id);
    if (!p) providerAcc.set(provider.id, (p = newAcc(provider.id, provider.name, provider.id)));
    let a = accountAcc.get(account.id);
    if (!a) accountAcc.set(account.id, (a = newAcc(account.id, account.name, account.providerId)));
    let s = serviceAcc.get(service.id);
    if (!s) serviceAcc.set(service.id, (s = newAcc(service.id, service.name, service.providerId, service.category)));

    if (ci !== undefined) {
      p.cur[ci] = (p.cur[ci] ?? 0) + row.cost;
      a.cur[ci] = (a.cur[ci] ?? 0) + row.cost;
      s.cur[ci] = (s.cur[ci] ?? 0) + row.cost;
      totalCur[ci] = (totalCur[ci] ?? 0) + row.cost;
      p.children.set(service.name, (p.children.get(service.name) ?? 0) + row.cost);
      a.children.set(service.name, (a.children.get(service.name) ?? 0) + row.cost);
      s.children.set(account.name, (s.children.get(account.name) ?? 0) + row.cost);
    }
    if (bi !== undefined) {
      p.base[bi] = (p.base[bi] ?? 0) + row.cost;
      a.base[bi] = (a.base[bi] ?? 0) + row.cost;
      s.base[bi] = (s.base[bi] ?? 0) + row.cost;
      totalBase[bi] = (totalBase[bi] ?? 0) + row.cost;
    }
  }

  const current = sum(totalCur);
  const baseline = hasBaseline ? sum(totalBase) : 0;
  const totalDiff = current - baseline;

  const finalize = (map: Map<string, Acc>): ComparisonEntity[] =>
    [...map.values()]
      .map((e): ComparisonEntity => {
        const cur = sum(e.cur);
        const base = hasBaseline ? sum(e.base) : 0;
        const top = [...e.children.entries()].sort((x, y) => y[1] - x[1])[0];
        return {
          id: e.id,
          label: e.label,
          providerId: e.providerId,
          category: e.category,
          current: cur,
          baseline: base,
          diff: cur - base,
          diffPct: hasBaseline ? pct(cur, base) : null,
          sharePct: current > 0 ? (cur / current) * 100 : 0,
          contributionPct: hasBaseline && totalDiff !== 0 ? ((cur - base) / totalDiff) * 100 : null,
          dailyCurrent: e.cur.map(round2),
          dailyBaseline: e.base.map(round2),
          topChild: top ? { label: top[0], cost: top[1] } : null,
        };
      })
      .sort((x, y) => y.current - x.current);

  const points: ComparisonPoint[] = totalCur.map((value, index) => ({
    index,
    currentDate: addDays(range.from, index),
    previousDate: addDays(baselineFrom, index),
    current: round2(value),
    previous: hasBaseline ? round2(totalBase[index] ?? 0) : null,
  }));

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
      avgCurrent: current / range.days,
      avgBaseline: hasBaseline ? baseline / range.days : 0,
    },
    points,
    providers: finalize(providerAcc),
    accounts: finalize(accountAcc),
    services: finalize(serviceAcc),
  };
}

export const DIMENSION_LABELS: Record<ComparisonDimension, string> = {
  provider: 'Providers',
  account: 'Accounts',
  service: 'Services',
};

export function entitiesFor(result: ComparisonResult, dimension: ComparisonDimension): ComparisonEntity[] {
  return dimension === 'provider' ? result.providers : dimension === 'account' ? result.accounts : result.services;
}
