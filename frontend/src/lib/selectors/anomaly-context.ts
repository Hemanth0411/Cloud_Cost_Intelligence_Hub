import { addDays, dayOfWeek, diffDays } from '@/lib/dates';
import type { Dataset } from '@/lib/mock/dataset';
import type { Anomaly, AnomalyConfig, DailyCost } from '@/types/domain';
import { isIncrease } from './detect-anomalies';

export interface ContextPoint {
  date: string;
  cost: number;
}

export interface AnomalyContext {
  /** Daily cost of the series from ~5 weeks before the anomaly to a week after. */
  points: ContextPoint[];
  /** First day of the detection window. */
  windowStart: string;
  /** The whole account on the same days: what it cost versus what is typical. */
  account: {
    observed: number;
    expected: number;
    difference: number;
    /** Share of the account's change explained by this service, or null when the account barely moved. */
    contributionPct: number | null;
  };
  /** Billed usage quantity: observed versus typical. */
  usage: { observed: number; expected: number; changePct: number | null };
  /** Other anomalies in the same account within two days. */
  concurrent: Anomaly[];
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? upper) + upper) / 2 : upper;
};

const isWeekend = (iso: string): boolean => {
  const d = dayOfWeek(iso);
  return d === 0 || d === 6;
};

/**
 * Evidence around one anomaly, all derived from the same daily rows the detector used:
 * the surrounding cost curve, what the whole account did, usage, and neighbouring anomalies.
 */
export function getAnomalyContext(
  ds: Dataset,
  anomaly: Anomaly,
  allAnomalies: readonly Anomaly[],
  config: AnomalyConfig,
): AnomalyContext {
  const series: readonly DailyCost[] = ds.seriesByKey.get(`${anomaly.accountId}|${anomaly.serviceId}`) ?? [];
  const index = diffDays(anomaly.date, ds.startDate);
  const W = anomaly.windowDays;
  const B = config.baselineDays;

  const from = Math.max(0, index - 35);
  const to = Math.min(series.length - 1, index + 7);
  const points: ContextPoint[] = series.slice(from, to + 1).map((r) => ({ date: r.date, cost: r.cost }));

  // Account-level totals per day (sum over the account's services).
  const serviceIds = ds.serviceIdsByAccount.get(anomaly.accountId) ?? [];
  const accountSeries = serviceIds.flatMap((id) => {
    const s = ds.seriesByKey.get(`${anomaly.accountId}|${id}`);
    return s ? [s] : [];
  });
  const accountTotal = (i: number): number => accountSeries.reduce((acc, s) => acc + (s[i]?.cost ?? 0), 0);

  let accountObserved: number;
  let accountExpected: number;
  let usageObserved: number;
  let usageExpected: number;

  if (W === 1) {
    const weekend = isWeekend(anomaly.date);
    const comparable: number[] = [];
    const usageComparable: number[] = [];
    for (let j = index - 1; j >= Math.max(0, index - B); j -= 1) {
      if (isWeekend(addDays(ds.startDate, j)) !== weekend) continue;
      comparable.push(accountTotal(j));
      usageComparable.push(series[j]?.usageQuantity ?? 0);
    }
    accountObserved = accountTotal(index);
    accountExpected = median(comparable);
    usageObserved = series[index]?.usageQuantity ?? 0;
    usageExpected = median(usageComparable);
  } else {
    const recent: number[] = [];
    const base: number[] = [];
    const usageRecent: number[] = [];
    const usageBase: number[] = [];
    for (let j = index - W + 1; j <= index; j += 1) {
      recent.push(accountTotal(j));
      usageRecent.push(series[j]?.usageQuantity ?? 0);
    }
    for (let j = index - W - B + 1; j <= index - W; j += 1) {
      if (j < 0) continue;
      base.push(accountTotal(j));
      usageBase.push(series[j]?.usageQuantity ?? 0);
    }
    accountObserved = median(recent);
    accountExpected = median(base);
    usageObserved = median(usageRecent);
    usageExpected = median(usageBase);
  }

  const accountDifference = accountObserved - accountExpected;
  const sameDirection = isIncrease(anomaly.kind) ? accountDifference > 0 : accountDifference < 0;
  const contributionPct =
    sameDirection && Math.abs(accountDifference) >= 50
      ? Math.min(100, Math.round((anomaly.differenceCost / accountDifference) * 1000) / 10)
      : null;

  const concurrent = allAnomalies.filter(
    (a) => a.id !== anomaly.id && a.accountId === anomaly.accountId && Math.abs(diffDays(a.date, anomaly.date)) <= 2,
  );

  return {
    points,
    windowStart: addDays(anomaly.date, -(W - 1)),
    account: { observed: accountObserved, expected: accountExpected, difference: accountDifference, contributionPct },
    usage: {
      observed: usageObserved,
      expected: usageExpected,
      changePct: usageExpected > 0 ? ((usageObserved - usageExpected) / usageExpected) * 100 : null,
    },
    concurrent,
  };
}
