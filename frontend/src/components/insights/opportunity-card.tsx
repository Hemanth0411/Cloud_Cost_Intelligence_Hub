import { FlaskConical } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { formatCompactCurrency } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Confidence, Effort, Opportunity } from '@/types/domain';
import { RelatedChips } from './related-chips';

const CONFIDENCE: Record<Confidence, { label: string; className: string }> = {
  high: { label: 'High confidence', className: 'bg-success/15 text-success' },
  medium: { label: 'Medium confidence', className: 'bg-warning/15 text-warning' },
  low: { label: 'Low confidence', className: 'bg-muted text-muted-foreground' },
};
const EFFORT: Record<Effort, string> = { low: 'Low effort', medium: 'Medium effort', high: 'High effort' };

export function OpportunityCard({ opportunity: o, maxSaving }: { opportunity: Opportunity; maxSaving: number }) {
  const conf = CONFIDENCE[o.confidence];
  return (
    <Card className="flex h-full flex-col">
      <div className="flex-1 space-y-4 p-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <h3 className="text-sm font-semibold leading-snug">{o.title}</h3>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className="gap-1"><FlaskConical className="h-3 w-3" aria-hidden /> Estimate</Badge>
              <Badge className={conf.className}>{conf.label}</Badge>
              <Badge variant="secondary">{EFFORT[o.effort]}</Badge>
            </div>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-xl font-semibold leading-none tabular-nums text-success">{formatCompactCurrency(o.estimatedMonthlySavings)}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">est. per month</p>
            <p className="text-[11px] tabular-nums text-muted-foreground">range {formatCompactCurrency(o.rangeLow)}–{formatCompactCurrency(o.rangeHigh)}</p>
          </div>
        </div>

        <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full rounded-full bg-success" style={{ width: `${Math.max(3, (o.estimatedMonthlySavings / Math.max(1, maxSaving)) * 100)}%` }} />
        </div>

        <p className="text-sm leading-relaxed text-muted-foreground">{o.summary}</p>

        <div className="rounded-lg border border-dashed bg-muted/30 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">How this estimate is calculated</p>
          <p className="mt-1 text-xs leading-relaxed">{o.assumption}</p>
          <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">Applied to {formatCompactCurrency(o.basisMonthlySpend)} of matching monthly spend.</p>
        </div>

        <dl className="space-y-1.5">
          {o.evidence.map((e) => (
            <div key={`${e.label}-${e.value}`} className="flex items-baseline justify-between gap-4 border-b border-dashed pb-1.5 text-xs">
              <dt className="text-muted-foreground">{e.label}</dt>
              <dd className={cn('text-right font-medium tabular-nums', /not available/i.test(e.value) && 'text-warning')}>{e.value}</dd>
            </div>
          ))}
        </dl>

        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Suggested next steps</p>
          <ul className="space-y-1.5 text-sm">
            {o.actions.map((a) => (
              <li key={a} className="flex gap-2"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-primary" aria-hidden />{a}</li>
            ))}
          </ul>
        </div>
      </div>
      <div className="border-t px-3 py-3">
        <RelatedChips accountIds={o.relatedAccountIds} serviceIds={o.relatedServiceIds} />
      </div>
    </Card>
  );
}
