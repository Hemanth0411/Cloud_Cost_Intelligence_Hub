'use client';

import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control';
import { formatDate } from '@/lib/format';
import { RANGE_LABELS, resolveRange } from '@/lib/selectors/range';
import { getFilterOptions } from '@/lib/services/cost-service';
import { PROVIDER_ORDER, PROVIDER_SHORT_NAME } from '@/lib/theme';
import type { DateRangePreset } from '@/types/analytics';
import type { ProviderId } from '@/types/domain';
import type { ReactNode } from 'react';
import { useFilters } from './filters-context';

const PRESETS: ReadonlyArray<SegmentedOption<DateRangePreset>> = (
  [
    ['7d', '7D'], ['30d', '30D'], ['90d', '90D'], ['mtd', 'MTD'], ['ytd', 'YTD'], ['12m', '12M'], ['custom', 'Custom'],
  ] as const
).map(([value, label]) => ({ value, label, title: RANGE_LABELS[value] }));

const dateInputClass =
  'h-7 rounded-md border border-input bg-card px-2 text-xs tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function FilterBar({ trailing }: { trailing?: ReactNode }) {
  const { filters, setFilters, reset, isDefault } = useFilters();
  const { providers, accounts, services, serviceIdsByAccount, dataStart, dataEnd } = getFilterOptions();
  const range = resolveRange(filters, { start: dataStart, end: dataEnd });

  const visibleAccounts = accounts.filter((a) => filters.providerId === 'all' || a.providerId === filters.providerId);
  const visibleServices = services.filter(
    (s) =>
      (filters.providerId === 'all' || s.providerId === filters.providerId) &&
      // Null means the source cannot narrow services to an account,
      // so every service stays offered rather than the dropdown
      // emptying itself the moment an account is picked.
      (filters.accountId === 'all' ||
        serviceIdsByAccount === null ||
        (serviceIdsByAccount[filters.accountId] ?? []).includes(s.id)),
  );

  function onPreset(preset: DateRangePreset): void {
    if (preset === 'custom') setFilters({ range: 'custom', customFrom: range.from, customTo: range.to });
    else setFilters({ range: preset });
  }

  function onFrom(value: string): void {
    if (!value) return;
    const to = filters.customTo && filters.customTo >= value ? filters.customTo : value;
    setFilters({ range: 'custom', customFrom: value, customTo: to });
  }

  function onTo(value: string): void {
    if (!value) return;
    const from = filters.customFrom && filters.customFrom <= value ? filters.customFrom : value;
    setFilters({ range: 'custom', customFrom: from, customTo: value });
  }

  return (
    <div id="filters" className="flex flex-nowrap items-center gap-1.5 rounded-lg border bg-card px-3 py-2">
      <div className="flex h-8 min-w-0 items-center rounded-md bg-muted p-0.5">
        <SegmentedControl ariaLabel="Date range" className="shrink-0 bg-transparent p-0" options={PRESETS} value={filters.range} onChange={onPreset} />
        <span className="mx-1.5 h-4 w-px shrink-0 bg-border" aria-hidden />
        {filters.range === 'custom' ? (
          <div className="flex items-center gap-1.5 pr-1 text-xs text-muted-foreground">
            <label htmlFor="filter-from" className="sr-only">From date</label>
            <input id="filter-from" type="date" className={dateInputClass} min={dataStart} max={dataEnd} value={filters.customFrom ?? ''} onChange={(e) => onFrom(e.target.value)} />
            <span aria-hidden>to</span>
            <label htmlFor="filter-to" className="sr-only">To date</label>
            <input id="filter-to" type="date" className={dateInputClass} min={dataStart} max={dataEnd} value={filters.customTo ?? ''} onChange={(e) => onTo(e.target.value)} />
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-1.5 truncate whitespace-nowrap px-2 text-xs text-muted-foreground">
            <span className="tabular-nums">{formatDate(range.from, 'short')} – {formatDate(range.to, 'short')}</span>
            <span aria-hidden>·</span>
            <span className="font-medium text-foreground">{range.days}d</span>
          </div>
        )}
      </div>

      <span className="h-5 w-px shrink-0 bg-border" aria-hidden />

      <label className="sr-only" htmlFor="filter-provider">Cloud provider</label>
      <Select
        id="filter-provider"
        className="w-32"
        value={filters.providerId}
        onChange={(e) => setFilters({ providerId: e.target.value as ProviderId | 'all' })}
      >
        <option value="all">All providers</option>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>{PROVIDER_SHORT_NAME[p.id]}</option>
        ))}
      </Select>

      <label className="sr-only" htmlFor="filter-account">Account</label>
      <Select id="filter-account" className="w-40" value={filters.accountId} onChange={(e) => setFilters({ accountId: e.target.value })}>
        <option value="all">All accounts ({visibleAccounts.length})</option>
        {visibleAccounts.map((a) => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </Select>

      <label className="sr-only" htmlFor="filter-service">Service</label>
      <Select id="filter-service" className="w-36" value={filters.serviceId} onChange={(e) => setFilters({ serviceId: e.target.value })}>
        <option value="all">All services ({visibleServices.length})</option>
        {PROVIDER_ORDER.map((pid) => {
          const group = visibleServices.filter((s) => s.providerId === pid);
          return group.length === 0 ? null : (
            <optgroup key={pid} label={PROVIDER_SHORT_NAME[pid]}>
              {group.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </optgroup>
          );
        })}
      </Select>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" className="px-2" onClick={reset} disabled={isDefault}>
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          Reset
        </Button>
        {trailing}
      </div>
    </div>
  );
}
