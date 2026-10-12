import { addDays, addMonths, mondayOf, startOfMonth } from '@/lib/dates';
import type { Dataset } from '@/lib/mock/dataset';
import type { AnomalyView, ResolvedRange, StatusOverrides } from '@/types/analytics';
import type { Anomaly, AnomalyKind, AnomalyStatus, Severity } from '@/types/domain';
import { isIncrease } from './detect-anomalies';
import { matchesScope, type ScopeFilters } from './scope';

export const ACTIVE_STATUSES: readonly AnomalyStatus[] = ['open', 'investigating', 'acknowledged'];
export const isActive = (status: AnomalyStatus): boolean => ACTIVE_STATUSES.includes(status);
export const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'medium', 'low'];

/**
 * Anomalies inside the provider / account / service scope and date range, with the user's
 * workflow changes (acknowledge, resolve, ...) layered on top. The dashboard, the Anomalies
 * page and the insight engine all read anomalies through this one function.
 */
export function getAnomalyViews(
  ds: Dataset,
  anomalies: readonly Anomaly[],
  filters: ScopeFilters,
  range: Pick<ResolvedRange, 'from' | 'to'>,
  overrides: StatusOverrides = {},
): AnomalyView[] {
  return anomalies
    .filter((a) => matchesScope(a, filters) && a.date >= range.from && a.date <= range.to)
    .map((a) => ({
      ...a,
      status: overrides[a.id] ?? a.status,
      accountName: ds.accountById.get(a.accountId)?.name ?? a.accountId,
      serviceName: ds.serviceById.get(a.serviceId)?.name ?? a.serviceId,
    }));
}

export interface AnomalyFilter {
  severity: Severity | 'all';
  /** 'active' = open + investigating + acknowledged. */
  status: AnomalyStatus | 'active' | 'all';
  kind: AnomalyKind | 'all';
}

export const DEFAULT_ANOMALY_FILTER: AnomalyFilter = { severity: 'all', status: 'all', kind: 'all' };

export function filterAnomalies(list: readonly AnomalyView[], f: AnomalyFilter): AnomalyView[] {
  return list.filter(
    (a) =>
      (f.severity === 'all' || a.severity === f.severity) &&
      (f.kind === 'all' || a.kind === f.kind) &&
      (f.status === 'all' || (f.status === 'active' ? isActive(a.status) : a.status === f.status)),
  );
}

export interface AnomalySummary {
  total: number;
  active: number;
  bySeverity: Record<Severity, number>;
  byStatus: Record<AnomalyStatus, number>;
  byKind: Record<AnomalyKind, number>;
  /** Dollars of excess cost inside the detection windows of active increases. */
  activeIncreaseImpact: number;
  /** Dollars below expected inside the detection windows of active decreases (positive number). */
  activeDecreaseImpact: number;
}

export function summarizeAnomalies(list: readonly AnomalyView[]): AnomalySummary {
  const summary: AnomalySummary = {
    total: list.length,
    active: 0,
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    byStatus: { open: 0, investigating: 0, acknowledged: 0, resolved: 0, dismissed: 0 },
    byKind: { spike: 0, 'sustained-increase': 0, drop: 0, 'sustained-decrease': 0 },
    activeIncreaseImpact: 0,
    activeDecreaseImpact: 0,
  };
  for (const a of list) {
    summary.bySeverity[a.severity] += 1;
    summary.byStatus[a.status] += 1;
    summary.byKind[a.kind] += 1;
    if (!isActive(a.status)) continue;
    summary.active += 1;
    if (isIncrease(a.kind)) summary.activeIncreaseImpact += a.impactCost;
    else summary.activeDecreaseImpact += Math.abs(a.impactCost);
  }
  return summary;
}

export interface TimelineBucket {
  start: string;
  end: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
  total: number;
}

/** Counts anomalies per period by severity: daily (short ranges), weekly, or monthly (long ranges). */
export function anomalyTimeline(list: readonly AnomalyView[], range: Pick<ResolvedRange, 'from' | 'to' | 'days'>): TimelineBucket[] {
  const defs: Array<{ start: string; end: string }> = [];
  if (range.days <= 21) {
    for (let d = range.from; d <= range.to; d = addDays(d, 1)) defs.push({ start: d, end: d });
  } else if (range.days <= 150) {
    for (let s = mondayOf(range.from); s <= range.to; s = addDays(s, 7)) defs.push({ start: s, end: addDays(s, 6) });
  } else {
    for (let s = startOfMonth(range.from); s <= range.to; s = addMonths(s, 1)) defs.push({ start: s, end: addDays(addMonths(s, 1), -1) });
  }
  const buckets: TimelineBucket[] = defs.map((d) => ({ ...d, critical: 0, high: 0, medium: 0, low: 0, total: 0 }));
  for (const a of list) {
    const bucket = buckets.find((b) => a.date >= b.start && a.date <= b.end);
    if (!bucket) continue;
    bucket[a.severity] += 1;
    bucket.total += 1;
  }
  return buckets;
}
