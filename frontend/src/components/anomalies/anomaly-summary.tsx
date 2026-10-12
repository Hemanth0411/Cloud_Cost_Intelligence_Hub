import { Activity, AlertTriangle, ArrowDownRight, DollarSign, Radar } from 'lucide-react';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { formatCompactCurrency } from '@/lib/format';
import type { AnomalySummary } from '@/lib/selectors/anomaly-views';

export function AnomalySummaryCards({ summary, totalAllTime }: { summary: AnomalySummary; totalAllTime: number }) {
  const highCritical = summary.bySeverity.critical + summary.bySeverity.high;
  return (
    <section aria-label="Anomaly summary" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <KpiCard title="Detected" icon={Radar} value={String(summary.total)} hint={`in this period · ${totalAllTime} across all history`} />
      <KpiCard
        title="Active"
        icon={Activity}
        tone={summary.active > 0 ? 'warning' : 'default'}
        value={String(summary.active)}
        hint={`${summary.byStatus.open} open · ${summary.byStatus.investigating} investigating · ${summary.byStatus.acknowledged} acknowledged`}
      />
      <KpiCard title="High / critical" icon={AlertTriangle} tone={highCritical > 0 ? 'danger' : 'default'} value={String(highCritical)} hint={`${summary.bySeverity.critical} critical · ${summary.bySeverity.high} high (all statuses)`} />
      <KpiCard title="Excess spend" icon={DollarSign} tone={summary.activeIncreaseImpact > 0 ? 'danger' : 'default'} value={formatCompactCurrency(summary.activeIncreaseImpact)} hint="in active increases (inside detection windows)" />
      <KpiCard
        title="Unexpected decreases"
        icon={ArrowDownRight}
        value={String(summary.byKind.drop + summary.byKind['sustained-decrease'])}
        hint={`${formatCompactCurrency(summary.activeDecreaseImpact)} below expected in active ones`}
      />
    </section>
  );
}
