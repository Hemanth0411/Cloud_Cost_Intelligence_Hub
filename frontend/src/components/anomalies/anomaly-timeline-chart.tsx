'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AXIS_TICK, GRID_STROKE, TooltipRow, TooltipShell, type ChartTooltipProps } from '@/components/charts/chart-tooltip';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { diffDays } from '@/lib/dates';
import { formatDate } from '@/lib/format';
import type { TimelineBucket } from '@/lib/selectors/anomaly-views';
import { SEVERITY_LABEL } from '@/lib/theme';
import type { Severity } from '@/types/domain';

const SEVERITY_COLOR: Record<Severity, string> = {
  critical: 'hsl(var(--destructive))',
  high: 'hsl(var(--warning))',
  medium: 'hsl(var(--primary))',
  low: 'hsl(var(--muted-foreground))',
};
const STACK_ORDER: readonly Severity[] = ['low', 'medium', 'high', 'critical'];

function TimelineTooltip({ active, payload }: ChartTooltipProps) {
  const first = payload?.[0];
  if (!active || !first) return null;
  const b = first.payload as TimelineBucket;
  const title = b.start === b.end ? formatDate(b.start, 'long') : `${formatDate(b.start, 'short')} – ${formatDate(b.end, 'short')}`;
  return (
    <TooltipShell title={title}>
      {[...STACK_ORDER].reverse().map((s) => (
        <TooltipRow key={s} color={SEVERITY_COLOR[s]} label={SEVERITY_LABEL[s]} value={String(b[s])} />
      ))}
      <div className="mt-1 border-t pt-1"><TooltipRow label="Total" value={String(b.total)} bold /></div>
    </TooltipShell>
  );
}

export function AnomalyTimelineChart({ buckets }: { buckets: TimelineBucket[] }) {
  const interval = Math.max(0, Math.ceil(buckets.length / 8) - 1);
  const first = buckets[0];
  const span = first ? diffDays(first.end, first.start) : 0;
  const unit = span === 0 ? 'day' : span >= 27 ? 'month' : 'week';
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Anomalies over time</CardTitle>
        <CardDescription>Detections per {unit}, by severity</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[240px] w-full" role="img" aria-label="Stacked bar chart of anomalies detected over time by severity">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={buckets} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={GRID_STROKE} strokeDasharray="3 4" />
              <XAxis dataKey="start" tick={AXIS_TICK} tickLine={false} axisLine={false} interval={interval} minTickGap={12} tickFormatter={(v: string) => formatDate(v, 'short')} />
              <YAxis allowDecimals={false} tick={AXIS_TICK} tickLine={false} axisLine={false} width={34} />
              <Tooltip content={<TimelineTooltip />} cursor={{ fill: 'hsl(var(--muted) / 0.6)' }} />
              {STACK_ORDER.map((s) => (
                <Bar key={s} dataKey={s} stackId="sev" fill={SEVERITY_COLOR[s]} maxBarSize={36} animationDuration={450} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {[...STACK_ORDER].reverse().map((s) => (
            <span key={s} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: SEVERITY_COLOR[s] }} aria-hidden />{SEVERITY_LABEL[s]}</span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
