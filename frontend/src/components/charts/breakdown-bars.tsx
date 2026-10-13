'use client';

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { compactServiceLabel, formatCompactCurrency, formatCurrency, formatPercent, formatSignedPercent } from '@/lib/format';
import { PROVIDER_COLOR, PROVIDER_SHORT_NAME } from '@/lib/theme';
import type { BreakdownItem } from '@/types/analytics';
import { AXIS_TICK, GRID_STROKE, TooltipRow, TooltipShell, type ChartTooltipProps } from './chart-tooltip';

function BarTooltip({ active, payload }: ChartTooltipProps) {
  const entry = payload?.[0];
  if (!active || !entry) return null;
  const item = entry.payload as BreakdownItem;
  return (
    <TooltipShell title={`${item.label} · ${PROVIDER_SHORT_NAME[item.providerId]}`}>
      <TooltipRow label="Spend" value={formatCurrency(item.cost)} bold />
      <TooltipRow label="Share of total" value={formatPercent(item.sharePct)} />
      {item.deltaPct !== null && <TooltipRow label="vs previous" value={formatSignedPercent(item.deltaPct)} />}
    </TooltipShell>
  );
}

/** Horizontal ranked bars, colored by provider. Shared by the account and service breakdowns. */
export function BreakdownBars({ data, ariaLabel }: { data: BreakdownItem[]; ariaLabel: string }) {
  const height = Math.max(220, data.length * 36 + 24);
  return (
    <div style={{ height }} className="w-full" role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }} barCategoryGap={9}>
          <CartesianGrid horizontal={false} stroke={GRID_STROKE} strokeDasharray="3 4" />
          <XAxis type="number" tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={(v: number) => formatCompactCurrency(v)} />
          {/* The category key stays the full name so ticks are unique; only the rendered tick is shortened. */}
          <YAxis type="category" dataKey="label" width={138} tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={(v: string) => compactServiceLabel(v)} />
          <Tooltip content={<BarTooltip />} cursor={{ fill: 'hsl(var(--muted) / 0.6)' }} />
          <Bar dataKey="cost" radius={[0, 5, 5, 0]} animationDuration={450}>
            {data.map((item) => (
              <Cell key={item.id} fill={PROVIDER_COLOR[item.providerId]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
