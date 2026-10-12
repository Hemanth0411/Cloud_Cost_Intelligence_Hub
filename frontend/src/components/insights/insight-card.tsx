'use client';

import { Activity, ChevronDown, Gauge, Layers, LineChart, PiggyBank, TrendingUp, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { CostInsight, InsightKind, InsightPriority } from '@/types/domain';
import { RelatedChips } from './related-chips';

export const KIND_META: Record<InsightKind, { label: string; icon: LucideIcon }> = {
  anomaly: { label: 'Anomaly', icon: Activity },
  budget: { label: 'Budget', icon: Gauge },
  change: { label: 'What changed', icon: TrendingUp },
  trend: { label: 'Trend', icon: LineChart },
  optimization: { label: 'Savings', icon: PiggyBank },
  concentration: { label: 'Concentration', icon: Layers },
};

const PRIORITY: Record<InsightPriority, { label: string; className: string; dot: string }> = {
  high: { label: 'High priority', className: 'bg-destructive/15 text-destructive', dot: 'bg-destructive' },
  medium: { label: 'Medium', className: 'bg-warning/15 text-warning', dot: 'bg-warning' },
  low: { label: 'Low', className: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground' },
};

interface InsightCardProps {
  insight: CostInsight;
  expanded: boolean;
  onToggle: () => void;
  onViewAnomaly: (anomalyId: string) => void;
}

export function InsightCard({ insight, expanded, onToggle, onViewAnomaly }: InsightCardProps) {
  const meta = KIND_META[insight.kind];
  const Icon = meta.icon;
  const priority = PRIORITY[insight.priority];
  const [panelId] = useState(() => `insight-${insight.id}`);

  return (
    <Card className={cn('transition-shadow', expanded && 'shadow-md')}>
      <div className="p-3">
        <div className="flex items-start gap-3">
          <span className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md', priority.className)}>
            <Icon className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold leading-snug">{insight.title}</h3>
              <Badge className={priority.className}>{priority.label}</Badge>
              <Badge variant="outline">{meta.label}</Badge>
            </div>
            <p className={cn('mt-2 text-sm leading-relaxed text-muted-foreground', !expanded && 'line-clamp-2')}>{insight.summary}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onToggle} aria-expanded={expanded} aria-controls={panelId} aria-label={expanded ? 'Collapse insight' : 'Expand insight'}>
            <ChevronDown className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')} aria-hidden />
          </Button>
        </div>
      </div>

      {expanded && (
        <div id={panelId} className="animate-fade-in space-y-3 border-t px-3 py-3">
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Supporting figures</h4>
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              {insight.evidence.map((e) => (
                <div key={`${e.label}-${e.value}`} className="flex items-baseline justify-between gap-4 border-b border-dashed pb-1.5 text-sm">
                  <dt className="text-muted-foreground">{e.label}</dt>
                  <dd className="text-right font-medium tabular-nums">{e.value}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">What to investigate next</h4>
              <ul className="space-y-1.5 text-sm">
                {insight.investigateNext.map((t) => (
                  <li key={t} className="flex gap-2"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted-foreground" aria-hidden />{t}</li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recommended actions</h4>
              <ul className="space-y-1.5 text-sm">
                {insight.recommendedActions.map((t) => (
                  <li key={t} className="flex gap-2"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-primary" aria-hidden />{t}</li>
                ))}
              </ul>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <RelatedChips accountIds={insight.relatedAccountIds} serviceIds={insight.relatedServiceIds} />
            {insight.relatedAnomalyIds[0] && (
              <Button size="sm" onClick={() => onViewAnomaly(insight.relatedAnomalyIds[0] ?? '')}>Investigate this anomaly</Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
