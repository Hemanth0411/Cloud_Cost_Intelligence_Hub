'use client';

import { useMemo, useState } from 'react';
import { useDetectionConfig } from '@/components/anomalies/detection-config-context';
import { InvestigationDialog } from '@/components/anomalies/investigation-dialog';
import { BreakdownCard } from '@/components/charts/breakdown-card';
import { ComparisonChart } from '@/components/charts/comparison-chart';
import { SpendOverTimeChart } from '@/components/charts/spend-over-time-chart';
import { FilterBar } from '@/components/filters/filter-bar';
import { useFilters } from '@/components/filters/filters-context';
import { ErrorState } from '@/components/shared/error-state';
import { NoDataNotice } from '@/components/shared/no-data-notice';
import { useDashboardData } from '@/hooks/use-dashboard-data';
import { formatDateRange } from '@/lib/format';
import { buildInsightReport, COST_CAPABILITIES } from '@/lib/services/cost-service';
import { RANGE_LABELS } from '@/lib/selectors/range';
import { cn } from '@/lib/utils';
import type { InsightReport } from '@/lib/insights/generate';
import type { DashboardData } from '@/types/analytics';
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
  // Null whenever the insight engine cannot run -- live mode has no
  // endpoint for it. The preview is dropped rather than emptied.
  const report = useMemo(() => (data ? buildInsightReport(filters, data, config) : null), [data, filters, config]);

  if (state.status === 'loading') return <DashboardSkeleton />;
  if (state.status === 'error') {
    return <ErrorState title="Could not load the dashboard" message={state.message} onRetry={() => window.location.reload()} />;
  }

  const { isRefreshing } = state;
  if (!data) return <DashboardSkeleton />;
  const selectedAnomaly = data.anomalies.find((a) => a.id === selectedAnomalyId) ?? null;
  const selectedAccount = data.accounts.find((a) => a.accountId === selectedAccountId) ?? null;
  const periodLabel =
    data.range.preset === 'custom'
      ? formatDateRange(data.range.from, data.range.to)
      : RANGE_LABELS[data.range.preset];
  // NO ROWS AT ALL IN THE WINDOW.
  //
  // Everything below would still render: eight KPI cards reading $0,
  // a daily area chart flat along the axis, a donut with no segments.
  // That is not an empty screen, it is a screen asserting that this
  // estate spent nothing -- a measurement nobody made. So the body is
  // replaced by the notice rather than decorated with it.
  // The WINDOW'S OWN TOTAL decides this, nothing else. An earlier
  // version also required the provider list to be empty, but that
  // list includes anything with previous-period spend -- so a window
  // where billing stopped kept the full body and drew a flat line at
  // zero, which is exactly the claim this guard exists to prevent.
  const noRows = data.kpis.totalSpend.value === 0;

  return (
    <div
      aria-busy={isRefreshing}
      className={cn('animate-fade-in space-y-3 transition-opacity duration-150', isRefreshing && 'opacity-60')}
    >
      <FilterBar trailing={<ExportMenu data={data} />} />

      {noRows ? (
        <NoDataNotice range={formatDateRange(data.range.from, data.range.to)} />
      ) : (
        <DashboardBody
          data={data}
          report={report}
          periodLabel={periodLabel}
          onSelectAnomaly={setSelectedAnomalyId}
          onSelectAccount={setSelectedAccountId}
        />
      )}

      <InvestigationDialog anomaly={selectedAnomaly} onClose={() => setSelectedAnomalyId(null)} />
      <AccountDetailDialog
        account={selectedAccount}
        periodLabel={periodLabel.toLowerCase()}
        onClose={() => setSelectedAccountId(null)}
      />
    </div>
  );
}

interface BodyProps {
  data: DashboardData;
  report: InsightReport | null;
  periodLabel: string;
  onSelectAnomaly: (id: string) => void;
  onSelectAccount: (id: string) => void;
}

function DashboardBody({ data, report, periodLabel, onSelectAnomaly, onSelectAccount }: BodyProps) {
  return (
    <>
      <KpiGrid data={data} />

      {report !== null && <InsightsPreview report={report} />}

      <div className="grid gap-3 xl:grid-cols-3">
        <div className={cn(data.savings === null ? 'xl:col-span-3' : 'xl:col-span-2')}>
          <SpendOverTimeChart series={data.series} anomalies={data.anomalies} rangeLabel={periodLabel} />
        </div>
        {data.savings !== null && data.kpis.savings !== null && (
          <SavingsPanel items={data.savings} monthlyTotal={data.kpis.savings.monthly} />
        )}
      </div>

      <div className="grid gap-3 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <ComparisonChart data={data} />
        </div>
        <AnomaliesPanel anomalies={data.anomalies} onSelect={(a) => onSelectAnomaly(a.id)} />
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <BreakdownCard data={data} />
        <TopServicesTable services={data.breakdowns.service} />
      </div>

      <AccountsTable
        accounts={data.accounts}
        budgetApplicable={data.kpis.budget?.applicable ?? false}
        budgetNote={
          COST_CAPABILITIES.budgets
            ? undefined
            : 'No budgets are recorded for these accounts.'
        }
        onSelect={(a) => onSelectAccount(a.accountId)}
      />
    </>
  );
}

