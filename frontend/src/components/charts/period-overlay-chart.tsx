'use client';

import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatCompactCurrency, formatCurrency, formatDate, formatSignedCompactCurrency } from '@/lib/format';
import type { ComparisonPoint } from '@/types/analytics';
import { AXIS_TICK, GRID_STROKE, TooltipRow, TooltipShell, type ChartTooltipProps } from './chart-tooltip';

function OverlayTooltip({ active, payload, baselineLabel }: ChartTooltipProps & { baselineLabel: string }) {
  const first = payload?.[0];
  if (!active || !first) return null;
  const p = first.payload as ComparisonPoint;
  const diff = p.previous === null ? null : p.current - p.previous;
  return (
    <TooltipShell title={`Day ${p.index + 1}`}>
      <TooltipRow color="hsl(var(--primary))" label={formatDate(p.currentDate, 'short')} value={formatCurrency(p.current)} bold />
      {p.previous !== null && (
        <TooltipRow color="hsl(var(--muted-foreground))" label={`${formatDate(p.previousDate, 'short')} (${baselineLabel})`} value={formatCurrency(p.previous)} />
      )}
      {diff !== null && (
        <div className="mt-1 border-t pt-1">
          <TooltipRow label="Difference" value={formatSignedCompactCurrency(diff)} />
        </div>
      )}
    </TooltipShell>
  );
}

interface PeriodOverlayChartProps {
  points: ComparisonPoint[];
  hasBaseline: boolean;
  /** Short name of the baseline for tooltips and the legend, e.g. "previous period". */
  baselineLabel?: string;
  height?: number;
}

/** Daily spend this period (area) over the baseline period (dashed line). Used on the dashboard and Compare page. */
export function PeriodOverlayChart({ points, hasBaseline, baselineLabel = 'previous period', height = 260 }: PeriodOverlayChartProps) {
  const tickInterval = Math.max(0, Math.ceil(points.length / 8) - 1);
  return (
    <div>
      <div style={{ height }} className="w-full" role="img" aria-label={`Line chart comparing daily spend in this period with the ${baselineLabel}`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="overlay-current" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke={GRID_STROKE} strokeDasharray="3 4" />
            <XAxis dataKey="currentDate" tick={AXIS_TICK} tickLine={false} axisLine={false} interval={tickInterval} minTickGap={16} tickFormatter={(v: string) => formatDate(v, 'short')} />
            <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={52} tickFormatter={(v: number) => formatCompactCurrency(v)} />
            <Tooltip content={<OverlayTooltip baselineLabel={baselineLabel} />} cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeDasharray: '3 3' }} />
            <Area type="monotone" dataKey="current" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#overlay-current)" animationDuration={450} />
            {hasBaseline && <Line type="monotone" dataKey="previous" stroke="hsl(var(--muted-foreground))" strokeWidth={1.75} strokeDasharray="5 4" dot={false} animationDuration={450} />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-5 rounded bg-primary" aria-hidden /> This period</span>
        {hasBaseline && <span className="flex items-center gap-1.5"><span className="h-0 w-5 border-t-2 border-dashed border-muted-foreground" aria-hidden /> {baselineLabel.charAt(0).toUpperCase() + baselineLabel.slice(1)}</span>}
      </div>
    </div>
  );
}
