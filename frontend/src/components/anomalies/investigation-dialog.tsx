'use client';

import { CheckCheck, ExternalLink, Eye, RotateCcw, Search, XCircle, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useAnomalyStatus } from '@/components/dashboard/anomaly-status-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { formatCurrency, formatDate, formatSignedPercent } from '@/lib/format';
import { dashboardLink } from '@/lib/links';
import { workflowActions } from '@/lib/anomaly-workflow';
import { KIND_LABELS } from '@/lib/selectors/detect-anomalies';
import { investigateAnomaly } from '@/lib/services/cost-service';
import { ABSENT, ANOMALY_KIND_CLASS, ANOMALY_STATUS_CLASS, ANOMALY_STATUS_LABEL, PROVIDER_SHORT_NAME, severityClass, severityLabel } from '@/lib/theme';
import { cn } from '@/lib/utils';
import type { AnomalyView } from '@/types/analytics';
import type { AnomalyStatus } from '@/types/domain';
import { AnomalyContextChart } from './anomaly-context-chart';
import { useDetectionConfig } from './detection-config-context';

const ACTION_ICON: Record<AnomalyStatus, LucideIcon> = {
  open: RotateCcw,
  investigating: Search,
  acknowledged: Eye,
  resolved: CheckCheck,
  dismissed: XCircle,
};

const signedUsd = (v: number): string => `${v >= 0 ? '+' : '−'}${formatCurrency(Math.abs(v))}`;

function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'bad' | 'info' }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('mt-1 text-base font-semibold tabular-nums', tone === 'bad' && 'text-destructive', tone === 'info' && 'text-ateneo')}>{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function BulletList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      <ul className="space-y-2 text-sm text-muted-foreground">
        {items.map((item) => (
          <li key={item} className="flex gap-2">
            <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted-foreground" aria-hidden />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Investigate, acknowledge, resolve or dismiss an anomaly. Shows the evidence behind it:
 * the surrounding cost curve, account-level contribution, and suggested checks.
 */
export function InvestigationDialog({ anomaly, onClose }: { anomaly: AnomalyView | null; onClose: () => void }) {
  const { config } = useDetectionConfig();
  const { notes, setStatus, setNote, persists } = useAnomalyStatus();
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState(false);

  const anomalyId = anomaly?.id ?? null;
  useEffect(() => {
    setDraft(anomalyId ? notes[anomalyId] ?? '' : '');
    setSaved(false);
    // Only reset the draft when a different anomaly is opened, not on every note save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anomalyId]);

  const investigation = useMemo(() => (anomaly ? investigateAnomaly(anomaly, config) : null), [anomaly, config]);

  function saveNote(): void {
    if (!anomaly) return;
    setNote(anomaly.id, draft.trim());
    setSaved(true);
  }

  const increase = anomaly ? anomaly.differenceCost > 0 : false;
  const link = anomaly ? dashboardLink({ accountId: anomaly.accountId, serviceId: anomaly.serviceId }) : '/dashboard';

  return (
    <Dialog
      open={anomaly !== null}
      onOpenChange={(open) => !open && onClose()}
      className="sm:max-w-3xl"
      title={
        investigation?.explanation.headline ??
        (anomaly ? `${anomaly.serviceName} ${KIND_LABELS[anomaly.kind].toLowerCase()} in ${anomaly.accountName}` : 'Anomaly')
      }
      description={anomaly ? `${PROVIDER_SHORT_NAME[anomaly.providerId]} · ${anomaly.accountName} · detected ${formatDate(anomaly.date, 'long')}` : undefined}
      footer={
        anomaly && (
          <>
            <Link href={link} className="mr-auto inline-flex items-center gap-1.5 text-xs font-medium text-ateneo hover:underline">
              <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Open in dashboard
            </Link>
            {workflowActions(anomaly.status, persists).map((action) => {
              const Icon = ACTION_ICON[action.to];
              return (
                <Button key={action.to} size="sm" variant={action.intent === 'primary' ? 'default' : action.intent === 'secondary' ? 'outline' : 'ghost'} onClick={() => setStatus(anomaly.id, action.to)}>
                  <Icon className="h-3.5 w-3.5" aria-hidden /> {action.label}
                </Button>
              );
            })}
          </>
        )
      }
    >
      {anomaly && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={severityClass(anomaly.severity)}>{severityLabel(anomaly.severity)} severity</Badge>
            <Badge className={ANOMALY_KIND_CLASS[anomaly.kind]}>{KIND_LABELS[anomaly.kind]}</Badge>
            <Badge className={ANOMALY_STATUS_CLASS[anomaly.status]}>{ANOMALY_STATUS_LABEL[anomaly.status]}</Badge>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Metric label={(anomaly.windowDays ?? 1) > 1 ? 'Observed (daily median)' : 'Observed cost'} value={formatCurrency(anomaly.observedCost)} />
            <Metric label="Expected cost" value={formatCurrency(anomaly.expectedCost)} sub="per day, from the baseline" />
            <Metric label="Difference" value={`${signedUsd(anomaly.differenceCost)} / day`} tone={increase ? 'bad' : 'info'} />
            <Metric
              label="Change"
              value={anomaly.changePct === null ? ABSENT : formatSignedPercent(anomaly.changePct, 0)}
              sub={anomaly.changePct === null ? 'no prior spend to compare against' : undefined}
              tone={increase ? 'bad' : 'info'}
            />
            <Metric
              label="Detection window"
              value={anomaly.windowDays === null ? ABSENT : `${anomaly.windowDays} day${anomaly.windowDays === 1 ? '' : 's'}`}
              sub={
                anomaly.windowDays === null
                  ? `not recorded - began ${formatDate(anomaly.date, 'short')}`
                  : anomaly.windowDays > 1 && investigation
                    ? `${formatDate(investigation.context.windowStart, 'short')} - ${formatDate(anomaly.date, 'short')}`
                    : formatDate(anomaly.date, 'short')
              }
            />
            <Metric
              label="Impact in window"
              value={anomaly.impactCost === null ? ABSENT : signedUsd(anomaly.impactCost)}
              sub={anomaly.impactCost === null ? 'needs a recorded window length' : undefined}
              tone={increase ? 'bad' : 'info'}
            />
          </div>

          {investigation ? (
            <>
            <div>
              <h3 className="mb-2 text-sm font-semibold">Daily cost around the detection date</h3>
              <div className="rounded-lg border p-3">
                <AnomalyContextChart anomaly={anomaly} context={investigation.context} />
                <p className="mt-1 text-xs text-muted-foreground">Dashed line: expected daily cost. Shaded area: detection window.</p>
              </div>
            </div>

            <div>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                What the data shows
                <Badge variant="outline" className="font-normal">Rule-based explanation</Badge>
              </h3>
              <div className="space-y-2.5 text-sm leading-relaxed">
                <p>{investigation.explanation.whatChanged}</p>
                {investigation.explanation.contribution && <p>{investigation.explanation.contribution}</p>}
                {investigation.explanation.concurrentNote && <p>{investigation.explanation.concurrentNote}</p>}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Generated from your cost data with deterministic templates. It describes what changed, not why; use the checks below to find the cause.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <BulletList title="What to investigate next" items={investigation.explanation.investigateNext} />
              <BulletList title="Recommended actions" items={investigation.explanation.recommendedActions} />
            </div>
            </>
          ) : (
            /* NO NARRATIVE AND NO CURVE WITHOUT THE ROWS BEHIND THEM.
               The explanation names the owning team, the service
               category; the chart plots
               forty-three daily points. The API returns one finding
               row and none of that, so the figures above stand alone
               rather than being padded out with invented context. */
            <p className="rounded-md border border-dashed bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
              These figures are the whole finding as the detector recorded it. The surrounding cost
              curve and the written explanation are built from individual daily rows and from the
              owning team, owner and service category, none of which the API returns, so they are
              not shown.
            </p>
          )}

          <div>
            <label htmlFor="anomaly-note" className="mb-2 block text-sm font-semibold">Investigation notes</label>
            <p className="mb-2 text-xs text-muted-foreground">
              Saved in this browser only. There is no column for them in the database, so they do not
              reach anyone else and do not survive clearing site data.
            </p>
            <Textarea
              id="anomaly-note"
              value={draft}
              placeholder="Record what you found: owner response, ticket link, root cause once confirmed…"
              maxLength={2000}
              onChange={(e) => {
                setDraft(e.target.value);
                setSaved(false);
              }}
            />
            <div className="mt-2 flex items-center justify-end gap-3">
              {saved && <span className="text-xs text-success" role="status">Saved</span>}
              <Button size="sm" variant="outline" onClick={saveNote} disabled={draft.trim() === (notes[anomaly.id] ?? '')}>
                Save note
              </Button>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
