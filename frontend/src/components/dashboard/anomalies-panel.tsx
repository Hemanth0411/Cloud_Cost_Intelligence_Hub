import { CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCompactCurrency, formatCurrency, formatDate, formatSignedPercent } from '@/lib/format';
import { isIncrease, KIND_LABELS } from '@/lib/selectors/detect-anomalies';
import { ANOMALY_KIND_CLASS, ANOMALY_STATUS_CLASS, ANOMALY_STATUS_LABEL, PROVIDER_COLOR, PROVIDER_SHORT_NAME, SEVERITY_CLASS, SEVERITY_LABEL } from '@/lib/theme';
import { cn } from '@/lib/utils';
import type { AnomalyView } from '@/types/analytics';

const VISIBLE = 5;

interface AnomaliesPanelProps {
  anomalies: AnomalyView[];
  onSelect: (anomaly: AnomalyView) => void;
}

export function AnomaliesPanel({ anomalies, onSelect }: AnomaliesPanelProps) {
  const shown = anomalies.slice(0, VISIBLE);
  const hidden = anomalies.length - shown.length;

  return (
    <Card className="h-full">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle>Recent anomalies</CardTitle>
          <CardDescription>Statistically unusual daily cost in this period</CardDescription>
        </div>
        <Link href="/anomalies" className="text-xs font-medium text-primary hover:underline">
          View all
        </Link>
      </CardHeader>
      <CardContent>
        {shown.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="h-6 w-6 text-success" aria-hidden />
            No anomalies detected for this selection.
          </div>
        ) : (
          <ul className="divide-y">
            {shown.map((a) => (
              <li key={a.id}>
               <button
                type="button"
                onClick={() => onSelect(a)}
                className="-mx-2 flex w-[calc(100%+1rem)] items-start gap-3 rounded-md px-2 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
               >
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: PROVIDER_COLOR[a.providerId] }} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{a.serviceName}</p>
                    <Badge className={SEVERITY_CLASS[a.severity]}>{SEVERITY_LABEL[a.severity]}</Badge>
                    <Badge className={ANOMALY_KIND_CLASS[a.kind]}>{KIND_LABELS[a.kind]}</Badge>
                    {a.status !== 'open' && <Badge className={ANOMALY_STATUS_CLASS[a.status]}>{ANOMALY_STATUS_LABEL[a.status]}</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {PROVIDER_SHORT_NAME[a.providerId]} · {a.accountName} · {formatDate(a.date, 'short')}
                  </p>
                </div>
                <div className="text-right">
                  <p className={cn('text-sm font-semibold tabular-nums', isIncrease(a.kind) ? 'text-destructive' : 'text-primary')}>
                    {formatSignedPercent(a.changePct, 0)}
                  </p>
                  <p className="text-xs text-muted-foreground tabular-nums" title={`${formatCurrency(a.observedCost)} vs ${formatCurrency(a.expectedCost)} expected per day`}>
                    {formatCompactCurrency(a.observedCost)} vs {formatCompactCurrency(a.expectedCost)}
                  </p>
                </div>
               </button>
              </li>
            ))}
          </ul>
        )}
        {hidden > 0 && <p className="mt-3 text-center text-xs text-muted-foreground">+{hidden} more in this period</p>}
      </CardContent>
    </Card>
  );
}
