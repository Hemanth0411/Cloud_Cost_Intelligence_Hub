import { diffDays } from '@/lib/dates';
import type { Dataset } from '@/lib/mock/dataset';
import type { ResolvedRange } from '@/types/analytics';
import type { DailyCost, ProviderId } from '@/types/domain';

export interface PairDelta {
  accountId: string;
  serviceId: string;
  providerId: ProviderId;
  current: number;
  previous: number;
  delta: number;
}

/**
 * Cost change per (account, service) between the selected period and the one before it.
 * This is how insights can say *which* account and service drove a change.
 */
export function getContributors(scopedRows: readonly DailyCost[], range: ResolvedRange): PairDelta[] {
  const map = new Map<string, PairDelta>();
  for (const r of scopedRows) {
    const inCurrent = r.date >= range.from && r.date <= range.to;
    const inPrevious = range.hasPrevious && r.date >= range.prevFrom && r.date <= range.prevTo;
    if (!inCurrent && !inPrevious) continue;
    const key = `${r.accountId}|${r.serviceId}`;
    let item = map.get(key);
    if (!item) {
      item = { accountId: r.accountId, serviceId: r.serviceId, providerId: r.providerId, current: 0, previous: 0, delta: 0 };
      map.set(key, item);
    }
    if (inCurrent) item.current += r.cost;
    else item.previous += r.cost;
  }
  return [...map.values()].map((p) => ({ ...p, delta: p.current - p.previous })).sort((a, b) => b.delta - a.delta);
}

/**
 * How concentrated an increase is in time: the share of the total daily increase that falls on
 * the three biggest days. High means one-off events; low means a sustained, spread-out change.
 */
export function increaseConcentration(
  ds: Dataset,
  accountId: string,
  serviceId: string,
  range: ResolvedRange,
): number | null {
  if (!range.hasPrevious) return null;
  const series = ds.seriesByKey.get(`${accountId}|${serviceId}`);
  if (!series) return null;
  const curStart = diffDays(range.from, ds.startDate);
  const prevStart = diffDays(range.prevFrom, ds.startDate);
  const diffs: number[] = [];
  for (let i = 0; i < range.days; i += 1) {
    const d = (series[curStart + i]?.cost ?? 0) - (series[prevStart + i]?.cost ?? 0);
    if (d > 0) diffs.push(d);
  }
  const total = diffs.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const top3 = diffs.sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
  return (top3 / total) * 100;
}
