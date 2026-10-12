import { Activity, AlertTriangle, ArrowDownRight, DollarSign, Radar } from 'lucide-react';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { formatCompactCurrency } from '@/lib/format';
import { ABSENT } from '@/lib/theme';
import type { AnomalySummary } from '@/lib/selectors/anomaly-views';

interface Props {
  summary: AnomalySummary;
  totalAllTime: number;
  /**
   * Can the running detector emit a drop at all?
   *
   * The server's MadDetector skips `delta <= 0`, so a live
   * "Unexpected decreases: 0" is not a finding of no decreases -- it
   * is a count of something that was never looked for. The card comes
   * off rather than reporting a zero nobody measured.
   */
  decreasesPossible: boolean;
}

export function AnomalySummaryCards({ summary, totalAllTime, decreasesPossible }: Props) {
  const highCritical = summary.bySeverity.critical + summary.bySeverity.high;
  return (
    <section
      aria-label="Anomaly summary"
      className={`grid gap-3 sm:grid-cols-2 ${decreasesPossible ? 'xl:grid-cols-5' : 'xl:grid-cols-4'}`}
    >
      <KpiCard title="Detected" icon={Radar} value={String(summary.total)} hint={`in this period · ${totalAllTime} across all history`} />
      <KpiCard
        title="Active"
        icon={Activity}
        tone={summary.active > 0 ? 'warning' : 'default'}
        value={String(summary.active)}
        hint={`${summary.byStatus.open} open · ${summary.byStatus.investigating} investigating · ${summary.byStatus.acknowledged} acknowledged`}
      />
      <KpiCard title="High / critical" icon={AlertTriangle} tone={highCritical > 0 ? 'danger' : 'default'} value={String(highCritical)} hint={`${summary.bySeverity.critical} critical · ${summary.bySeverity.high} high (all statuses)`} />
      <KpiCard
        title="Excess spend"
        icon={DollarSign}
        tone={(summary.activeIncreaseImpact ?? 0) > 0 ? 'danger' : 'default'}
        value={summary.activeIncreaseImpact === null ? ABSENT : formatCompactCurrency(summary.activeIncreaseImpact)}
        hint={
          // The API's findings carry no window length, so the dollars
          // inside the window cannot be summed. Saying so beats
          // printing a total that silently omits most of the findings.
          summary.activeIncreaseImpact === null
            ? 'not available: findings carry no detection window'
            : 'in active increases (inside detection windows)'
        }
      />
      {decreasesPossible && (
      <KpiCard
        title="Unexpected decreases"
        icon={ArrowDownRight}
        value={String(summary.byKind.drop + summary.byKind['sustained-decrease'])}
        hint={
          summary.activeDecreaseImpact === null
            ? 'detection window not recorded for these findings'
            : `${formatCompactCurrency(summary.activeDecreaseImpact)} below expected in active ones`
        }
      />
      )}
    </section>
  );
}
