'use client';

import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, ChevronsUpDown, Search } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { useDetectionConfig } from '@/components/anomalies/detection-config-context';
import { useAnomalyStatus } from '@/components/dashboard/anomaly-status-context';
import { FilterBar } from '@/components/filters/filter-bar';
import { useFilters } from '@/components/filters/filters-context';
import { PageHeader } from '@/components/layout/page-header';
import { ErrorState } from '@/components/shared/error-state';
import { NoDataNotice } from '@/components/shared/no-data-notice';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useDashboardData } from '@/hooks/use-dashboard-data';
import { formatCurrency, formatPercent, formatSignedPercent } from '@/lib/format';
import { dashboardLink } from '@/lib/links';
import { COST_CAPABILITIES, getFilterOptions } from '@/lib/services/cost-service';
import { PROVIDER_COLOR, PROVIDER_ORDER, PROVIDER_SHORT_NAME } from '@/lib/theme';
import { cn } from '@/lib/utils';
import type { BreakdownItem } from '@/types/analytics';
import type { ServiceCategory } from '@/types/domain';

type SortKey = 'label' | 'cost' | 'sharePct' | 'deltaPct' | 'accounts';
type SortDir = 'asc' | 'desc';

const CATEGORY_LABEL: Record<ServiceCategory, string> = {
  compute: 'Compute', storage: 'Storage', database: 'Database', network: 'Network', analytics: 'Analytics', 'ai-ml': 'AI / ML',
};
const CATEGORIES = Object.keys(CATEGORY_LABEL) as ServiceCategory[];

export function ServicesView() {
  const { filters } = useFilters();
  const { config } = useDetectionConfig();
  const { overrides } = useAnomalyStatus();
  const state = useDashboardData(filters, overrides, config);

  const [category, setCategory] = useState<ServiceCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('cost');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  /**
   * How many accounts bill each service -- or NULL when the source
   * cannot say.
   *
   * It would be one `/cost/breakdown?dimension=service` per account
   * to find out, and the column previously rendered the unknown as
   * `0`: every service in the estate shown as used by no account.
   * Null drops the column instead.
   */
  const accountsPerService = useMemo(() => {
    const byAccount = getFilterOptions().serviceIdsByAccount;
    if (byAccount === null) return null;
    const map = new Map<string, number>();
    for (const ids of Object.values(byAccount)) for (const id of ids) map.set(id, (map.get(id) ?? 0) + 1);
    return map;
  }, []);

  // Memoised so the identity is stable across renders: two useMemos
  // below depend on it, and a fresh [] every render re-ran both.
  const ready = state.status === 'ready' ? state.data : null;
  const all: BreakdownItem[] = useMemo(() => ready?.breakdowns.service ?? [], [ready]);
  const categoryCounts = useMemo(() => {
    const counts = new Map<ServiceCategory | 'all', number>([['all', all.length]]);
    for (const s of all) if (s.category) counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
    return counts;
  }, [all]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const dir = sortDir === 'asc' ? 1 : -1;
    const value = (s: BreakdownItem): string | number =>
      sortKey === 'label' ? s.label.toLowerCase() : sortKey === 'cost' ? s.cost : sortKey === 'sharePct' ? s.sharePct : sortKey === 'accounts' ? accountsPerService?.get(s.id) ?? 0 : s.deltaPct ?? Number.NEGATIVE_INFINITY;
    return all
      .filter((s) => (category === 'all' || s.category === category) && (q === '' || s.label.toLowerCase().includes(q) || PROVIDER_SHORT_NAME[s.providerId].toLowerCase().includes(q)))
      .sort((a, b) => (value(a) < value(b) ? -1 : value(a) > value(b) ? 1 : 0) * dir);
  }, [all, category, query, sortKey, sortDir, accountsPerService]);

  const categoryTotal = rows.reduce((acc, s) => acc + s.cost, 0);
  const previousTotal = rows.reduce((acc, s) => acc + s.previousCost, 0);
  const periodDelta = previousTotal > 0 ? ((categoryTotal - previousTotal) / previousTotal) * 100 : null;
  const providerShares = PROVIDER_ORDER.map((id) => {
    const cost = rows.reduce((acc, s) => acc + (s.providerId === id ? s.cost : 0), 0);
    return { id, share: categoryTotal > 0 ? (cost / categoryTotal) * 100 : 0 };
  }).filter((p) => p.share > 0);
  const categories: ReadonlyArray<{ value: ServiceCategory | 'all'; label: string; count: number }> = [
    { value: 'all', label: 'All', count: categoryCounts.get('all') ?? 0 },
    ...CATEGORIES.filter((c) => (categoryCounts.get(c) ?? 0) > 0).map((c) => ({ value: c, label: CATEGORY_LABEL[c], count: categoryCounts.get(c) ?? 0 })),
  ];

  function onSort(key: SortKey): void {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'label' ? 'asc' : 'desc');
    }
  }

  const header = (key: SortKey, label: string, right = false): ReactNode => {
    const active = sortKey === key;
    const Icon = !active ? ChevronsUpDown : sortDir === 'asc' ? ChevronUp : ChevronDown;
    return (
      <TableHead className={right ? 'text-right' : undefined} aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}>
        <button type="button" onClick={() => onSort(key)} className={cn('inline-flex w-full items-center gap-1 text-inherit', right && 'justify-end', active && 'text-foreground')}>
          {label}<Icon className="h-3.5 w-3.5 opacity-60" aria-hidden />
        </button>
      </TableHead>
    );
  };

  return (
    <>
      <PageHeader title="Cloud services" description="Every service with spend in the selected period, across all providers." />
      <FilterBar />

      {state.status === 'ready' && all.length === 0 && <NoDataNotice />}

      <Card>
        <CardHeader className="gap-3 px-4 py-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <CardTitle className="text-base">Services</CardTitle>
              <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
                {state.status !== 'ready' ? (
                  'Loading…'
                ) : rows.length === 0 ? (
                  'No services with spend in this selection'
                ) : (
                  <>
                    <span>{rows.length} services</span>
                    <span className="font-semibold text-foreground">{formatCurrency(categoryTotal)}</span>
                    <span>in view</span>
                    {periodDelta !== null && (
                      <span className={cn('inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-medium', periodDelta > 0 ? 'bg-destructive/10 text-destructive' : periodDelta < 0 ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground')}>
                        {periodDelta > 0 ? <ArrowUp className="h-3 w-3" aria-hidden /> : periodDelta < 0 ? <ArrowDown className="h-3 w-3" aria-hidden /> : null}
                        {formatSignedPercent(periodDelta)}
                      </span>
                    )}
                    {periodDelta !== null && <span>vs previous period</span>}
                  </>
                )}
              </p>
            </div>
            {providerShares.length > 0 && (
              <div className="w-full max-w-xs">
                <div className="flex h-1.5 overflow-hidden rounded-full">
                  {providerShares.map((p) => (
                    <span key={p.id} className="h-full" style={{ width: `${p.share}%`, backgroundColor: PROVIDER_COLOR[p.id] }} />
                  ))}
                </div>
                <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {providerShares.map((p) => (
                    <span key={p.id} className="inline-flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: PROVIDER_COLOR[p.id] }} aria-hidden />
                      {PROVIDER_SHORT_NAME[p.id]} {formatPercent(p.share)}
                    </span>
                  ))}
                </p>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {COST_CAPABILITIES.serviceCategories && (
              <div className="flex flex-wrap gap-1" role="group" aria-label="Service category">
                {categories.map((c) => {
                  const active = category === c.value;
                  return (
                    <button
                      key={c.value}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setCategory(c.value)}
                      className={cn('rounded-md px-2 py-1 text-sm', active ? 'border-b-2 border-ateneo font-semibold text-ateneo' : 'text-muted-foreground hover:text-foreground')}
                    >
                      {c.label} <span className={active ? 'font-semibold' : 'font-medium'}>{c.count}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="relative ml-auto w-full max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <label htmlFor="service-search" className="sr-only">Search services</label>
              <Input id="service-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search services" className="h-8 pl-9" />
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-1">
          {state.status === 'error' ? (
            <div className="px-4 pb-3"><ErrorState title="Could not load services" message={state.message} onRetry={() => window.location.reload()} /></div>
          ) : state.status === 'loading' ? (
            <div className="space-y-3 px-4 pb-3">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
          ) : (
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {header('label', 'Service')}
                  {COST_CAPABILITIES.serviceCategories && <TableHead>Category</TableHead>}
                  {header('cost', 'Spend', true)}
                  {header('sharePct', 'Share', true)}
                  {header('deltaPct', 'vs previous', true)}
                  {accountsPerService !== null && header('accounts', 'Accounts', true)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && <TableRow className="hover:bg-transparent"><TableCell colSpan={accountsPerService === null ? 5 : 6} className="py-12 text-center text-sm text-muted-foreground">No services match.</TableCell></TableRow>}
                {rows.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <div className="min-w-0">
                        <Link href={dashboardLink({ serviceId: s.id })} className="block truncate font-medium text-foreground hover:text-ateneo hover:underline" title="Open in dashboard">{s.label}</Link>
                        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: PROVIDER_COLOR[s.providerId] }} aria-hidden />
                          {PROVIDER_SHORT_NAME[s.providerId]}
                        </p>
                      </div>
                    </TableCell>
                    {COST_CAPABILITIES.serviceCategories && <TableCell><span className="inline-flex rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">{s.category ? CATEGORY_LABEL[s.category] : 'n/a'}</span></TableCell>}
                    <TableCell className="text-right font-semibold tabular-nums">{formatCurrency(s.cost)}</TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-2">
                        <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted" aria-hidden>
                          <span className="block h-full rounded-full" style={{ width: `${Math.min(s.sharePct, 100)}%`, backgroundColor: PROVIDER_COLOR[s.providerId] }} />
                        </span>
                        <span className="w-12 text-right tabular-nums text-muted-foreground">{formatPercent(s.sharePct)}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {s.deltaPct === null ? (
                        <span className="text-muted-foreground">–</span>
                      ) : (
                        <span className={cn('inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums', s.deltaPct > 0 ? 'bg-destructive/10 text-destructive' : s.deltaPct < 0 ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground')}>
                          {s.deltaPct > 0 ? <ArrowUp className="h-3 w-3" aria-hidden /> : s.deltaPct < 0 ? <ArrowDown className="h-3 w-3" aria-hidden /> : null}
                          {formatSignedPercent(s.deltaPct)}
                        </span>
                      )}
                    </TableCell>
                    {accountsPerService !== null && <TableCell className="text-right tabular-nums text-muted-foreground">{accountsPerService.get(s.id) ?? 0}</TableCell>}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
