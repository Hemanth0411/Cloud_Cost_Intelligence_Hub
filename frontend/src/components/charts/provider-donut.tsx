'use client';

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { formatCompactCurrency, formatCurrency, formatPercent, formatSignedPercent } from '@/lib/format';
import { PROVIDER_COLOR, PROVIDER_SHORT_NAME } from '@/lib/theme';
import { cn } from '@/lib/utils';
import type { BreakdownItem } from '@/types/analytics';
import { TooltipRow, TooltipShell, type ChartTooltipProps } from './chart-tooltip';

function DonutTooltip({ active, payload }: ChartTooltipProps) {
  const entry = payload?.[0];
  if (!active || !entry) return null;
  const item = entry.payload as BreakdownItem;
  return (
    <TooltipShell title={item.label}>
      <TooltipRow label="Spend" value={formatCurrency(item.cost)} bold />
      <TooltipRow label="Share" value={formatPercent(item.sharePct)} />
    </TooltipShell>
  );
}

export function ProviderDonut({ data, total }: { data: BreakdownItem[]; total: number }) {
  return (
    <div className="grid items-center gap-4 sm:grid-cols-2">
      <div className="relative mx-auto h-[180px] w-full max-w-[200px]" role="img" aria-label="Donut chart of spend by provider">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="cost"
              nameKey="label"
              innerRadius="66%"
              outerRadius="92%"
              paddingAngle={data.length > 1 ? 3 : 0}
              stroke="none"
              cornerRadius={4}
              animationDuration={450}
            >
              {data.map((item) => (
                <Cell key={item.id} fill={PROVIDER_COLOR[item.providerId]} />
              ))}
            </Pie>
            <Tooltip content={<DonutTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[11px] text-muted-foreground">Total</span>
          <span className="text-xl font-semibold tabular-nums">{formatCompactCurrency(total)}</span>
        </div>
      </div>

      <ul className="space-y-3">
        {data.map((item) => (
          <li key={item.id} className="flex items-center gap-3 text-sm">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: PROVIDER_COLOR[item.providerId] }} aria-hidden />
            <span className="flex-1 font-medium">{PROVIDER_SHORT_NAME[item.providerId]}</span>
            <span className="tabular-nums text-muted-foreground">{formatPercent(item.sharePct)}</span>
            <span className="w-16 text-right font-medium tabular-nums">{formatCompactCurrency(item.cost)}</span>
            <span
              className={cn('w-14 text-right text-xs tabular-nums', item.deltaPct === null ? 'text-muted-foreground' : item.deltaPct > 0 ? 'text-destructive' : 'text-success')}
            >
              {item.deltaPct === null ? '–' : formatSignedPercent(item.deltaPct)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
