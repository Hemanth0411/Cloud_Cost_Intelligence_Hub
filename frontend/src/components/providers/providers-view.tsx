'use client';

import { ArrowRight, Layers } from 'lucide-react';
import Link from 'next/link';
import { useDetectionConfig } from '@/components/anomalies/detection-config-context';
import { ConnectionBadge } from '@/components/accounts/connection-badge';
import { useConnections } from '@/components/connections/connections-context';
import { useAnomalyStatus } from '@/components/dashboard/anomaly-status-context';
import { FilterBar } from '@/components/filters/filter-bar';
import { useFilters } from '@/components/filters/filters-context';
import { PageHeader } from '@/components/layout/page-header';
import { ErrorState } from '@/components/shared/error-state';
import { NoDataNotice } from '@/components/shared/no-data-notice';
import { Sparkline } from '@/components/charts/sparkline';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useDashboardData } from '@/hooks/use-dashboard-data';
import { useDemoNow } from '@/hooks/use-demo-now';
import { formatCompactCurrency, formatPercent, formatRelative, formatSignedPercent } from '@/lib/format';
import { dashboardLink } from '@/lib/links';
import { isActive } from '@/lib/selectors/anomaly-views';
import { COST_CAPABILITIES, getFilterOptions } from '@/lib/services/cost-service';
import { PROVIDER_COLOR } from '@/lib/theme';
import { cn } from '@/lib/utils';

export function ProvidersView() {
  const { filters } = useFilters();
  const { config } = useDetectionConfig();
  const { overrides } = useAnomalyStatus();
  const state = useDashboardData(filters, overrides, config);
  const { providerStatus, connectionOf } = useConnections();
  const simulatedConnections = COST_CAPABILITIES.simulatedConnections;
  const options = getFilterOptions();
  const now = useDemoNow();

  const providers = options.providers.filter((p) => filters.providerId === 'all' || p.id === filters.providerId);

  return (
    <>
      <PageHeader title="Cloud providers" description="Spend, simulated connection health and activity for each cloud provider in this demo." />
      <FilterBar />

      {state.status === 'ready' && state.data.kpis.totalSpend.value === 0 ? (
        /* One card per provider would print "$0", "0.0% of spend"
           and a sparkline drawn flat along the axis -- `buildSeries`
           emits a point per bucket whether or not any row landed in
           it. That is a picture of a measurement nobody took. */
        <NoDataNotice />
      ) : state.status === 'error' ? (
        <ErrorState title="Could not load providers" message={state.message} onRetry={() => window.location.reload()} />
      ) : state.status === 'loading' ? (
        <div className="grid gap-3 lg:grid-cols-3">{Array.from({ length: 3 }, (_, i) => <Card key={i} className="space-y-4 p-3"><Skeleton className="h-5 w-32" /><Skeleton className="h-9 w-28" /><Skeleton className="h-12 w-full" /></Card>)}</div>
      ) : (
        <div className="grid animate-fade-in gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {providers.map((p) => {
            const data = state.data;
            const item = data.breakdowns.provider.find((b) => b.id === p.id);
            const accounts = options.accounts.filter((a) => a.providerId === p.id && (filters.accountId === 'all' || a.id === filters.accountId));
            const services = data.breakdowns.service.filter((s) => s.providerId === p.id);
            const activeAnomalies = data.anomalies.filter((a) => a.providerId === p.id && isActive(a.status)).length;
            const latestSync = simulatedConnections ? accounts.map((a) => connectionOf(a.id)).filter((c) => c.status !== 'disconnected').map((c) => c.lastSyncedAt).sort().pop() : undefined;
            const series = data.series.day.map((point) => point[p.id]);

            return (
              <Card key={p.id} className="flex flex-col overflow-hidden">
                <div className="h-1" style={{ backgroundColor: PROVIDER_COLOR[p.id] }} aria-hidden />
                <div className="flex-1 space-y-3 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-base font-semibold">{p.name}</h2>
                      <p className="mt-0.5 text-xs text-muted-foreground">{accounts.length} account{accounts.length === 1 ? '' : 's'} · {services.length} services in use</p>
                    </div>
                    {COST_CAPABILITIES.simulatedConnections && <ConnectionBadge status={providerStatus(p.id)} />}
                  </div>

                  <div>
                    <p className="text-3xl font-semibold tabular-nums">{formatCompactCurrency(item?.cost ?? 0)}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      <span className="tabular-nums">{formatPercent(item?.sharePct ?? 0)} of spend</span>
                      {item && item.deltaPct !== null && (
                        <span className={cn('font-medium tabular-nums', item.deltaPct > 0 ? 'text-destructive' : 'text-success')}>{formatSignedPercent(item.deltaPct)} vs previous</span>
                      )}
                    </p>
                  </div>

                  <Sparkline series={series} color={PROVIDER_COLOR[p.id]} />

                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
                    <div><dt className="text-xs text-muted-foreground">Top service</dt><dd className="truncate font-medium">{services[0]?.label ?? 'n/a'}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">Active anomalies</dt><dd className={cn('font-medium tabular-nums', activeAnomalies > 0 && 'text-destructive')}>{activeAnomalies}</dd></div>
                    {COST_CAPABILITIES.simulatedConnections && (
                      <div className="col-span-2"><dt className="text-xs text-muted-foreground">Last synchronization</dt><dd className="font-medium">{latestSync ? formatRelative(latestSync, now) : 'Not syncing'}</dd></div>
                    )}
                  </dl>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t bg-muted/30 px-3 py-3 text-xs font-medium">
                  <Link href={dashboardLink({ providerId: p.id })} className="inline-flex items-center gap-1 text-primary hover:underline">Dashboard <ArrowRight className="h-3 w-3" aria-hidden /></Link>
                  <Link href={`/accounts?provider=${p.id}`} className="text-primary hover:underline">Accounts</Link>
                  <Link href={`/services?provider=${p.id}`} className="inline-flex items-center gap-1 text-primary hover:underline"><Layers className="h-3 w-3" aria-hidden /> Services</Link>
                  <Link href={`/compare?provider=${p.id}`} className="text-primary hover:underline">Compare</Link>
                </div>
              </Card>
            );
          })}
          {providers.length === 0 && <Card className="p-10 text-center text-sm text-muted-foreground lg:col-span-3">No providers match these filters.</Card>}
        </div>
      )}
    </>
  );
}
