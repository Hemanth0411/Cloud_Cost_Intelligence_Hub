'use client';

import { Download, SlidersHorizontal } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAnomalyStatus } from '@/components/dashboard/anomaly-status-context';
import { Skeleton } from '@/components/ui/skeleton';
import { FilterBar } from '@/components/filters/filter-bar';
import { useFilters } from '@/components/filters/filters-context';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAnomalyData } from '@/hooks/use-anomaly-data';
import { COST_CAPABILITIES } from '@/lib/services/cost-service';
import { ErrorState } from '@/components/shared/error-state';
import { NoDataNotice } from '@/components/shared/no-data-notice';
import { downloadTextFile } from '@/lib/download';
import { anomaliesToCsv } from '@/lib/export';
import { formatDateRange } from '@/lib/format';
import { anomalyTimeline, DEFAULT_ANOMALY_FILTER, filterAnomalies, summarizeAnomalies, type AnomalyFilter } from '@/lib/selectors/anomaly-views';
import { KIND_LABELS, matchPreset, PRESET_LABELS } from '@/lib/selectors/detect-anomalies';
import { ANOMALY_KIND_CLASS } from '@/lib/theme';
import { cn } from '@/lib/utils';
import type { AnomalyView } from '@/types/analytics';
import type { AnomalyKind, AnomalyStatus } from '@/types/domain';
import { AnomalyFilters } from './anomaly-filters';
import { AnomalySummaryCards } from './anomaly-summary';
import { AnomalyTable } from './anomaly-table';
import { AnomalyTimelineChart } from './anomaly-timeline-chart';
import { useDetectionConfig } from './detection-config-context';
import { DetectionSettingsDialog } from './detection-settings-dialog';
import { InvestigationDialog } from './investigation-dialog';

const KIND_HELP: Record<AnomalyKind, string> = {
  spike: 'One day far above comparable days',
  'sustained-increase': 'Typical daily cost stepped up and stayed',
  creep: 'Still climbing rather than settled at a new level',
  drop: 'One day far below comparable days',
  'sustained-decrease': 'Typical daily cost stepped down and stayed',
};

/**
 * ONLY LIST THE KINDS THE RUNNING DETECTOR CAN EMIT.
 *
 * The client-side detector finds four; the server's finds three, and
 * two of those sets barely overlap -- it flags rises only, so a live
 * "Drop: 0" row is not a finding of no drops, it is a filter for
 * something that cannot happen. The list follows the mode rather
 * than being a fixed four.
 */
const CLIENT_KINDS: readonly AnomalyKind[] = ['spike', 'sustained-increase', 'drop', 'sustained-decrease'];
const SERVER_KINDS: readonly AnomalyKind[] = ['spike', 'sustained-increase', 'creep'];

function LoadingState() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading anomalies">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Card key={i} className="space-y-4 p-3"><Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-20" /><Skeleton className="h-4 w-full" /></Card>
        ))}
      </div>
      <div className="grid gap-3 xl:grid-cols-3">
        <Card className="space-y-4 p-3 xl:col-span-2"><Skeleton className="h-4 w-40" /><Skeleton className="h-[240px] w-full" /></Card>
        <Card className="space-y-4 p-3"><Skeleton className="h-4 w-32" /><Skeleton className="h-[240px] w-full" /></Card>
      </div>
      <Card className="space-y-3 p-3"><Skeleton className="h-4 w-40" />{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}</Card>
    </div>
  );
}

export function AnomaliesView() {
  const { filters } = useFilters();
  const { config, isDefault, reset } = useDetectionConfig();
  const { overrides, setStatus } = useAnomalyStatus();
  const state = useAnomalyData(filters, overrides, config);
  const configurable = COST_CAPABILITIES.detectionSettings;
  const kinds = configurable ? CLIENT_KINDS : SERVER_KINDS;

  const [filter, setFilter] = useState<AnomalyFilter>(DEFAULT_ANOMALY_FILTER);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const ready = state.status === 'ready' ? state : null;
  const all = ready ? ready.data.anomalies : null;
  const filtered = useMemo(() => (all ? filterAnomalies(all, filter) : []), [all, filter]);
  const summary = useMemo(() => summarizeAnomalies(all ?? []), [all]);
  const timeline = useMemo(() => (ready ? anomalyTimeline(all ?? [], ready.data.range) : []), [ready, all]);

  // Nothing found in this window AND nothing found in any window.
  // The second half matters: zero in a narrow range with findings
  // elsewhere is a real result and keeps the full summary.
  const nothingDetected = (ready?.data.anomalies.length ?? 0) === 0 && (ready?.data.totalDetectedAllTime ?? 0) === 0;

  const presetId = matchPreset(config);
  const presetLabel = presetId === 'custom' ? 'Custom' : PRESET_LABELS[presetId];
  const selected = all?.find((a) => a.id === selectedId) ?? null;

  function openAnomaly(a: AnomalyView): void {
    setSelectedId(a.id);
  }

  function setAnomalyStatus(a: AnomalyView, status: AnomalyStatus): void {
    setStatus(a.id, status);
  }

  return (
    <>
      <PageHeader
        title="Anomaly detection"
        description={
          configurable
            ? 'Rule-based detection of cost spikes, sustained increases and unexpected decreases.'
            : 'Findings from the rolling median / MAD detector that runs server-side. It flags increases only.'
        }
        actions={
          <>
            {/* HIDDEN WHEN THE DETECTOR IS NOT OURS. The dialog edits
                thresholds the server never sees, so in live mode it
                would be a settings panel that changes nothing. */}
            {configurable && (
              <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
                <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
                Detection settings
                <Badge variant={isDefault ? 'secondary' : 'default'} className="ml-1">{presetLabel}</Badge>
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={filtered.length === 0}
              onClick={() => ready && downloadTextFile(`costhub-anomalies-${ready.data.range.from}_${ready.data.range.to}.csv`, anomaliesToCsv(filtered))}
            >
              <Download className="h-3.5 w-3.5" aria-hidden /> Export CSV
            </Button>
          </>
        }
      />
      <FilterBar />

      {configurable && !isDefault && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-accent px-4 py-2.5 text-sm text-accent-foreground" role="status">
          <SlidersHorizontal className="h-4 w-4" aria-hidden />
          Using {presetLabel.toLowerCase()} detection thresholds instead of the defaults.
          <button type="button" onClick={reset} className="font-medium underline underline-offset-2">Restore defaults</button>
        </div>
      )}

      {state.status === 'loading' ? (
        <LoadingState />
      ) : state.status === 'error' ? (
        <ErrorState title="Could not load anomalies" message={state.message} onRetry={() => window.location.reload()} />
      ) : (
        <div className={cn('animate-fade-in space-y-3 transition-opacity duration-150', state.isRefreshing && 'opacity-60')} aria-busy={state.isRefreshing}>
          {/* "0 detected" is a real and good finding ONCE there is
              spend to detect over. Before that it is an absence of
              input, not an absence of anomalies -- and the five
              summary cards plus a timeline chart of empty buckets
              would assert the search happened. The notice replaces
              them; NoDataNotice decides which of the two it is from
              the data status. */}
          {nothingDetected ? (
            <NoDataNotice
              range={formatDateRange(state.data.range.from, state.data.range.to)}
              emptyTitle="No anomalies detected"
              emptyMessage="The detector found nothing unusual in this selection. That is the good outcome, not a gap."
            />
          ) : (
          <>
          <AnomalySummaryCards
            summary={summary}
            totalAllTime={state.data.totalDetectedAllTime}
            decreasesPossible={configurable}
          />

          <div className="grid gap-3 xl:grid-cols-3">
            <div className="xl:col-span-2"><AnomalyTimelineChart buckets={timeline} /></div>
            <Card className="h-full">
              <CardHeader>
                <CardTitle>By type</CardTitle>
                <CardDescription>Select a type to filter the table</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {kinds.map((k) => {
                    const active = filter.kind === k;
                    return (
                      <li key={k}>
                        <button
                          type="button"
                          aria-pressed={active}
                          onClick={() => setFilter({ ...filter, kind: active ? 'all' : k })}
                          className={cn('flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', active && 'border-primary bg-accent')}
                        >
                          <Badge className={ANOMALY_KIND_CLASS[k]}>{KIND_LABELS[k]}</Badge>
                          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{KIND_HELP[k]}</span>
                          <span className="text-lg font-semibold tabular-nums">{summary.byKind[k]}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="gap-3">
              <div>
                <CardTitle>Detected anomalies</CardTitle>
                <CardDescription>{formatDateRange(state.data.range.from, state.data.range.to)} · select a row to investigate</CardDescription>
              </div>
              <AnomalyFilters value={filter} onChange={setFilter} shown={filtered.length} total={state.data.anomalies.length} />
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <AnomalyTable anomalies={filtered} onOpen={openAnomaly} onSetStatus={setAnomalyStatus} />
            </CardContent>
          </Card>
          </>
          )}
        </div>
      )}

      <InvestigationDialog anomaly={selected} onClose={() => setSelectedId(null)} />
      <DetectionSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}
