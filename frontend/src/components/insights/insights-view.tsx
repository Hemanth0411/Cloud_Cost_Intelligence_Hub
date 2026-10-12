'use client';

import { ChevronsDownUp, ChevronsUpDown, Download, Loader2, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useDetectionConfig } from '@/components/anomalies/detection-config-context';
import { InvestigationDialog } from '@/components/anomalies/investigation-dialog';
import { useAnomalyStatus } from '@/components/dashboard/anomaly-status-context';
import { FilterBar } from '@/components/filters/filter-bar';
import { useFilters } from '@/components/filters/filters-context';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { useInsightReport } from '@/hooks/use-insight-report';
import { downloadTextFile } from '@/lib/download';
import { insightsToCsv, savingsToCsv } from '@/lib/export';
import { formatCompactCurrency } from '@/lib/format';
import type { CostInsight, InsightKind } from '@/types/domain';
import { AiSummaryCard } from './ai-summary-card';
import { InsightCard } from './insight-card';
import { OpportunityCard } from './opportunity-card';

type Category = 'all' | 'anomaly' | 'budget' | 'change' | 'savings';

const CATEGORY_KINDS: Record<Exclude<Category, 'all'>, readonly InsightKind[]> = {
  anomaly: ['anomaly'],
  budget: ['budget'],
  change: ['change', 'trend', 'concentration'],
  savings: ['optimization'],
};

function InsightsSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      {Array.from({ length: 3 }, (_, i) => (
        <Card key={i} className="space-y-3 p-3"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-5/6" /></Card>
      ))}
    </div>
  );
}

export function InsightsView() {
  const { filters } = useFilters();
  const { config } = useDetectionConfig();
  const { overrides } = useAnomalyStatus();
  const { state, refresh } = useInsightReport(filters, overrides, config);

  const [category, setCategory] = useState<Category>('all');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [anomalyId, setAnomalyId] = useState<string | null>(null);

  const bundle = state.bundle;
  const analyzing = state.status === 'analyzing';
  const insights: CostInsight[] = bundle?.report.insights ?? [];

  const counts = useMemo(() => {
    const result: Record<Category, number> = { all: insights.length, anomaly: 0, budget: 0, change: 0, savings: 0 };
    for (const i of insights) {
      for (const [cat, kinds] of Object.entries(CATEGORY_KINDS) as Array<[Exclude<Category, 'all'>, readonly InsightKind[]]>) {
        if (kinds.includes(i.kind)) result[cat] += 1;
      }
    }
    return result;
  }, [insights]);

  const options: ReadonlyArray<SegmentedOption<Category>> = [
    { value: 'all', label: `All ${counts.all}` },
    { value: 'anomaly', label: `Anomalies ${counts.anomaly}` },
    { value: 'budget', label: `Budget ${counts.budget}` },
    { value: 'change', label: `Changes & trends ${counts.change}` },
    { value: 'savings', label: `Savings ${counts.savings}` },
  ];

  const visible = category === 'all' ? insights : insights.filter((i) => CATEGORY_KINDS[category].includes(i.kind));
  const allExpanded = visible.length > 0 && visible.every((i) => expanded.has(i.id));
  const opportunities = bundle?.data.savings ?? [];
  const maxSaving = Math.max(1, ...opportunities.map((o) => o.estimatedMonthlySavings));
  const totalMid = opportunities.reduce((a, o) => a + o.estimatedMonthlySavings, 0);
  const totalLow = opportunities.reduce((a, o) => a + o.rangeLow, 0);
  const totalHigh = opportunities.reduce((a, o) => a + o.rangeHigh, 0);
  const selectedAnomaly = bundle?.data.anomalies.find((a) => a.id === anomalyId) ?? null;

  function toggle(id: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll(): void {
    setExpanded(allExpanded ? new Set() : new Set(visible.map((i) => i.id)));
  }

  return (
    <>
      <PageHeader
        title="AI insights"
        description="Plain-English explanations and savings ideas written by deterministic rules from your cost data. No AI model is called."
        actions={
          <>
            <Button variant="outline" size="sm" disabled={!bundle || analyzing} onClick={() => bundle && downloadTextFile(`cloudlens-insights-${bundle.data.range.from}_${bundle.data.range.to}.csv`, insightsToCsv(bundle.report.insights))}>
              <Download className="h-3.5 w-3.5" aria-hidden /> Export
            </Button>
            <Button size="sm" onClick={refresh} disabled={analyzing}>
              {analyzing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
              {analyzing ? 'Analyzing…' : 'Refresh insights'}
            </Button>
          </>
        }
      />
      <FilterBar />

      <AiSummaryCard state={state} />

      <section aria-labelledby="insights-heading" className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 id="insights-heading" className="text-base font-semibold">What the data says</h2>
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl ariaLabel="Insight category" options={options} value={category} onChange={setCategory} />
            <Button variant="ghost" size="sm" onClick={toggleAll} disabled={visible.length === 0}>
              {allExpanded ? <ChevronsDownUp className="h-3.5 w-3.5" aria-hidden /> : <ChevronsUpDown className="h-3.5 w-3.5" aria-hidden />}
              {allExpanded ? 'Collapse all' : 'Expand all'}
            </Button>
          </div>
        </div>

        {analyzing && !bundle ? (
          <InsightsSkeleton />
        ) : visible.length === 0 ? (
          <Card className="p-10 text-center text-sm text-muted-foreground">No insights in this category for the current filters.</Card>
        ) : (
          <div className={analyzing ? 'space-y-4 opacity-60 transition-opacity' : 'animate-fade-in space-y-4'} aria-busy={analyzing}>
            {visible.map((insight) => (
              <InsightCard key={insight.id} insight={insight} expanded={expanded.has(insight.id)} onToggle={() => toggle(insight.id)} onViewAnomaly={setAnomalyId} />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="opps-heading" className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="opps-heading" className="text-base font-semibold">Optimization opportunities</h2>
              <Badge variant="outline">All figures are estimates</Badge>
            </div>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Each estimate applies a stated saving range to matching spend in this view, normalized to a month. They are starting points to validate, not guarantees.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {opportunities.length > 0 && (
              <div className="rounded-lg bg-success/10 px-4 py-2 text-right">
                <p className="text-lg font-semibold leading-none tabular-nums text-success">{formatCompactCurrency(totalMid)} <span className="text-xs font-normal">/ month (est.)</span></p>
                <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">range {formatCompactCurrency(totalLow)}–{formatCompactCurrency(totalHigh)}</p>
              </div>
            )}
            <Button variant="outline" size="sm" disabled={opportunities.length === 0} onClick={() => bundle && downloadTextFile(`cloudlens-opportunities-${bundle.data.range.from}_${bundle.data.range.to}.csv`, savingsToCsv(opportunities))}>
              <Download className="h-3.5 w-3.5" aria-hidden /> CSV
            </Button>
          </div>
        </div>

        {analyzing && !bundle ? (
          <InsightsSkeleton />
        ) : opportunities.length === 0 ? (
          <Card className="p-10 text-center text-sm text-muted-foreground">No optimization opportunities for the current filters.</Card>
        ) : (
          <div className={analyzing ? 'grid gap-4 opacity-60 transition-opacity lg:grid-cols-2' : 'grid animate-fade-in gap-4 lg:grid-cols-2'}>
            {opportunities.map((o) => (
              <OpportunityCard key={o.id} opportunity={o} maxSaving={maxSaving} />
            ))}
          </div>
        )}
      </section>

      <InvestigationDialog anomaly={selectedAnomaly} onClose={() => setAnomalyId(null)} />
    </>
  );
}
