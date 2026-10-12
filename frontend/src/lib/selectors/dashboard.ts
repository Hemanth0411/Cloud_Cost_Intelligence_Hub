import {
  addDays,
  dayOfMonth,
  daysInMonth,
  eachDay,
  startOfMonth,
  startOfPreviousMonth,
} from '@/lib/dates';
import type { Dataset } from '@/lib/mock/dataset';
import type { CostRow, DailyCost, DetectedAnomaly } from '@/types/domain';
import type {
  BreakdownItem,
  BudgetStatus,
  BudgetedAccountSummary,
  ComparisonPoint,
  DetectedAnomalyView,
  FullDashboardData,
  Filters,
  StatusOverrides,
} from '@/types/analytics';
import { resolveRange } from './range';
import { getAnomalyViews, isActive } from './anomaly-views';
import { computeOpportunities } from './optimization';
import { getScope } from './scope';
import { bucketDefs, buildSeries, dailyBuckets } from './time-series';

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Exported for the live path, which has the same windows to cut but no fact rows. */
export const inWindow = <T extends CostRow>(rows: readonly T[], from: string, to: string): T[] =>
  rows.filter((r) => r.date >= from && r.date <= to);

export const sum = (rows: readonly CostRow[]): number => rows.reduce((acc, r) => acc + r.cost, 0);

export const pctChange = (current: number, previous: number): number | null =>
  previous > 0 ? ((current - previous) / previous) * 100 : null;

export function dailyTotals(rows: readonly CostRow[], from: string, to: string): number[] {
  const byDate = new Map<string, number>();
  for (const r of rows) byDate.set(r.date, (byDate.get(r.date) ?? 0) + r.cost);
  return eachDay(from, to).map((d) => byDate.get(d) ?? 0);
}

function groupCost(rows: readonly DailyCost[], key: (r: DailyCost) => string): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    map.set(k, (map.get(k) ?? 0) + r.cost);
  }
  return map;
}

interface MonthStats {
  mtd: number;
  prevMonthSameDays: number;
  prevMonthTotal: number;
  projected: number;
  daysRemaining: number;
  cumulativeSeries: number[];
}

/**
 * Month-level figures anchored to the dataset's last day.
 * Forecast = month-to-date + (trailing 7-day average x days left in the month).
 */
export function monthStats(rows: readonly CostRow[], endDate: string): MonthStats {
  const monthStart = startOfMonth(endDate);
  const elapsed = dayOfMonth(endDate);
  const daysRemaining = daysInMonth(endDate) - elapsed;

  const mtdRows = inWindow(rows, monthStart, endDate);
  const mtd = sum(mtdRows);

  const prevStart = startOfPreviousMonth(endDate);
  const prevMonthTotal = sum(inWindow(rows, prevStart, addDays(monthStart, -1)));
  const prevMonthSameDays = sum(inWindow(rows, prevStart, addDays(prevStart, elapsed - 1)));

  const last7 = sum(inWindow(rows, addDays(endDate, -6), endDate)) / 7;
  const projected = mtd + last7 * daysRemaining;

  let running = 0;
  const cumulativeSeries = dailyTotals(mtdRows, monthStart, endDate).map((v) => {
    running += v;
    return running;
  });
  return { mtd, prevMonthSameDays, prevMonthTotal, projected, daysRemaining, cumulativeSeries };
}

const budgetStatusFor = (projectedPct: number): BudgetStatus =>
  projectedPct > 100 ? 'over-budget' : projectedPct >= 90 ? 'at-risk' : 'on-track';

export function getDashboardData(
  ds: Dataset,
  filters: Filters,
  statusOverrides: StatusOverrides = {},
  detected: readonly DetectedAnomaly[] = ds.anomalies,
): FullDashboardData {
  const bounds = { start: ds.startDate, end: ds.endDate };
  const range = resolveRange(filters, bounds);
  const scope = getScope(ds, filters);
  const scoped = scope.rows;

  const current = inWindow(scoped, range.from, range.to);
  const previous = range.hasPrevious ? inWindow(scoped, range.prevFrom, range.prevTo) : [];
  const totalSpend = sum(current);
  const previousSpend = range.hasPrevious ? sum(previous) : null;

  // ---- Anomalies (scoped, within range, with user workflow applied) -----------
  const anomalies: DetectedAnomalyView[] = getAnomalyViews(ds, detected, filters, range, statusOverrides);

  // ---- Breakdown maps ----------------------------------------------------------
  const costByProvider = groupCost(current, (r) => r.providerId);
  const prevByProvider = groupCost(previous, (r) => r.providerId);
  const costByAccount = groupCost(current, (r) => r.accountId);
  const prevByAccount = groupCost(previous, (r) => r.accountId);
  const costByService = groupCost(current, (r) => r.serviceId);
  const prevByService = groupCost(previous, (r) => r.serviceId);

  const share = (cost: number): number => (totalSpend > 0 ? (cost / totalSpend) * 100 : 0);
  const delta = (cost: number, prev: number | undefined): number | null =>
    range.hasPrevious ? pctChange(cost, prev ?? 0) : null;

  const providerItems: BreakdownItem[] = [...costByProvider]
    .map(([id, cost]) => {
      const provider = ds.providers.find((p) => p.id === id);
      return {
        id,
        label: provider?.name ?? id,
        providerId: provider?.id ?? 'aws',
        cost,
        previousCost: prevByProvider.get(id) ?? 0,
        deltaPct: delta(cost, prevByProvider.get(id)),
        sharePct: share(cost),
      };
    })
    .sort((a, b) => b.cost - a.cost);

  const accountItems: BreakdownItem[] = [...costByAccount]
    .flatMap(([id, cost]) => {
      const account = ds.accountById.get(id);
      return account
        ? [{
            id,
            label: account.name,
            providerId: account.providerId,
            cost,
            previousCost: prevByAccount.get(id) ?? 0,
            deltaPct: delta(cost, prevByAccount.get(id)),
            sharePct: share(cost),
          }]
        : [];
    })
    .sort((a, b) => b.cost - a.cost);

  const serviceItems: BreakdownItem[] = [...costByService]
    .flatMap(([id, cost]) => {
      const service = ds.serviceById.get(id);
      return service
        ? [{
            id,
            label: service.name,
            providerId: service.providerId,
            category: service.category,
            cost,
            previousCost: prevByService.get(id) ?? 0,
            deltaPct: delta(cost, prevByService.get(id)),
            sharePct: share(cost),
          }]
        : [];
    })
    .sort((a, b) => b.cost - a.cost);

  // ---- Time series at every granularity ------------------------------------------
  const series = {
    day: buildSeries(current, dailyBuckets(range.from, range.to), bounds),
    week: buildSeries(scoped, bucketDefs('week', bounds), bounds),
    month: buildSeries(scoped, bucketDefs('month', bounds), bounds),
    year: buildSeries(scoped, bucketDefs('year', bounds), bounds),
  };

  // ---- Current vs previous period ----------------------------------------------------
  const currentDaily = series.day.map((p) => p.total);
  const previousDaily = range.hasPrevious ? dailyTotals(previous, range.prevFrom, range.prevTo) : [];
  const comparison: ComparisonPoint[] = currentDaily.map((value, index) => ({
    index,
    currentDate: addDays(range.from, index),
    previousDate: addDays(range.prevFrom, index),
    current: Math.round(value * 100) / 100,
    previous: range.hasPrevious ? Math.round((previousDaily[index] ?? 0) * 100) / 100 : null,
  }));

  // ---- Savings ------------------------------------------------------------------------
  const savings = computeOpportunities(ds, current, anomalies, range.days);
  const runRate = (totalSpend / range.days) * 30;

  // ---- KPIs -----------------------------------------------------------------------------
  const month = monthStats(scoped, ds.endDate);
  const accountsInScope = ds.accounts.filter((a) => scope.accountIds.has(a.id));
  const monthlyBudget = accountsInScope.reduce((acc, a) => acc + a.monthlyBudget, 0);

  const kpis: FullDashboardData['kpis'] = {
    totalSpend: {
      value: totalSpend,
      previous: previousSpend,
      deltaPct: previousSpend === null ? null : pctChange(totalSpend, previousSpend),
      series: currentDaily,
      avgDaily: totalSpend / range.days,
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
      monthLabel: MONTH_NAMES[Number(ds.endDate.slice(5, 7)) - 1] ?? '',
    },
    budget: {
      applicable: filters.serviceId === 'all',
      monthlyBudget,
      mtdSpend: month.mtd,
      projectedSpend: month.projected,
      mtdPct: monthlyBudget > 0 ? (month.mtd / monthlyBudget) * 100 : 0,
      projectedPct: monthlyBudget > 0 ? (month.projected / monthlyBudget) * 100 : 0,
    },
    services: {
      inUse: costByService.size,
      categories: new Set(serviceItems.flatMap((s) => (s.category ? [s.category] : []))).size,
    },
    anomalies: {
      active: anomalies.filter((a) => isActive(a.status)).length,
      total: anomalies.length,
      criticalOrHigh: anomalies.filter((a) => isActive(a.status) && (a.severity === 'critical' || a.severity === 'high')).length,
    },
    savings: {
      monthly: savings.monthlyTotal,
      pctOfRunRate: runRate > 0 ? (savings.monthlyTotal / runRate) * 100 : 0,
      opportunities: savings.opportunities.length,
    },
  };

  // ---- Account summaries ---------------------------------------------------------------------
  const rowsByAccount = new Map<string, DailyCost[]>();
  for (const r of scoped) {
    const list = rowsByAccount.get(r.accountId);
    if (list) list.push(r);
    else rowsByAccount.set(r.accountId, [r]);
  }
  const accounts: BudgetedAccountSummary[] = accountsInScope
    .map((account) => {
      const rows = rowsByAccount.get(account.id) ?? [];
      const cost = costByAccount.get(account.id) ?? 0;
      const previousCost = prevByAccount.get(account.id) ?? 0;
      const stats = monthStats(rows, ds.endDate);
      const projectedPct = (stats.projected / account.monthlyBudget) * 100;
      return {
        accountId: account.id,
        name: account.name,
        providerId: account.providerId,
        environment: account.environment,
        team: account.team,
        owner: account.owner,
        region: account.region,
        externalId: account.externalId,
        cost,
        previousCost,
        deltaPct: delta(cost, previousCost),
        sharePct: share(cost),
        monthlyBudget: account.monthlyBudget,
        mtdSpend: stats.mtd,
        projectedSpend: stats.projected,
        mtdPct: (stats.mtd / account.monthlyBudget) * 100,
        projectedPct,
        budgetStatus: budgetStatusFor(projectedPct),
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
    savings: savings.opportunities,
  };
}
