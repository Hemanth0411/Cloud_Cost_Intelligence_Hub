import type { AccountSummary, AnomalyView, TrendPoint } from '@/types/analytics';
import type { CostInsight, Opportunity } from '@/types/domain';

export type CsvCell = string | number;

const escapeCell = (value: CsvCell): string => {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** RFC 4180-style CSV serialization. */
export function toCsv(headers: readonly string[], rows: ReadonlyArray<readonly CsvCell[]>): string {
  return [headers, ...rows].map((row) => row.map(escapeCell).join(',')).join('\r\n');
}

const money = (n: number): number => Math.round(n * 100) / 100;

export function trendToCsv(trend: readonly TrendPoint[]): string {
  return toCsv(
    ['period_start', 'period_end', 'partial', 'aws', 'azure', 'gcp', 'total'],
    trend.map((p) => [p.start, p.end, p.partial ? 'yes' : 'no', money(p.aws), money(p.azure), money(p.gcp), money(p.total)]),
  );
}

export function savingsToCsv(items: readonly Opportunity[]): string {
  return toCsv(
    ['opportunity', 'estimated_monthly_savings', 'range_low', 'range_high', 'confidence', 'effort', 'assumption'],
    items.map((o) => [o.title, o.estimatedMonthlySavings, o.rangeLow, o.rangeHigh, o.confidence, o.effort, o.assumption]),
  );
}

export function insightsToCsv(items: readonly CostInsight[]): string {
  return toCsv(
    ['priority', 'kind', 'title', 'summary', 'investigate_next', 'recommended_actions'],
    items.map((i) => [i.priority, i.kind, i.title, i.summary, i.investigateNext.join(' | '), i.recommendedActions.join(' | ')]),
  );
}

export function accountsToCsv(accounts: readonly AccountSummary[]): string {
  return toCsv(
    ['account', 'provider', 'environment', 'team', 'owner', 'spend', 'previous_spend', 'monthly_budget', 'mtd_spend', 'projected_spend', 'projected_budget_pct', 'status'],
    accounts.map((a) => [
      a.name, a.providerId, a.environment, a.team, a.owner,
      money(a.cost), money(a.previousCost), a.monthlyBudget, money(a.mtdSpend),
      money(a.projectedSpend), Math.round(a.projectedPct * 10) / 10, a.budgetStatus,
    ]),
  );
}

export function anomaliesToCsv(anomalies: readonly AnomalyView[]): string {
  return toCsv(
    ['detected_on', 'kind', 'severity', 'status', 'provider', 'account', 'service', 'observed_cost', 'expected_cost', 'difference', 'change_pct', 'window_days', 'impact'],
    anomalies.map((a) => [
      a.date, a.kind, a.severity, a.status, a.providerId, a.accountName, a.serviceName,
      a.observedCost, a.expectedCost, a.differenceCost, a.changePct, a.windowDays, a.impactCost,
    ]),
  );
}
