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
import { COST_CAPABILITIES } from '@/lib/services/cost-service';
import { ABSENT } from '@/lib/theme';
import type { DashboardData } from '@/types/analytics';
import { KpiCard } from './kpi-card';

/**
 * The eight headline numbers -- or fewer.
 *
 * TWO CARDS ARE DROPPED ENTIRELY RATHER THAN DASHED OUT when the data
 * source cannot back them:
 *
 *  * "Connected accounts" counts a connection state that only the
 *    mock simulates. There is a real `cloud_connections` table but it
 *    records registration, not health, and only a superadmin can read
 *    it -- so in live mode this card would be reporting a number from
 *    a simulation sitting next to seven real ones.
 *  * "Potential savings" needs an optimizer that has no endpoint.
 *
 * The other two that can be absent -- budget and service categories
 * -- stay, because the card itself is still the right place to
 * explain why there is no figure. The difference is whether the
 * HEADING would be a claim: "Connected accounts: 1" asserts
 * something, "Budget utilization: —" does not.
 */
export function KpiGrid({ data }: { data: DashboardData }) {
  const { kpis, range } = data;
  const { summarize } = useConnections();
  const { budget } = kpis;
  const prev = kpis.previousSpend;

  // Connection state is simulated and changes at runtime, so it is
  // layered on top of the calculated KPIs rather than computed with
  // them. Only read when the simulation is the mode in play.
  const links = COST_CAPABILITIES.simulatedConnections
    ? summarize(data.accounts.map((a) => ({ id: a.accountId, providerId: a.providerId })))
    : null;

  const budgetTone =
    budget === null ? 'default' : budget.projectedPct > 100 ? 'danger' : budget.projectedPct >= 90 ? 'warning' : 'default';
  const accountsTone = (l: NonNullable<typeof links>): 'danger' | 'warning' | 'default' =>
    l.disconnected > 0 ? 'danger' : l.degraded > 0 ? 'warning' : 'default';
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
        value={prev.value === null ? ABSENT : formatCompactCurrency(prev.value)}
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
        tone={budget?.applicable ? budgetTone : 'default'}
        value={budget?.applicable ? formatPercent(budget.projectedPct, 0) : ABSENT}
        hint={
          // THREE DIFFERENT REASONS, THREE DIFFERENT SENTENCES. The
          // first version printed "clear the service filter" when
          // there were no budgets at all, which sent people to change
          // a filter that had nothing to do with it.
          budget === null
            ? 'No budgets are recorded for these accounts.'
            : budget.applicable
              ? `${formatCompactCurrency(budget.projectedSpend)} projected of ${formatCompactCurrency(budget.monthlyBudget)}`
              : 'Budgets apply to whole accounts. Clear the service filter.'
        }
      />
      {links !== null && (
        <KpiCard
          title="Connected accounts"
          icon={Building2}
          tone={accountsTone(links)}
          value={String(links.linked)}
          hint={
            links.disconnected > 0
              ? `${links.disconnected} disconnected · ${links.degraded} sync delayed`
              : links.degraded > 0
                ? `${links.providers} providers · ${links.degradedProviders} degraded`
                : `Across ${links.providers} provider${links.providers === 1 ? '' : 's'}`
          }
        />
      )}
      <KpiCard
        title="Services in use"
        icon={Layers}
        value={String(kpis.services.inUse)}
        hint={
          kpis.services.categories === null
            ? 'with spend in this period'
            : `${kpis.services.categories} service categories`
        }
      />
      <KpiCard
        title="Detected anomalies"
        icon={Activity}
        tone={anomalyTone}
        value={String(kpis.anomalies.total)}
        hint={`${kpis.anomalies.active} active · ${kpis.anomalies.criticalOrHigh} high/critical`}
      />
      {kpis.savings !== null && (
        <KpiCard
          title="Potential savings (est.)"
          icon={PiggyBank}
          tone="success"
          value={formatCompactCurrency(kpis.savings.monthly)}
          hint={`estimate per month · ${formatPercent(kpis.savings.pctOfRunRate, 0)} of run-rate`}
        />
      )}
    </section>
  );
}
