'use client';

import { Activity, Building2, CalendarClock, Gauge, Layers, PiggyBank, TrendingUp, Wallet } from 'lucide-react';
import {
  formatCompactCurrency,
  formatCurrency,
  formatDateRange,
  formatPercent,
  formatSignedCompactCurrency,
} from '@/lib/format';
import { useConnections } from '@/components/connections/connections-context';
import type { DashboardData } from '@/types/analytics';
import { KpiCard } from './kpi-card';

export function KpiGrid({ data }: { data: DashboardData }) {
  const { kpis, range } = data;
  const { summarize } = useConnections();
  // Connection state is simulated and changes at runtime, so it is layered on top of the calculated KPIs.
  const links = summarize(data.accounts.map((a) => ({ id: a.accountId, providerId: a.providerId })));
  const { budget, previousSpend: prev } = kpis;

  const budgetTone = budget.projectedPct > 100 ? 'danger' : budget.projectedPct >= 90 ? 'warning' : 'default';
  const accountsTone = links.disconnected > 0 ? 'danger' : links.degraded > 0 ? 'warning' : 'default';
  const anomalyTone = kpis.anomalies.criticalOrHigh > 0 ? 'danger' : 'default';

  return (
    <section aria-label="Key metrics" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <KpiCard
        title="Total cloud spend"
        icon={Wallet}
        value={formatCompactCurrency(kpis.totalSpend.value)}
        deltaPct={kpis.totalSpend.deltaPct}
        deltaLabel={`vs previous · ${formatCurrency(kpis.totalSpend.avgDaily)}/day`}
        series={kpis.totalSpend.series}
      />
      <KpiCard
        title="Previous period"
        icon={CalendarClock}
        value={prev.value === null ? '—' : formatCompactCurrency(prev.value)}
        deltaPct={prev.changePct}
        deltaLabel={
          prev.value === null
            ? 'No earlier data to compare'
            : `${formatSignedCompactCurrency(prev.changeAbs ?? 0)} · ${formatDateRange(range.prevFrom, range.prevTo)}`
        }
      />
      <KpiCard
        title={`${kpis.forecast.monthLabel} forecast`}
        icon={TrendingUp}
        value={formatCompactCurrency(kpis.forecast.value)}
        deltaPct={kpis.forecast.deltaPct}
        deltaLabel={`vs last month · ${kpis.forecast.daysRemaining} days left`}
        series={kpis.monthToDate.series}
      />
      <KpiCard
        title="Budget utilization"
        icon={Gauge}
        tone={budget.applicable ? budgetTone : 'default'}
        value={budget.applicable ? formatPercent(budget.projectedPct, 0) : '—'}
        hint={
          budget.applicable
            ? `${formatCompactCurrency(budget.projectedSpend)} projected of ${formatCompactCurrency(budget.monthlyBudget)}`
            : 'Budgets apply to whole accounts. Clear the service filter.'
        }
      />
      <KpiCard
        title="Connected accounts"
        icon={Building2}
        tone={accountsTone}
        value={String(links.linked)}
        hint={
          links.disconnected > 0
            ? `${links.disconnected} disconnected · ${links.degraded} sync delayed`
            : links.degraded > 0
              ? `${links.providers} providers · ${links.degradedProviders} degraded`
              : `Across ${links.providers} provider${links.providers === 1 ? '' : 's'}`
        }
      />
      <KpiCard
        title="Services in use"
        icon={Layers}
        value={String(kpis.services.inUse)}
        hint={`${kpis.services.categories} service categories`}
      />
      <KpiCard
        title="Detected anomalies"
        icon={Activity}
        tone={anomalyTone}
        value={String(kpis.anomalies.total)}
        hint={`${kpis.anomalies.active} active · ${kpis.anomalies.criticalOrHigh} high/critical`}
      />
      <KpiCard
        title="Potential savings (est.)"
        icon={PiggyBank}
        tone="success"
        value={formatCompactCurrency(kpis.savings.monthly)}
        hint={`estimate per month · ${formatPercent(kpis.savings.pctOfRunRate, 0)} of run-rate`}
      />
    </section>
  );
}
