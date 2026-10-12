'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control';
import { formatPercent } from '@/lib/format';
import type { DashboardData } from '@/types/analytics';
import { BreakdownBars } from './breakdown-bars';
import { ProviderDonut } from './provider-donut';

type Dimension = 'provider' | 'account' | 'service';

const OPTIONS: ReadonlyArray<SegmentedOption<Dimension>> = [
  { value: 'provider', label: 'Provider' },
  { value: 'account', label: 'Account' },
  { value: 'service', label: 'Service' },
];

const TOP_N = 8;

export function BreakdownCard({ data }: { data: DashboardData }) {
  const [dimension, setDimension] = useState<Dimension>('provider');
  const items = data.breakdowns[dimension];
  const shown = items.slice(0, TOP_N);
  const shownShare = shown.reduce((acc, i) => acc + i.sharePct, 0);
  const total = data.kpis.totalSpend.value;

  return (
    <Card className="h-full">
      <CardHeader className="gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle>Spend breakdown</CardTitle>
            <CardDescription>Where the money goes, for the selected period and filters</CardDescription>
          </div>
          <SegmentedControl ariaLabel="Breakdown dimension" options={OPTIONS} value={dimension} onChange={setDimension} />
        </div>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">No spend for this selection.</p>
        ) : dimension === 'provider' ? (
          <ProviderDonut data={items} total={total} />
        ) : (
          <>
            <BreakdownBars data={shown} ariaLabel={`Bar chart of top ${dimension}s by cost`} />
            <p className="mt-2 text-xs text-muted-foreground">
              Top {shown.length} of {items.length} {dimension}s · {formatPercent(shownShare, 0)} of total spend
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
