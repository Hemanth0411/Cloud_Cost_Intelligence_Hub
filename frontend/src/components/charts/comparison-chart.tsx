'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCompactCurrency, formatCurrency, formatDateRange, formatSignedCompactCurrency, formatSignedPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { DashboardData } from '@/types/analytics';
import { PeriodOverlayChart } from './period-overlay-chart';

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'up' | 'down' }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('mt-1 text-lg font-semibold tabular-nums', tone === 'up' && 'text-destructive', tone === 'down' && 'text-success')}>{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground tabular-nums">{sub}</p>}
    </div>
  );
}

/** Dashboard card: this period versus the previous one. The Compare page offers the same view in more depth. */
export function ComparisonChart({ data }: { data: DashboardData }) {
  const { range, kpis, comparison } = data;
  const prev = kpis.previousSpend;
  const hasPrev = prev.value !== null;
  const avgPrevious = prev.value !== null ? prev.value / range.days : null;
  const tone = prev.changePct === null ? undefined : prev.changePct > 0 ? 'up' : 'down';

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Current vs previous period</CardTitle>
        <CardDescription>
          {formatDateRange(range.from, range.to)}
          {hasPrev ? ` compared with ${formatDateRange(range.prevFrom, range.prevTo)}` : ' · no earlier data to compare against'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="This period" value={formatCompactCurrency(kpis.totalSpend.value)} sub={`${formatCurrency(kpis.totalSpend.avgDaily)}/day`} />
          <Stat label="Previous period" value={prev.value === null ? '—' : formatCompactCurrency(prev.value)} sub={avgPrevious === null ? undefined : `${formatCurrency(avgPrevious)}/day`} />
          <Stat label="Change" value={prev.changeAbs === null ? '—' : formatSignedCompactCurrency(prev.changeAbs)} tone={tone} />
          <Stat label="Change %" value={prev.changePct === null ? '—' : formatSignedPercent(prev.changePct)} tone={tone} />
        </div>
        <PeriodOverlayChart points={comparison} hasBaseline={hasPrev} />
      </CardContent>
    </Card>
  );
}
