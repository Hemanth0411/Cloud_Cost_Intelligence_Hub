'use client';

import { Calendar, RotateCcw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control';
import { formatDateRange } from '@/lib/format';
import { RANGE_LABELS, resolveRange } from '@/lib/selectors/range';
import { getFilterOptions } from '@/lib/services/cost-service';
import { PROVIDER_ORDER, PROVIDER_SHORT_NAME } from '@/lib/theme';
import type { DateRangePreset } from '@/types/analytics';
import type { ProviderId } from '@/types/domain';
import { useFilters } from './filters-context';

const PRESETS: ReadonlyArray<SegmentedOption<DateRangePreset>> = (
  [
    ['7d', '7D'], ['30d', '30D'], ['90d', '90D'], ['mtd', 'MTD'], ['ytd', 'YTD'], ['12m', '12M'], ['custom', 'Custom'],
  ] as const
).map(([value, label]) => ({ value, label, title: RANGE_LABELS[value] }));

const dateInputClass =
  'h-8 w-full rounded-md border border-input bg-card px-2 text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function FilterBar({ trailing }: { trailing?: ReactNode }) {
  const { filters, setFilters, reset, isDefault } = useFilters();
  const [rangeOpen, setRangeOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');
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

  function openCustomRange(): void {
    setDraftFrom(filters.customFrom ?? range.from);
    setDraftTo(filters.customTo ?? range.to);
    setRangeOpen(true);
  }

  function onPreset(preset: DateRangePreset): void {
    if (preset === 'custom') {
      openCustomRange();
      return;
    }
    setFilters({ range: preset });
  }

  function applyCustomRange(): void {
    if (!draftFrom || !draftTo || draftFrom > draftTo) return;
    setFilters({ range: 'custom', customFrom: draftFrom, customTo: draftTo });
    setRangeOpen(false);
  }

  const rangeInvalid = Boolean(draftFrom && draftTo && draftFrom > draftTo);

  return (
    <div id="filters" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl ariaLabel="Date range" itemClassName="h-6 min-w-[4.25rem] px-4" options={PRESETS} value={filters.range} onChange={onPreset} />
        <div className="flex items-center gap-1.5 whitespace-nowrap text-sm text-muted-foreground">
          <Calendar className="h-4 w-4 shrink-0" aria-hidden />
          <span className="tabular-nums">{formatDateRange(range.from, range.to)}</span>
          <span aria-hidden>·</span>
          <span>{range.days}d</span>
        </div>
      </div>
      <div className="flex flex-nowrap items-center gap-2">
        <label className="sr-only" htmlFor="filter-provider">Cloud provider</label>
        <Select
          id="filter-provider"
          className="h-7 w-40 pl-3 text-sm leading-7"
          value={filters.providerId}
          onChange={(e) => setFilters({ providerId: e.target.value as ProviderId | 'all' })}
        >
          <option value="all">All providers</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{PROVIDER_SHORT_NAME[p.id]}</option>
          ))}
        </Select>
        <label className="sr-only" htmlFor="filter-account">Account</label>
        <Select id="filter-account" className="h-7 w-44 pl-3 text-sm leading-7" value={filters.accountId} onChange={(e) => setFilters({ accountId: e.target.value })}>
          <option value="all">All accounts ({visibleAccounts.length})</option>
          {visibleAccounts.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </Select>
        <label className="sr-only" htmlFor="filter-service">Service</label>
        <Select id="filter-service" className="h-7 w-56 pl-3 text-sm leading-7" value={filters.serviceId} onChange={(e) => setFilters({ serviceId: e.target.value })}>
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
        <Button variant="ghost" size="sm" className="h-7 px-2 text-muted-foreground" onClick={reset} disabled={isDefault}>
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          Reset
        </Button>
        {trailing}
      </div>

      <Dialog
        open={rangeOpen}
        onOpenChange={setRangeOpen}
        title="Custom date range"
        description="Choose a start and end date within the available data."
        className="sm:max-w-sm"
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setRangeOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={applyCustomRange} disabled={!draftFrom || !draftTo || rangeInvalid}>Apply</Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs font-medium text-foreground">
            From
            <input id="filter-from" type="date" className={dateInputClass} min={dataStart} max={draftTo || dataEnd} value={draftFrom} onChange={(e) => setDraftFrom(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs font-medium text-foreground">
            To
            <input id="filter-to" type="date" className={dateInputClass} min={draftFrom || dataStart} max={dataEnd} value={draftTo} onChange={(e) => setDraftTo(e.target.value)} />
          </label>
        </div>
        {rangeInvalid && <p className="mt-2 text-xs text-destructive">The start date has to be on or before the end date.</p>}
      </Dialog>
    </div>
  );
}
