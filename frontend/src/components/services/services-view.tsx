'use client';

import { ArrowDown, ArrowUp, ArrowUpDown, Search } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { useDetectionConfig } from '@/components/anomalies/detection-config-context';
import { useAnomalyStatus } from '@/components/dashboard/anomaly-status-context';
import { FilterBar } from '@/components/filters/filter-bar';
import { useFilters } from '@/components/filters/filters-context';
import { PageHeader } from '@/components/layout/page-header';
import { ErrorState } from '@/components/shared/error-state';
import { NoDataNotice } from '@/components/shared/no-data-notice';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useDashboardData } from '@/hooks/use-dashboard-data';
import { formatCurrency, formatPercent, formatSignedPercent } from '@/lib/format';
import { dashboardLink } from '@/lib/links';
import { COST_CAPABILITIES, getFilterOptions } from '@/lib/services/cost-service';
import { PROVIDER_COLOR, PROVIDER_SHORT_NAME } from '@/lib/theme';
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
  const options: ReadonlyArray<SegmentedOption<ServiceCategory | 'all'>> = [
    { value: 'all', label: `All ${categoryCounts.get('all') ?? 0}` },
    ...CATEGORIES.filter((c) => (categoryCounts.get(c) ?? 0) > 0).map((c) => ({ value: c, label: `${CATEGORY_LABEL[c]} ${categoryCounts.get(c) ?? 0}` })),
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
    const Icon = !active ? ArrowUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown;
    return (
      <TableHead className={right ? 'text-right' : undefined} aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}>
        <button type="button" onClick={() => onSort(key)} className={cn('inline-flex items-center gap-1 uppercase tracking-wide hover:text-foreground', active && 'text-foreground')}>
          {label}<Icon className="h-3 w-3" aria-hidden />
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
        <CardHeader className="gap-3">
          <div>
            <CardTitle>Services</CardTitle>
            <CardDescription>
              {state.status !== 'ready'
                ? 'Loading…'
                : rows.length === 0
                  ? 'No services with spend in this selection'
                  : `${rows.length} services · ${formatCurrency(categoryTotal)} in view`}
            </CardDescription>
          </div>
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
            {COST_CAPABILITIES.serviceCategories && (
              <SegmentedControl ariaLabel="Service category" options={options} value={category} onChange={setCategory} />
            )}
            <div className="relative lg:ml-auto lg:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <label htmlFor="service-search" className="sr-only">Search services</label>
              <Input id="service-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search services…" className="h-9 pl-8" />
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-2">
          {state.status === 'error' ? (
            <div className="px-3 pb-3"><ErrorState title="Could not load services" message={state.message} onRetry={() => window.location.reload()} /></div>
          ) : state.status === 'loading' ? (
            <div className="space-y-3 px-3 pb-3">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
          ) : (
            <Table className="min-w-[700px]">
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
                      <div className="flex items-center gap-2.5">
                        <span className="h-8 w-1 shrink-0 rounded-full" style={{ backgroundColor: PROVIDER_COLOR[s.providerId] }} aria-hidden />
                        <div className="min-w-0">
                          <Link href={dashboardLink({ serviceId: s.id })} className="truncate font-medium hover:text-primary hover:underline" title="Open in dashboard">{s.label}</Link>
                          <p className="text-[11px] text-muted-foreground">{PROVIDER_SHORT_NAME[s.providerId]}</p>
                        </div>
                      </div>
                    </TableCell>
                    {COST_CAPABILITIES.serviceCategories && <TableCell><Badge variant="secondary">{s.category ? CATEGORY_LABEL[s.category] : 'n/a'}</Badge></TableCell>}
                    <TableCell className="text-right font-medium tabular-nums">{formatCurrency(s.cost)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{formatPercent(s.sharePct)}</TableCell>
                    <TableCell className={cn('text-right tabular-nums', s.deltaPct === null ? 'text-muted-foreground' : s.deltaPct > 0 ? 'text-destructive' : 'text-success')}>{s.deltaPct === null ? '–' : formatSignedPercent(s.deltaPct)}</TableCell>
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
