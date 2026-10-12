'use client';

import { useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control';
import { formatBucketLabel, formatBucketRange, formatCompactCurrency, formatCurrency } from '@/lib/format';
import { isActive } from '@/lib/selectors/anomaly-views';
import { PROVIDER_COLOR, PROVIDER_ORDER, PROVIDER_SHORT_NAME } from '@/lib/theme';
import { cn } from '@/lib/utils';
import type { AnomalyView, Granularity, TrendPoint } from '@/types/analytics';
import type { ProviderId } from '@/types/domain';
import { AXIS_TICK, GRID_STROKE, TooltipRow, TooltipShell, type ChartTooltipProps } from './chart-tooltip';

const GRANULARITIES: ReadonlyArray<SegmentedOption<Granularity>> = [
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
  { value: 'year', label: 'Yearly' },
];

interface TrendTooltipProps extends ChartTooltipProps {
  granularity: Granularity;
}

function TrendTooltip({ active, payload, granularity }: TrendTooltipProps) {
  const first = payload?.[0];
  if (!active || !payload || !first) return null;
  const point = first.payload as TrendPoint;
  const rows = [...payload].reverse();
  const total = rows.reduce((acc, r) => acc + (typeof r.value === 'number' ? r.value : 0), 0);
  return (
    <TooltipShell title={formatBucketRange(point.start, point.end, granularity)}>
      {rows.map((r) => (
        <TooltipRow
          key={String(r.dataKey)}
          color={r.color}
          label={PROVIDER_SHORT_NAME[r.dataKey as ProviderId]}
          value={formatCurrency(typeof r.value === 'number' ? r.value : 0)}
        />
      ))}
      <div className="mt-1 border-t pt-1">
        <TooltipRow label="Total" value={formatCurrency(total)} bold />
      </div>
      {point.partial && <p className="pt-1 text-[11px] text-warning">Partial period, still in progress</p>}
    </TooltipShell>
  );
}

function describe(granularity: Granularity, series: TrendPoint[], rangeLabel: string): string {
  switch (granularity) {
    case 'day':
      return `Daily spend · ${rangeLabel}`;
    case 'week':
      return 'Weekly spend · last 26 weeks (Mon–Sun)';
    case 'month':
      return 'Monthly spend · last 12 months';
    default: {
      const first = series[0]?.start.slice(0, 4);
      const last = series[series.length - 1]?.start.slice(0, 4);
      return `Yearly spend · ${first} – ${last}`;
    }
  }
}

interface SpendOverTimeChartProps {
  series: Record<Granularity, TrendPoint[]>;
  anomalies: AnomalyView[];
  rangeLabel: string;
}

export function SpendOverTimeChart({ series, anomalies, rangeLabel }: SpendOverTimeChartProps) {
  const [granularity, setGranularity] = useState<Granularity>('day');
  const [hidden, setHidden] = useState<ReadonlySet<ProviderId>>(new Set());

  const points = series[granularity];
  // Providers with any spend in scope. The yearly series spans all history, so the legend stays stable.
  const present = useMemo(() => PROVIDER_ORDER.filter((id) => series.year.some((p) => p[id] > 0)), [series.year]);
  const visible = useMemo(() => present.filter((id) => !hidden.has(id)), [present, hidden]);

  function toggle(id: ProviderId): void {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (visible.length > 1) next.add(id);
      return next;
    });
  }

  const stats = useMemo(() => {
    let total = 0;
    let peak: TrendPoint | null = null;
    let peakValue = 0;
    for (const p of points) {
      const v = visible.reduce((acc, id) => acc + p[id], 0);
      total += v;
      if (v > peakValue) {
        peakValue = v;
        peak = p;
      }
    }
    return { total, peak, peakValue };
  }, [points, visible]);

  const markers = useMemo(() => {
    if (granularity !== 'day') return [];
    const byDate = new Map(points.map((p) => [p.start, p]));
    return anomalies
      .filter((a) => (a.severity === 'critical' || a.severity === 'high') && isActive(a.status))
      .flatMap((a) => {
        const point = byDate.get(a.date);
        if (!point) return [];
        const y = visible.reduce((acc, id) => acc + point[id], 0);
        return y > 0 ? [{ id: a.id, date: a.date, y }] : [];
      });
  }, [granularity, points, anomalies, visible]);

  const tickInterval = Math.max(0, Math.ceil(points.length / 8) - 1);
  const xTick = (v: string): string => formatBucketLabel(v, granularity);
  const margin = { top: 12, right: 8, left: 0, bottom: 0 };

  const xAxis = (
    <XAxis dataKey="start" tick={AXIS_TICK} tickLine={false} axisLine={false} interval={tickInterval} tickFormatter={xTick} minTickGap={16} />
  );
  const yAxis = <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={52} tickFormatter={(v: number) => formatCompactCurrency(v)} />;
  const grid = <CartesianGrid vertical={false} stroke={GRID_STROKE} strokeDasharray="3 4" />;
  const tooltip = <TrendTooltip granularity={granularity} />;

  return (
    <Card className="h-full">
      <CardHeader className="gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle>Spending over time</CardTitle>
            <CardDescription>{describe(granularity, points, rangeLabel)}</CardDescription>
          </div>
          <SegmentedControl ariaLabel="Chart granularity" options={GRANULARITIES} value={granularity} onChange={setGranularity} />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Toggle providers">
            {present.map((id) => {
              const off = hidden.has(id);
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={!off}
                  onClick={() => toggle(id)}
                  className={cn('flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-opacity', off && 'opacity-40')}
                >
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: PROVIDER_COLOR[id] }} aria-hidden />
                  {PROVIDER_SHORT_NAME[id]}
                </button>
              );
            })}
            {markers.length > 0 && (
              <span className="ml-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="h-2.5 w-2.5 rounded-full border-2 border-card bg-destructive" aria-hidden />
                Open anomaly
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground tabular-nums">
            Total <span className="font-semibold text-foreground">{formatCompactCurrency(stats.total)}</span>
            {stats.peak && (
              <>
                {' '}· Peak <span className="font-semibold text-foreground">{formatCompactCurrency(stats.peakValue)}</span>{' '}
                ({formatBucketLabel(stats.peak.start, granularity)})
              </>
            )}
          </p>
        </div>
      </CardHeader>

      <CardContent>
        <div className="h-[320px] w-full" role="img" aria-label={`${granularity} spending chart by cloud provider`}>
          <ResponsiveContainer width="100%" height="100%">
            {granularity === 'day' ? (
              <AreaChart data={points} margin={margin}>
                <defs>
                  {PROVIDER_ORDER.map((id) => (
                    <linearGradient key={id} id={`trend-fill-${id}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={PROVIDER_COLOR[id]} stopOpacity={0.5} />
                      <stop offset="100%" stopColor={PROVIDER_COLOR[id]} stopOpacity={0.08} />
                    </linearGradient>
                  ))}
                </defs>
                {grid}
                {xAxis}
                {yAxis}
                <Tooltip content={tooltip} cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeDasharray: '3 3' }} />
                {visible.map((id) => (
                  <Area key={id} type="monotone" dataKey={id} stackId="cost" stroke={PROVIDER_COLOR[id]} strokeWidth={1.75} fill={`url(#trend-fill-${id})`} animationDuration={450} />
                ))}
                {markers.map((m) => (
                  <ReferenceDot key={m.id} x={m.date} y={m.y} r={5} fill="hsl(var(--destructive))" stroke="hsl(var(--card))" strokeWidth={2} isFront />
                ))}
              </AreaChart>
            ) : (
              <BarChart data={points} margin={margin} barCategoryGap={granularity === 'year' ? '35%' : '18%'}>
                {grid}
                {xAxis}
                {yAxis}
                <Tooltip content={tooltip} cursor={{ fill: 'hsl(var(--muted) / 0.6)' }} />
                {visible.map((id) => (
                  <Bar key={id} dataKey={id} stackId="cost" fill={PROVIDER_COLOR[id]} maxBarSize={64} animationDuration={450} />
                ))}
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
        {points.some((p) => p.partial) && granularity !== 'day' && (
          <p className="mt-2 text-xs text-muted-foreground">The latest period is still in progress, so it reflects partial data.</p>
        )}
      </CardContent>
    </Card>
  );
}
