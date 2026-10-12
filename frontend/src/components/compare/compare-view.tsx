'use client';

import { CalendarOff } from 'lucide-react';
import { useState } from 'react';
import { PeriodOverlayChart } from '@/components/charts/period-overlay-chart';
import { FilterBar } from '@/components/filters/filter-bar';
import { useFilters } from '@/components/filters/filters-context';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { useComparison } from '@/hooks/use-comparison';
import { formatCompactCurrency, formatCurrency, formatDateRange, formatSignedCompactCurrency, formatSignedPercent } from '@/lib/format';
import { dashboardLink } from '@/lib/links';
import { DIMENSION_LABELS, entitiesFor } from '@/lib/selectors/comparison';
import { PROVIDER_SHORT_NAME } from '@/lib/theme';
import { cn } from '@/lib/utils';
import type { BaselineKind, ComparisonDimension, ComparisonEntity } from '@/types/analytics';
import { ComparisonTable } from './comparison-table';
import { EntityBarsChart } from './entity-bars-chart';
import { HeadToHead } from './head-to-head';

const BASELINES: ReadonlyArray<SegmentedOption<BaselineKind>> = [
  { value: 'previous', label: 'Previous period', title: 'The equal-length period immediately before (same as the dashboard)' },
  { value: 'year-ago', label: 'Same period last year', title: 'The same dates one year earlier' },
];

const DIMENSIONS: ReadonlyArray<SegmentedOption<ComparisonDimension>> = (['provider', 'account', 'service'] as const).map((d) => ({ value: d, label: DIMENSION_LABELS[d] }));

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'up' | 'down' }) {
  return (
    <Card className="px-3 py-2.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn('mt-1.5 text-2xl font-semibold tabular-nums', tone === 'up' && 'text-destructive', tone === 'down' && 'text-success')}>{value}</p>
      {sub && <p className="mt-1 text-xs text-muted-foreground tabular-nums">{sub}</p>}
    </Card>
  );
}

function displayName(dimension: ComparisonDimension, entity: ComparisonEntity): string {
  return dimension === 'provider' ? PROVIDER_SHORT_NAME[entity.providerId] : entity.label;
}

function hrefFor(dimension: ComparisonDimension, entity: ComparisonEntity): string {
  if (dimension === 'provider') return dashboardLink({ providerId: entity.providerId });
  return dimension === 'account' ? dashboardLink({ accountId: entity.id }) : dashboardLink({ serviceId: entity.id });
}

export function CompareView() {
  const { filters } = useFilters();
  const [baseline, setBaseline] = useState<BaselineKind>('previous');
  const [dimension, setDimension] = useState<ComparisonDimension>('provider');
  const state = useComparison(filters, baseline);

  const baselineName = baseline === 'previous' ? 'previous period' : 'same period last year';
  const name = (e: ComparisonEntity): string => displayName(dimension, e);
  const link = (e: ComparisonEntity): string => hrefFor(dimension, e);

  return (
    <>
      <PageHeader title="Cost comparison" description="Compare periods, providers, accounts and services. Figures use the same data and filters as the dashboard." />
      <FilterBar />

      <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 shadow-sm sm:flex-row sm:items-center">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Compare against</span>
          <SegmentedControl ariaLabel="Baseline period" options={BASELINES} value={baseline} onChange={setBaseline} />
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <span className="text-xs font-medium text-muted-foreground">Break down by</span>
          <SegmentedControl ariaLabel="Comparison dimension" options={DIMENSIONS} value={dimension} onChange={setDimension} />
        </div>
      </div>

      {state.status === 'loading' ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading comparison">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Card key={i} className="space-y-3 p-3"><Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-28" /></Card>)}</div>
          <Card className="space-y-4 p-3"><Skeleton className="h-4 w-48" /><Skeleton className="h-[260px] w-full" /></Card>
        </div>
      ) : (
        (() => {
          const c = state.data;
          const entities = entitiesFor(c, dimension);
          const tone = c.totals.diffPct === null ? undefined : c.totals.diff > 0 ? 'up' : 'down';
          return (
            <div className={cn('animate-fade-in space-y-3 transition-opacity duration-150', state.isRefreshing && 'opacity-60')} aria-busy={state.isRefreshing}>
              {!c.hasBaseline && (
                <div role="status" className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
                  <CalendarOff className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
                  <p>There is no data for the {baselineName} ({formatDateRange(c.baselineFrom, c.baselineTo)}), because history starts on 1 Jan 2024. Showing this period only. Try a shorter or more recent range.</p>
                </div>
              )}

              <section aria-label="Period summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <Tile label="This period" value={formatCompactCurrency(c.totals.current)} sub={`${formatDateRange(c.range.from, c.range.to)} · ${formatCurrency(c.totals.avgCurrent)}/day`} />
                <Tile label={baseline === 'previous' ? 'Previous period' : 'Same period last year'} value={c.hasBaseline ? formatCompactCurrency(c.totals.baseline) : '—'} sub={c.hasBaseline ? `${formatDateRange(c.baselineFrom, c.baselineTo)} · ${formatCurrency(c.totals.avgBaseline)}/day` : 'No data for that window'} />
                <Tile label="Difference" value={c.hasBaseline ? formatSignedCompactCurrency(c.totals.diff) : '—'} tone={c.hasBaseline ? tone : undefined} sub={c.hasBaseline ? `${formatSignedCompactCurrency(c.totals.avgCurrent - c.totals.avgBaseline)} per day` : undefined} />
                <Tile label="Change" value={c.totals.diffPct === null ? '—' : formatSignedPercent(c.totals.diffPct)} tone={tone} sub={c.totals.diffPct === null ? undefined : c.totals.diff > 0 ? 'spend is higher' : c.totals.diff < 0 ? 'spend is lower' : 'no change'} />
              </section>

              <Card>
                <CardHeader>
                  <CardTitle>Daily spend: this period vs {baselineName}</CardTitle>
                  <CardDescription>Day-by-day overlay, aligned by day number</CardDescription>
                </CardHeader>
                <CardContent><PeriodOverlayChart points={c.points} hasBaseline={c.hasBaseline} baselineLabel={baselineName} /></CardContent>
              </Card>

              <div className="grid gap-3 xl:grid-cols-5">
                <Card className="xl:col-span-2">
                  <CardHeader>
                    <CardTitle>By {dimension}</CardTitle>
                    <CardDescription>Top {Math.min(8, entities.length)} by spend, this period beside the baseline</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {entities.length === 0 ? <p className="py-10 text-center text-sm text-muted-foreground">No spend for this selection.</p> : <EntityBarsChart entities={entities} displayName={name} hasBaseline={c.hasBaseline} baselineLabel={baselineName} />}
                  </CardContent>
                </Card>
                <Card className="xl:col-span-3">
                  <CardHeader>
                    <CardTitle>{DIMENSION_LABELS[dimension]} compared</CardTitle>
                    <CardDescription>Absolute and percentage difference, and each one&apos;s share of the total change. Click a name to open it in the dashboard.</CardDescription>
                  </CardHeader>
                  <CardContent className="px-0 pb-2">
                    <ComparisonTable entities={entities} dimension={dimension} hasBaseline={c.hasBaseline} baselineLabel={baselineName} displayName={name} hrefFor={link} />
                  </CardContent>
                </Card>
              </div>

              <HeadToHead key={dimension} entities={entities} points={c.points} dimension={dimension} days={c.range.days} hasBaseline={c.hasBaseline} displayName={name} />
            </div>
          );
        })()
      )}
    </>
  );
}
