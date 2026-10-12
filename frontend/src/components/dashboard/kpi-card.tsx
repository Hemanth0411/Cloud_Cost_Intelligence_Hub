import { ArrowDownRight, ArrowUpRight, type LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Sparkline } from '@/components/charts/sparkline';
import { formatSignedPercent } from '@/lib/format';
import { cn } from '@/lib/utils';

interface KpiCardProps {
  title: string;
  value: string;
  icon: LucideIcon;
  /** Percent change. For cost metrics an increase is "bad" and shown in red. */
  deltaPct?: number | null;
  deltaLabel?: string;
  hint?: string;
  series?: number[];
  tone?: 'default' | 'warning' | 'danger' | 'success';
}

const TONE_ICON: Record<NonNullable<KpiCardProps['tone']>, string> = {
  default: 'bg-accent text-accent-foreground',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-destructive/15 text-destructive',
  success: 'bg-success/15 text-success',
};

const TONE_SPARK: Record<NonNullable<KpiCardProps['tone']>, string> = {
  default: 'hsl(var(--primary))',
  warning: 'hsl(var(--warning))',
  danger: 'hsl(var(--destructive))',
  success: 'hsl(var(--success))',
};

export function KpiCard({ title, value, icon: Icon, deltaPct, deltaLabel, hint, series, tone = 'default' }: KpiCardProps) {
  const delta = deltaPct ?? null;
  const showDelta = delta !== null && Math.abs(delta) >= 0.05;
  const isUp = delta !== null && delta > 0;

  return (
    <Card className="flex flex-col gap-3 p-4 transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <span className={cn('flex h-8 w-8 items-center justify-center rounded-md', TONE_ICON[tone])}>
          <Icon className="h-4 w-4" aria-hidden />
        </span>
      </div>

      <div>
        <p className="text-2xl font-semibold leading-none tracking-tight tabular-nums">{value}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          {delta !== null && showDelta && (
            <span
              className={cn(
                'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-medium tabular-nums',
                isUp ? 'bg-destructive/15 text-destructive' : 'bg-success/15 text-success',
              )}
            >
              {isUp ? <ArrowUpRight className="h-3 w-3" aria-hidden /> : <ArrowDownRight className="h-3 w-3" aria-hidden />}
              {formatSignedPercent(delta)}
            </span>
          )}
          {deltaLabel && <span className="text-muted-foreground">{deltaLabel}</span>}
          {hint && !deltaLabel && <span className="text-muted-foreground">{hint}</span>}
        </div>
      </div>

      {series && series.length > 1 && <Sparkline series={series} color={TONE_SPARK[tone]} />}
    </Card>
  );
}
