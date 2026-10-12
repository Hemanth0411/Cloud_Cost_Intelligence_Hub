'use client';

import { CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AXIS_TICK, GRID_STROKE, TooltipRow, TooltipShell, type ChartTooltipProps } from '@/components/charts/chart-tooltip';
import { formatCompactCurrency, formatCurrency, formatDate } from '@/lib/format';
import type { AnomalyContext } from '@/lib/selectors/anomaly-context';
import { isIncrease } from '@/lib/selectors/detect-anomalies';
import type { AnomalyView } from '@/types/analytics';

function ContextTooltip({ active, payload, label }: ChartTooltipProps) {
  const first = payload?.[0];
  if (!active || !first || label === undefined) return null;
  return (
    <TooltipShell title={formatDate(String(label), 'long')}>
      <TooltipRow color="hsl(var(--primary))" label="Daily cost" value={formatCurrency(typeof first.value === 'number' ? first.value : 0)} bold />
    </TooltipShell>
  );
}

/** Daily cost around the detection date, with the expected level and the detection window highlighted. */
export function AnomalyContextChart({ anomaly, context }: { anomaly: AnomalyView; context: AnomalyContext }) {
  const accent = isIncrease(anomaly.kind) ? 'hsl(var(--destructive))' : 'hsl(var(--primary))';
  const detectionPoint = context.points.find((p) => p.date === anomaly.date);
  const interval = Math.max(0, Math.ceil(context.points.length / 7) - 1);

  return (
    <div className="h-[230px] w-full" role="img" aria-label={`Daily cost of ${anomaly.serviceName} around ${anomaly.date}, with the expected level marked`}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={context.points} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID_STROKE} strokeDasharray="3 4" />
          <XAxis dataKey="date" tick={AXIS_TICK} tickLine={false} axisLine={false} interval={interval} minTickGap={14} tickFormatter={(v: string) => formatDate(v, 'short')} />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={52} tickFormatter={(v: number) => formatCompactCurrency(v)} />
          <Tooltip content={<ContextTooltip />} cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeDasharray: '3 3' }} />
          <ReferenceArea x1={context.windowStart} x2={anomaly.date} fill={accent} fillOpacity={0.12} strokeOpacity={0} />
          <ReferenceLine y={anomaly.expectedCost} stroke="hsl(var(--muted-foreground))" strokeDasharray="5 4" label={{ value: 'Expected', position: 'insideTopLeft', fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} />
          <Line type="monotone" dataKey="cost" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} animationDuration={450} />
          {detectionPoint && <ReferenceDot x={anomaly.date} y={detectionPoint.cost} r={6} fill={accent} stroke="hsl(var(--card))" strokeWidth={2} isFront />}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
