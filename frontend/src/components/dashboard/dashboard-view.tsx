'use client';

import { useMemo, useState } from 'react';
import { useDetectionConfig } from '@/components/anomalies/detection-config-context';
import { InvestigationDialog } from '@/components/anomalies/investigation-dialog';
import { BreakdownCard } from '@/components/charts/breakdown-card';
import { ComparisonChart } from '@/components/charts/comparison-chart';
import { SpendOverTimeChart } from '@/components/charts/spend-over-time-chart';
import { FilterBar } from '@/components/filters/filter-bar';
import { useFilters } from '@/components/filters/filters-context';
import { useDashboardData } from '@/hooks/use-dashboard-data';
import { formatDateRange } from '@/lib/format';
import { buildInsightReport } from '@/lib/services/cost-service';
import { RANGE_LABELS } from '@/lib/selectors/range';
import { cn } from '@/lib/utils';
import { AccountDetailDialog } from './account-detail-dialog';
import { AccountsTable } from './accounts-table';
import { useAnomalyStatus } from './anomaly-status-context';
import { AnomaliesPanel } from './anomalies-panel';
import { DashboardSkeleton } from './dashboard-skeleton';
import { ExportMenu } from './export-menu';
import { InsightsPreview } from './insights-preview';
import { KpiGrid } from './kpi-grid';
import { SavingsPanel } from './savings-panel';
import { TopServicesTable } from './top-services-table';

export function DashboardView() {
  const { filters } = useFilters();
  const { config } = useDetectionConfig();
  const { overrides } = useAnomalyStatus();
  const state = useDashboardData(filters, overrides, config);
  const [selectedAnomalyId, setSelectedAnomalyId] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const data = state.status === 'ready' ? state.data : null;
  const report = useMemo(() => (data ? buildInsightReport(filters, data, config) : null), [data, filters, config]);

  if (state.status === 'loading') return <DashboardSkeleton />;

  const { isRefreshing } = state;
  if (!data || !report) return <DashboardSkeleton />;
  const selectedAnomaly = data.anomalies.find((a) => a.id === selectedAnomalyId) ?? null;
  const selectedAccount = data.accounts.find((a) => a.accountId === selectedAccountId) ?? null;
  const periodLabel =
    data.range.preset === 'custom'
      ? formatDateRange(data.range.from, data.range.to)
      : RANGE_LABELS[data.range.preset];

  return (
    <div
      aria-busy={isRefreshing}
      className={cn('animate-fade-in space-y-4 transition-opacity duration-150', isRefreshing && 'opacity-60')}
    >
      <FilterBar trailing={<ExportMenu data={data} />} />

      <KpiGrid data={data} />

      <InsightsPreview report={report} />

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <SpendOverTimeChart series={data.series} anomalies={data.anomalies} rangeLabel={periodLabel} />
        </div>
        <SavingsPanel items={data.savings} monthlyTotal={data.kpis.savings.monthly} />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <ComparisonChart data={data} />
        </div>
        <AnomaliesPanel anomalies={data.anomalies} onSelect={(a) => setSelectedAnomalyId(a.id)} />
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <BreakdownCard data={data} />
        <TopServicesTable services={data.breakdowns.service} />
      </div>

      <AccountsTable
        accounts={data.accounts}
        budgetApplicable={data.kpis.budget.applicable}
        onSelect={(a) => setSelectedAccountId(a.accountId)}
      />

      <InvestigationDialog anomaly={selectedAnomaly} onClose={() => setSelectedAnomalyId(null)} />
      <AccountDetailDialog
        account={selectedAccount}
        periodLabel={periodLabel.toLowerCase()}
        onClose={() => setSelectedAccountId(null)}
      />
    </div>
  );
}
