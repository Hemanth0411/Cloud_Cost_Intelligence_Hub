'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AXIS_TICK, GRID_STROKE, TooltipRow, TooltipShell, type ChartTooltipProps } from '@/components/charts/chart-tooltip';
import { formatCompactCurrency, formatCurrency, formatSignedCompactCurrency, formatSignedPercent } from '@/lib/format';
import type { ComparisonEntity } from '@/types/analytics';

interface Row {
  name: string;
  current: number;
  baseline: number;
  diff: number;
  diffPct: number | null;
}

function BarsTooltip({ active, payload, baselineLabel }: ChartTooltipProps & { baselineLabel: string }) {
  const first = payload?.[0];
  if (!active || !first) return null;
  const r = first.payload as Row;
  return (
    <TooltipShell title={r.name}>
      <TooltipRow color="hsl(var(--primary))" label="This period" value={formatCurrency(r.current)} bold />
      <TooltipRow color="hsl(var(--muted-foreground))" label={baselineLabel} value={formatCurrency(r.baseline)} />
      <div className="mt-1 border-t pt-1">
        <TooltipRow label="Difference" value={`${formatSignedCompactCurrency(r.diff)}${r.diffPct === null ? '' : ` (${formatSignedPercent(r.diffPct)})`}`} />
      </div>
    </TooltipShell>
  );
}

interface EntityBarsChartProps {
  entities: ComparisonEntity[];
  displayName: (entity: ComparisonEntity) => string;
  hasBaseline: boolean;
  baselineLabel: string;
}

/** Grouped horizontal bars: this period beside the baseline for the biggest entities. */
export function EntityBarsChart({ entities, displayName, hasBaseline, baselineLabel }: EntityBarsChartProps) {
  const rows: Row[] = entities.slice(0, 8).map((e) => ({ name: displayName(e), current: e.current, baseline: e.baseline, diff: e.diff, diffPct: e.diffPct }));
  const height = Math.max(240, rows.length * (hasBaseline ? 54 : 38) + 24);
  return (
    <div>
      <div style={{ height }} className="w-full" role="img" aria-label="Grouped bar chart comparing spend this period with the baseline">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }} barCategoryGap={12} barGap={2}>
            <CartesianGrid horizontal={false} stroke={GRID_STROKE} strokeDasharray="3 4" />
            <XAxis type="number" tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={(v: number) => formatCompactCurrency(v)} />
            <YAxis type="category" dataKey="name" width={116} tick={AXIS_TICK} tickLine={false} axisLine={false} />
            <Tooltip content={<BarsTooltip baselineLabel={baselineLabel} />} cursor={{ fill: 'hsl(var(--muted) / 0.6)' }} />
            <Bar dataKey="current" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} animationDuration={450} />
            {hasBaseline && <Bar dataKey="baseline" fill="hsl(var(--muted-foreground))" fillOpacity={0.45} radius={[0, 4, 4, 0]} animationDuration={450} />}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-primary" aria-hidden /> This period</span>
        {hasBaseline && <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-muted-foreground/45" aria-hidden /> {baselineLabel}</span>}
      </div>
    </div>
  );
}
