import type { ReactNode } from 'react';

export interface ChartTooltipEntry {
  name?: string | number;
  dataKey?: string | number;
  value?: number | string | Array<number | string>;
  color?: string;
  payload?: unknown;
}

export interface ChartTooltipProps {
  active?: boolean;
  payload?: ChartTooltipEntry[];
  label?: string | number;
}

interface TooltipShellProps {
  title: string;
  children: ReactNode;
}

export function TooltipShell({ title, children }: TooltipShellProps) {
  return (
    <div className="min-w-[10rem] rounded-lg border bg-card px-3 py-2.5 text-xs shadow-lg">
      <p className="mb-1.5 font-medium">{title}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

export function TooltipRow({
  color,
  label,
  value,
  bold,
}: {
  color?: string;
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {color && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} aria-hidden />}
        {label}
      </span>
      <span className={bold ? 'font-semibold tabular-nums' : 'tabular-nums'}>{value}</span>
    </div>
  );
}

export const AXIS_TICK = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' } as const;
export const GRID_STROKE = 'hsl(var(--border))';
