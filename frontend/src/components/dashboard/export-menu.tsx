'use client';

import { ChevronDown, Download, FileSpreadsheet } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { downloadTextFile } from '@/lib/download';
import { accountsToCsv, anomaliesToCsv, savingsToCsv, trendToCsv } from '@/lib/export';
import { cn } from '@/lib/utils';
import type { DashboardData, Granularity } from '@/types/analytics';

const SERIES_LABELS: ReadonlyArray<{ key: Granularity; label: string }> = [
  { key: 'day', label: 'Daily spend (selected range)' },
  { key: 'week', label: 'Weekly spend (26 weeks)' },
  { key: 'month', label: 'Monthly spend (12 months)' },
  { key: 'year', label: 'Yearly spend' },
];

export function ExportMenu({ data, className }: { data: DashboardData; className?: string }) {
  const stamp = `${data.range.from}_${data.range.to}`;
  const icon = <FileSpreadsheet className="h-4 w-4" />;
  return (
    <DropdownMenu
      label="Export data"
      menuClassName="w-max min-w-[16rem]"
      triggerClassName={cn(buttonVariants({ variant: 'default', size: 'sm' }), className)}
      trigger={
        <>
          <Download className="h-3 w-3" aria-hidden /> Export <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden />
        </>
      }
    >
      <DropdownMenuLabel>Current filters · CSV</DropdownMenuLabel>
      <DropdownMenuSeparator />
      {SERIES_LABELS.map(({ key, label }) => (
        <DropdownMenuItem key={key} icon={icon} onSelect={() => downloadTextFile(`costhub-${key}-spend-${stamp}.csv`, trendToCsv(data.series[key]))}>
          {label}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem icon={icon} onSelect={() => downloadTextFile(`costhub-accounts-${stamp}.csv`, accountsToCsv(data.accounts))}>
        Accounts and budgets
      </DropdownMenuItem>
      <DropdownMenuItem icon={icon} onSelect={() => downloadTextFile(`costhub-anomalies-${stamp}.csv`, anomaliesToCsv(data.anomalies))}>
        Anomalies
      </DropdownMenuItem>
      <DropdownMenuItem icon={icon} onSelect={() => downloadTextFile(`costhub-savings-${stamp}.csv`, savingsToCsv(data.savings ?? []))}>
        Savings opportunities
      </DropdownMenuItem>
    </DropdownMenu>
  );
}
