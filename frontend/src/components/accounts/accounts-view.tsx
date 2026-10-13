'use client';

import { Building2, CircleCheck, CloudOff, Link2, MoreHorizontal, RefreshCw, TriangleAlert, Wallet } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useDetectionConfig } from '@/components/anomalies/detection-config-context';
import { useConnections } from '@/components/connections/connections-context';
import { AccountDetailDialog } from '@/components/dashboard/account-detail-dialog';
import { useAnomalyStatus } from '@/components/dashboard/anomaly-status-context';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { FilterBar } from '@/components/filters/filter-bar';
import { useFilters } from '@/components/filters/filters-context';
import { PageHeader } from '@/components/layout/page-header';
import { ErrorState } from '@/components/shared/error-state';
import { NoDataNotice } from '@/components/shared/no-data-notice';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useDashboardData } from '@/hooks/use-dashboard-data';
import { useDemoNow } from '@/hooks/use-demo-now';
import { formatCompactCurrency, formatCurrency, formatDateRange, formatDateTime, formatRelative, formatSignedPercent } from '@/lib/format';
import { dashboardLink } from '@/lib/links';
import { RANGE_LABELS } from '@/lib/selectors/range';
import { COST_CAPABILITIES, getFilterOptions } from '@/lib/services/cost-service';
import { ABSENT, environmentLabel, PROVIDER_COLOR, PROVIDER_SHORT_NAME } from '@/lib/theme';
import { cn } from '@/lib/utils';
import type { Account } from '@/types/domain';
import { ReconnectDialog } from './reconnect-dialog';
import { ConnectionBadge } from './connection-badge';
import { DisconnectDialog } from './disconnect-dialog';

export function AccountsView() {
  const router = useRouter();
  const { filters } = useFilters();
  const { config } = useDetectionConfig();
  const { overrides } = useAnomalyStatus();
  const state = useDashboardData(filters, overrides, config);
  const { connectionOf, summarize, sync, syncAll } = useConnections();
  /**
   * CONNECT / DISCONNECT / SYNC ARE A SIMULATION. Nothing calls a
   * cloud API, and no table records connection health -- the real
   * `cloud_connections` rows record registration and are superadmin
   * only. In live mode the whole column, the two dialogs and the
   * three health tiles come off, rather than reporting an invented
   * state next to real spend.
   */
  const simulated = COST_CAPABILITIES.simulatedConnections;

  const [connecting, setConnecting] = useState<Account | null>(null);
  const [disconnecting, setDisconnecting] = useState<Account | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const accounts = useMemo(
    () => getFilterOptions().accounts.filter((a) => (filters.providerId === 'all' || a.providerId === filters.providerId) && (filters.accountId === 'all' || a.id === filters.accountId)),
    [filters.providerId, filters.accountId],
  );
  const summary = simulated ? summarize(accounts) : null;
  const now = useDemoNow();
  const latestSync = simulated
    ? accounts.map((a) => connectionOf(a.id)).filter((c) => c.status !== 'disconnected').map((c) => c.lastSyncedAt).sort().pop()
    : undefined;

  const data = state.status === 'ready' ? state.data : null;
  const spendById = new Map((data?.accounts ?? []).map((a) => [a.accountId, a]));
  const totalSpend = accounts.reduce((acc, a) => acc + (spendById.get(a.id)?.cost ?? 0), 0);
  const periodLabel = data ? (data.range.preset === 'custom' ? formatDateRange(data.range.from, data.range.to) : RANGE_LABELS[data.range.preset]) : '';
  const detail = data?.accounts.find((a) => a.accountId === detailId) ?? null;
  const providerCount = new Set(accounts.map((a) => a.providerId)).size;
  /**
   * The window returned no cost rows at all.
   *
   * The ACCOUNT LIST is still real -- it came from /meta/accounts --
   * so it stays. The spend figures do not: every row would read $0,
   * which asserts that each of these accounts was billed nothing.
   * They render as an em dash instead, with the notice saying why.
   */
  const noRows = data !== null && data.kpis.totalSpend.value === 0;

  return (
    <>
      <PageHeader
        title="Cloud accounts"
        description={
          simulated
            ? "The demo's AWS, Azure and Google Cloud accounts with their spend and simulated sync status."
            : 'Every cloud account you have been granted access to, with its spend for the selected period.'
        }
        actions={
          simulated ? (
            <Button variant="outline" size="sm" onClick={() => syncAll(accounts.map((a) => a.id))} disabled={(summary?.linked ?? 0) === 0}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Sync all
            </Button>
          ) : undefined
        }
      />
      <FilterBar />

      {state.status === 'ready' && (noRows || accounts.length === 0) && <NoDataNotice range={periodLabel} />}

      <section aria-label="Account summary" className={cn('grid gap-3 sm:grid-cols-2', summary ? 'xl:grid-cols-5' : 'xl:grid-cols-3')}>
        <KpiCard title="Accounts" icon={Building2} value={String(accounts.length)} hint={`${providerCount} provider${providerCount === 1 ? '' : 's'}`} />
        {summary && <KpiCard title="Healthy" icon={CircleCheck} tone="success" value={String(summary.healthy)} hint="syncing normally" />}
        {summary && <KpiCard title="Sync delayed" icon={TriangleAlert} tone={summary.degraded > 0 ? 'warning' : 'default'} value={String(summary.degraded)} hint="data may be out of date" />}
        {summary && <KpiCard title="Disconnected" icon={CloudOff} tone={summary.disconnected > 0 ? 'danger' : 'default'} value={String(summary.disconnected)} hint="no new data syncing" />}
        <KpiCard
          title="Spend"
          icon={Wallet}
          value={data === null ? '…' : noRows ? ABSENT : formatCompactCurrency(totalSpend)}
          hint={noRows ? 'no cost rows for this window' : latestSync ? `latest sync ${formatRelative(latestSync, now)}` : periodLabel}
        />
        {!simulated && (
          <KpiCard
            title="With spend"
            icon={CircleCheck}
            value={data === null ? '…' : noRows ? ABSENT : String(accounts.filter((a) => (spendById.get(a.id)?.cost ?? 0) > 0).length)}
            hint="billed something in this period"
          />
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Accounts</CardTitle>
          <CardDescription>
            {periodLabel ? `Spend for ${periodLabel.toLowerCase()}. ` : ''}
            {simulated
              ? 'Sync, connect and disconnect are simulated: no cloud API is called.'
              : 'Registering an account and running an import are managed from Admin, not from this page.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-2">
          {state.status === 'error' ? (
            <div className="px-3 pb-3"><ErrorState title="Could not load accounts" message={state.message} onRetry={() => window.location.reload()} /></div>
          ) : state.status === 'loading' ? (
            <div className="space-y-3 px-3 pb-3">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          ) : (
            <Table className="min-w-[920px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Account</TableHead>
                  <TableHead>Provider</TableHead>
                  {simulated && <TableHead>Environment</TableHead>}
                  {simulated && <TableHead>Connection</TableHead>}
                  <TableHead className="text-right">Spend</TableHead>
                  {simulated && <TableHead>Last synchronization</TableHead>}
                  <TableHead className="text-right"><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.length === 0 && (
                  <TableRow className="hover:bg-transparent"><TableCell colSpan={simulated ? 7 : 4} className="py-12 text-center text-sm text-muted-foreground">No accounts match these filters.</TableCell></TableRow>
                )}
                {accounts.map((a) => {
                  const conn = connectionOf(a.id);
                  const spend = spendById.get(a.id);
                  const disconnected = conn.status === 'disconnected';
                  return (
                    <TableRow key={a.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <span className="h-9 w-1 shrink-0 rounded-full" style={{ backgroundColor: PROVIDER_COLOR[a.providerId] }} aria-hidden />
                          <div className="min-w-0">
                            {spend ? (
                              <button type="button" onClick={() => setDetailId(a.id)} className="truncate rounded text-left font-medium hover:text-ateneo focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{a.name}</button>
                            ) : (
                              <p className="truncate font-medium">{a.name}</p>
                            )}
                            <p className="truncate font-mono text-[11px] text-muted-foreground">{[a.externalId, a.team].filter(Boolean).join(' · ')}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell><span className="font-medium">{PROVIDER_SHORT_NAME[a.providerId]}</span></TableCell>
                      {simulated && <TableCell><Badge variant="outline">{environmentLabel(a.environment)}</Badge></TableCell>}
                      {simulated && <TableCell><ConnectionBadge status={conn.status} syncing={conn.syncing} /></TableCell>}
                      <TableCell className="text-right tabular-nums">
                        <p className="font-medium">{noRows || !spend ? ABSENT : formatCurrency(spend.cost)}</p>
                        {!noRows && spend && spend.deltaPct !== null && (
                          <p className={cn('text-[11px]', spend.deltaPct > 0 ? 'text-destructive' : 'text-success')}>{formatSignedPercent(spend.deltaPct)} vs prev</p>
                        )}
                      </TableCell>
                      {simulated && (
                        <TableCell>
                          <p className={cn('text-sm', disconnected && 'text-muted-foreground')}>{formatRelative(conn.lastSyncedAt, now)}</p>
                          <p className="text-[11px] text-muted-foreground">{formatDateTime(conn.lastSyncedAt)}</p>
                        </TableCell>
                      )}
                      <TableCell>
                        <div className="flex items-center justify-end gap-1.5">
                          {simulated &&
                            (disconnected ? (
                              <Button size="sm" onClick={() => setConnecting(a)}><Link2 className="h-3.5 w-3.5" aria-hidden /> Connect</Button>
                            ) : (
                              <Button size="sm" variant="outline" disabled={conn.syncing} onClick={() => sync(a.id)} aria-label={`Sync ${a.name}`}>
                                <RefreshCw className={cn('h-3.5 w-3.5', conn.syncing && 'animate-spin')} aria-hidden /> {conn.syncing ? 'Syncing' : 'Sync'}
                              </Button>
                            ))}
                          <DropdownMenu label={`More actions for ${a.name}`} triggerClassName={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'h-8 w-8')} trigger={<MoreHorizontal className="h-4 w-4" aria-hidden />}>
                            <DropdownMenuItem onSelect={() => router.push(dashboardLink({ accountId: a.id }))}>View in dashboard</DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => router.push(`/compare?provider=${a.providerId}&account=${a.id}`)}>Compare spend</DropdownMenuItem>
                            {simulated && <DropdownMenuSeparator />}
                            {simulated &&
                              (disconnected ? (
                                <DropdownMenuItem onSelect={() => setConnecting(a)}>Connect…</DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem destructive onSelect={() => setDisconnecting(a)}>Disconnect…</DropdownMenuItem>
                              ))}
                          </DropdownMenu>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* The SIMULATION, not the registration form. Reached only
          through the buttons above, which are gated on `simulated`.
          Registering a real cloud account is a different screen with a
          different shape -- /admin/connections -- because the mock
          estate's ids are not AWS account ids and because the endpoint
          behind registration is superadmin-only. */}
      <ReconnectDialog account={connecting} onClose={() => setConnecting(null)} />
      <DisconnectDialog account={disconnecting} onClose={() => setDisconnecting(null)} />
      <AccountDetailDialog account={detail} periodLabel={periodLabel.toLowerCase()} onClose={() => setDetailId(null)} />
    </>
  );
}
