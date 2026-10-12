'use client';

import { useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AXIS_TICK, GRID_STROKE, TooltipRow, TooltipShell, type ChartTooltipProps } from '@/components/charts/chart-tooltip';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { formatCompactCurrency, formatCurrency, formatDate, formatPercent, formatSignedPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ComparisonDimension, ComparisonEntity, ComparisonPoint } from '@/types/analytics';

const COLOR_A = 'hsl(var(--primary))';
const COLOR_B = 'hsl(var(--bronze))';

interface Row {
  date: string;
  a: number;
  b: number;
}

function PairTooltip({ active, payload, nameA, nameB }: ChartTooltipProps & { nameA: string; nameB: string }) {
  const first = payload?.[0];
  if (!active || !first) return null;
  const r = first.payload as Row;
  return (
    <TooltipShell title={formatDate(r.date, 'long')}>
      <TooltipRow color={COLOR_A} label={nameA} value={formatCurrency(r.a)} />
      <TooltipRow color={COLOR_B} label={nameB} value={formatCurrency(r.b)} />
      <div className="mt-1 border-t pt-1"><TooltipRow label="A − B" value={`${r.a - r.b >= 0 ? '+' : '−'}${formatCurrency(Math.abs(r.a - r.b))}`} bold /></div>
    </TooltipShell>
  );
}

function Side({ entity, name, color, days, hasBaseline, childLabel }: { entity: ComparisonEntity; name: string; color: string; days: number; hasBaseline: boolean; childLabel: string }) {
  return (
    <div className="rounded-lg border p-4" style={{ borderTopColor: color, borderTopWidth: 3 }}>
      <p className="truncate text-sm font-semibold">{name}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{formatCompactCurrency(entity.current)}</p>
      <dl className="mt-3 space-y-1.5 text-xs">
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Average per day</dt><dd className="font-medium tabular-nums">{formatCurrency(entity.current / days)}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Share of total</dt><dd className="font-medium tabular-nums">{formatPercent(entity.sharePct)}</dd></div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">vs baseline</dt>
          <dd className={cn('font-medium tabular-nums', !hasBaseline || entity.diffPct === null ? '' : entity.diff > 0 ? 'text-destructive' : 'text-success')}>
            {!hasBaseline ? '–' : entity.diffPct === null ? 'new' : formatSignedPercent(entity.diffPct)}
          </dd>
        </div>
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{childLabel}</dt><dd className="truncate font-medium">{entity.topChild?.label ?? 'n/a'}</dd></div>
      </dl>
    </div>
  );
}

interface HeadToHeadProps {
  entities: ComparisonEntity[];
  points: ComparisonPoint[];
  dimension: ComparisonDimension;
  days: number;
  hasBaseline: boolean;
  displayName: (entity: ComparisonEntity) => string;
}

/** Pick any two providers, accounts or services and compare them directly over the selected period. */
export function HeadToHead({ entities, points, dimension, days, hasBaseline, displayName }: HeadToHeadProps) {
  const [idA, setIdA] = useState<string | null>(null);
  const [idB, setIdB] = useState<string | null>(null);

  const a = entities.find((e) => e.id === idA) ?? entities[0];
  const b = entities.find((e) => e.id === idB && e.id !== a?.id) ?? entities.find((e) => e.id !== a?.id);
  const childLabel = dimension === 'service' ? 'Top account' : 'Top service';

  if (!a || !b) {
    return (
      <Card>
        <CardHeader><CardTitle>Head to head</CardTitle><CardDescription>Compare any two {dimension}s directly</CardDescription></CardHeader>
        <CardContent><p className="py-8 text-center text-sm text-muted-foreground">At least two {dimension}s with spend are needed for a head-to-head comparison.</p></CardContent>
      </Card>
    );
  }

  const rows: Row[] = points.map((p, i) => ({ date: p.currentDate, a: a.dailyCurrent[i] ?? 0, b: b.dailyCurrent[i] ?? 0 }));
  const diff = a.current - b.current;
  const diffPct = b.current > 0 ? (diff / b.current) * 100 : null;
  const interval = Math.max(0, Math.ceil(rows.length / 8) - 1);
  const nameA = displayName(a);
  const nameB = displayName(b);

  return (
    <Card>
      <CardHeader className="gap-3">
        <div>
          <CardTitle>Head to head</CardTitle>
          <CardDescription>Compare any two {dimension}s directly over the selected period</CardDescription>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label htmlFor="h2h-a" className="sr-only">First {dimension}</label>
          <Select id="h2h-a" className="sm:w-60" value={a.id} onChange={(e) => setIdA(e.target.value)}>
            {entities.map((e) => <option key={e.id} value={e.id} disabled={e.id === b.id}>{displayName(e)}</option>)}
          </Select>
          <span className="text-xs font-semibold text-muted-foreground" aria-hidden>vs</span>
          <label htmlFor="h2h-b" className="sr-only">Second {dimension}</label>
          <Select id="h2h-b" className="sm:w-60" value={b.id} onChange={(e) => setIdB(e.target.value)}>
            {entities.map((e) => <option key={e.id} value={e.id} disabled={e.id === a.id}>{displayName(e)}</option>)}
          </Select>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-4 md:grid-cols-[1fr_auto_1fr]">
          <Side entity={a} name={nameA} color={COLOR_A} days={days} hasBaseline={hasBaseline} childLabel={childLabel} />
          <div className="flex flex-col items-center justify-center gap-1 rounded-lg bg-muted/40 px-3 py-2.5 text-center">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">A − B</p>
            <p className="text-xl font-semibold tabular-nums">{diff >= 0 ? '+' : '−'}{formatCompactCurrency(Math.abs(diff))}</p>
            <p className="text-xs tabular-nums text-muted-foreground">{diffPct === null ? 'n/a' : `${formatSignedPercent(diffPct)} vs B`}</p>
            <p className="mt-1 max-w-[9rem] text-[11px] leading-snug text-muted-foreground">
              {diff === 0 ? 'Equal spend' : `${diff > 0 ? nameA : nameB} spent more`}
            </p>
          </div>
          <Side entity={b} name={nameB} color={COLOR_B} days={days} hasBaseline={hasBaseline} childLabel={childLabel} />
        </div>

        <div className="h-[240px] w-full" role="img" aria-label={`Daily spend of ${nameA} compared with ${nameB}`}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={GRID_STROKE} strokeDasharray="3 4" />
              <XAxis dataKey="date" tick={AXIS_TICK} tickLine={false} axisLine={false} interval={interval} minTickGap={16} tickFormatter={(v: string) => formatDate(v, 'short')} />
              <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={52} tickFormatter={(v: number) => formatCompactCurrency(v)} />
              <Tooltip content={<PairTooltip nameA={nameA} nameB={nameB} />} cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeDasharray: '3 3' }} />
              <Line type="monotone" dataKey="a" stroke={COLOR_A} strokeWidth={2} dot={false} animationDuration={450} />
              <Line type="monotone" dataKey="b" stroke={COLOR_B} strokeWidth={2} dot={false} animationDuration={450} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="h-0.5 w-5 rounded" style={{ backgroundColor: COLOR_A }} aria-hidden /> {nameA}</span>
          <span className="flex items-center gap-1.5"><span className="h-0.5 w-5 rounded" style={{ backgroundColor: COLOR_B }} aria-hidden /> {nameB}</span>
        </div>
      </CardContent>
    </Card>
  );
}
