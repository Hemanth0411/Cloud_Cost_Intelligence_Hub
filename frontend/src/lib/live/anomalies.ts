/**
 * Anomaly findings, live.
 *
 * THE SERVER ALREADY DETECTS. `costhub/anomaly/mad.py` runs a rolling
 * median + MAD pass per account x service, classifies step / spike /
 * creep, groups consecutive flagged days into one finding and persists
 * the result with its evidence. The client-side detector in
 * `lib/selectors/detect-anomalies.ts` does the same job over the mock
 * dataset and must NOT also run here -- two detectors disagreeing
 * about the same estate is worse than either alone.
 *
 * WHAT COMES BACK IS NARROWER THAN THE MOCK'S ANOMALY, in three ways
 * that are visible on screen:
 *
 *  1. RISES ONLY. `_flag_days` skips `delta <= 0`, so there is no such
 *     thing as a live 'drop' or 'sustained-decrease'. The type filter
 *     on /anomalies must not offer counts for kinds that cannot occur.
 *  2. NO WINDOW LENGTH. The grouped run is collapsed to its first day
 *     and only `detected_for_date` is stored, so `windowDays` -- and
 *     therefore `impactCost` -- are unknowable. They are null, not 1.
 *  3. NO SEVERITY. The table has `score` (a modified z) but no
 *     severity column. Severity is assigned HERE, by the same
 *     `severityFor` thresholds the mock uses, applied to the real
 *     `delta_pct` and `delta_abs`. That is a presentation bucket
 *     computed from real figures, not a fabricated measurement -- but
 *     it is the client's opinion, which is why the detection-settings
 *     dialog (which claims to change DETECTION) is hidden in live mode.
 */
import { ackFinding, fetchFindings, type FindingRow } from '@/lib/api/cost-api';
import { isProviderId } from '@/lib/live/options';
import { severityFor } from '@/lib/selectors/detect-anomalies';
import type { AnomalyView, ResolvedRange, StatusOverrides } from '@/types/analytics';
import type { AnomalyConfig, AnomalyKind, AnomalyStatus, Severity, SeverityThresholds } from '@/types/domain';

/** `anomaly_findings.kind` is CHECKed to these three. */
function toKind(kind: string): AnomalyKind {
  if (kind === 'spike') return 'spike';
  if (kind === 'creep') return 'creep';
  // 'step' and anything a future detector adds: a sustained rise is
  // the safe reading, because the detector only ever flags rises.
  return 'sustained-increase';
}

function toStatus(status: FindingRow['status']): AnomalyStatus {
  if (status === 'acknowledged') return 'acknowledged';
  if (status === 'dismissed') return 'dismissed';
  return 'open';
}

/**
 * Severity from the figures we do have.
 *
 * `severityFor` wants a percent and an impact. The percent is null
 * whenever the baseline was zero, and in that case the absolute
 * change is the only evidence there is -- so the percent side of the
 * test is skipped rather than passed a zero that would quietly
 * downgrade the finding to 'low'.
 */
function severityOf(row: FindingRow, thresholds: SeverityThresholds): Severity {
  const impact = Math.abs(row.deltaAbs);
  if (row.deltaPct === null) {
    if (impact >= thresholds.criticalImpact) return 'critical';
    if (impact >= thresholds.highImpact) return 'high';
    if (impact >= thresholds.mediumImpact) return 'medium';
    return 'low';
  }
  return severityFor(row.deltaPct, impact, thresholds);
}

export interface LiveAnomalyContext {
  accountNameById: ReadonlyMap<string, string>;
  thresholds: SeverityThresholds;
}

export function toAnomalyView(row: FindingRow, ctx: LiveAnomalyContext): AnomalyView | null {
  if (!isProviderId(row.provider)) return null;
  return {
    id: row.id,
    kind: toKind(row.kind),
    date: row.detectedForDate,
    providerId: row.provider,
    accountId: row.accountId,
    // The service dimension is keyed by name throughout live mode.
    serviceId: row.serviceName,
    observedCost: row.observedValue,
    expectedCost: row.baselineValue,
    differenceCost: row.deltaAbs,
    changePct: row.deltaPct,
    windowDays: null,
    impactCost: null,
    severity: severityOf(row, ctx.thresholds),
    status: toStatus(row.status),
    accountName: ctx.accountNameById.get(row.accountId) ?? row.accountId,
    serviceName: row.serviceName,
  };
}

/**
 * Every finding the caller may see, in all three statuses.
 *
 * `GET /anomalies` takes one status at a time and defaults to 'new',
 * so a single call would hide everything the user has already acted
 * on -- and the screens show acknowledged and dismissed rows as part
 * of the workflow. Three calls in parallel is the whole cost.
 */
export async function loadLiveAnomalies(
  ctx: LiveAnomalyContext,
): Promise<{ anomalies: AnomalyView[]; asOf: string | null }> {
  const results = await Promise.all(
    (['new', 'acknowledged', 'dismissed'] as const).map((status) =>
      fetchFindings({ status, limit: 200 }),
    ),
  );
  const anomalies = results
    .flatMap((r) => r.data)
    .flatMap((row) => {
      const view = toAnomalyView(row, ctx);
      return view ? [view] : [];
    })
    .sort((a, b) => (a.date === b.date ? Math.abs(b.differenceCost) - Math.abs(a.differenceCost) : a.date < b.date ? 1 : -1));

  return { anomalies, asOf: results.find((r) => r.asOf)?.asOf ?? null };
}

/**
 * Narrow to the filters and date range, and apply pending local status
 * changes.
 *
 * Mirrors `getAnomalyViews` for the mock path. Local overrides still
 * matter in live mode: `POST /anomalies/{id}/ack` succeeds before the
 * list is refetched, and the row should move immediately.
 */
export function scopeLiveAnomalies(
  anomalies: readonly AnomalyView[],
  filters: { providerId: string; accountId: string; serviceId: string },
  range: Pick<ResolvedRange, 'from' | 'to'>,
  overrides: StatusOverrides = {},
): AnomalyView[] {
  return anomalies
    .filter(
      (a) =>
        (filters.providerId === 'all' || a.providerId === filters.providerId) &&
        (filters.accountId === 'all' || a.accountId === filters.accountId) &&
        (filters.serviceId === 'all' || a.serviceId === filters.serviceId) &&
        a.date >= range.from &&
        a.date <= range.to,
    )
    .map((a) => ({ ...a, status: overrides[a.id] ?? a.status }));
}

/**
 * The only two transitions the API has.
 *
 * `anomaly_findings.status` is CHECKed to new / acknowledged /
 * dismissed. The mock workflow also offers "investigating" and
 * "resolved", and sending either would be a 422 -- so live mode
 * offers neither, rather than offering a button that fails.
 */
export function liveStatusWrite(status: AnomalyStatus): 'acknowledged' | 'dismissed' | null {
  if (status === 'acknowledged') return 'acknowledged';
  if (status === 'dismissed') return 'dismissed';
  return null;
}

export async function writeLiveAnomalyStatus(id: string, status: AnomalyStatus): Promise<void> {
  const wire = liveStatusWrite(status);
  if (!wire) throw new Error(`The API has no "${status}" state for a finding.`);
  await ackFinding(id, wire);
}

/** Thresholds only: the rest of `AnomalyConfig` configures a detector that does not run here. */
export const thresholdsOf = (config: AnomalyConfig): SeverityThresholds => config.severity;
