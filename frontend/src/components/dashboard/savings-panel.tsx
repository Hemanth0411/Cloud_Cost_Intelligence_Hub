import { FlaskConical, PiggyBank } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCompactCurrency } from '@/lib/format';
import type { Effort, Opportunity } from '@/types/domain';

const VISIBLE = 4;

const EFFORT: Record<Effort, { label: string; className: string }> = {
  low: { label: 'Low effort', className: 'bg-success/15 text-success' },
  medium: { label: 'Medium effort', className: 'bg-warning/15 text-warning' },
  high: { label: 'High effort', className: 'bg-muted text-muted-foreground' },
};

export function SavingsPanel({ items, monthlyTotal }: { items: Opportunity[]; monthlyTotal: number }) {
  const shown = items.slice(0, VISIBLE);
  const hidden = items.length - shown.length;
  const maxSaving = Math.max(1, ...shown.map((i) => i.estimatedMonthlySavings));
  const low = items.reduce((a, i) => a + i.rangeLow, 0);
  const high = items.reduce((a, i) => a + i.rangeHigh, 0);

  return (
    <Card className="h-full">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            Savings opportunities
            <Badge variant="outline" className="gap-1 font-normal"><FlaskConical className="h-3 w-3" aria-hidden /> Estimates</Badge>
          </CardTitle>
          <CardDescription>Estimated monthly savings from this period&apos;s spend</CardDescription>
        </div>
        <Link href="/insights" className="text-xs font-medium text-ateneo hover:underline">
          Details
        </Link>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3 rounded-lg bg-success/10 px-4 py-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-success/15 text-success">
            <PiggyBank className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <p className="text-xl font-semibold leading-none tabular-nums text-success">{formatCompactCurrency(monthlyTotal)}</p>
            <p className="mt-1 text-xs text-muted-foreground tabular-nums">
              est. per month{items.length > 0 ? ` · range ${formatCompactCurrency(low)}–${formatCompactCurrency(high)}` : ''}
            </p>
          </div>
        </div>

        {shown.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No savings opportunities for this selection.</p>
        ) : (
          <ul className="space-y-3.5">
            {shown.map((item) => {
              const effort = EFFORT[item.effort];
              return (
                <li key={item.id}>
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-medium leading-snug">{item.title}</p>
                    <p className="shrink-0 text-sm font-semibold tabular-nums" title={`Estimated range ${formatCompactCurrency(item.rangeLow)}–${formatCompactCurrency(item.rangeHigh)} per month`}>
                      ~{formatCompactCurrency(item.estimatedMonthlySavings)}
                    </p>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-success" style={{ width: `${(item.estimatedMonthlySavings / maxSaving) * 100}%` }} />
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <Badge className={effort.className}>{effort.label}</Badge>
                    <span className="text-[11px] capitalize text-muted-foreground">{item.confidence} confidence</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {hidden > 0 && <p className="text-center text-xs text-muted-foreground">+{hidden} more opportunities</p>}
      </CardContent>
    </Card>
  );
}
