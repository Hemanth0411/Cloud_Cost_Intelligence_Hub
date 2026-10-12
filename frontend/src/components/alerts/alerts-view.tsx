'use client';

import { Bell, CheckCheck, CheckCircle2, Eye, FlaskConical, Trash2, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { InvestigationDialog } from '@/components/anomalies/investigation-dialog';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control';
import { SEVERITIES, channelSummary } from '@/lib/alerts/preferences';
import { useDemoNow } from '@/hooks/use-demo-now';
import { formatRelative } from '@/lib/format';
import { ALERT_CATEGORY_LABEL, SEVERITY_LABEL } from '@/lib/theme';
import type { AlertCategory, AlertItem, AlertStatus, Severity } from '@/types/domain';
import { COST_CAPABILITIES } from '@/lib/services/cost-service';
import { useAlerts } from './alerts-context';
import { AlertRow } from './alert-row';
import { NotificationPreferences } from './notification-preferences';

type StatusFilter = 'all' | 'unread' | AlertStatus;

const CATEGORIES: readonly AlertCategory[] = ['anomaly', 'budget', 'connection', 'simulated'];

export function AlertsView() {
  const { alerts, unread, isRead, setRead, markAllRead, act, anomalyById, prefs, rules, simulateAlert, simulatedCount, clearSimulated } = useAlerts();
  /**
   * DERIVED alerts (mock) vs STORED feed rows (live).
   *
   * Everything this flag hides is a control over something the
   * stored model does not have: a severity to filter on, a
   * workflow beyond "read", a delivery channel the user chooses, an
   * event they can conjure. Leaving them rendered meant a severity
   * dropdown that emptied the list whatever you picked and a
   * "Simulate incoming alert" button that silently did nothing.
   */
  const derived = COST_CAPABILITIES.simulatedAlerts;
  const [status, setStatus] = useState<StatusFilter>('all');
  const [category, setCategory] = useState<AlertCategory | 'all'>('all');
  const [severity, setSeverity] = useState<Severity | 'all'>('all');
  const [anomalyId, setAnomalyId] = useState<string | null>(null);

  const now = useDemoNow();
  const channels = channelSummary(prefs);

  const counts = useMemo(() => {
    const c = { all: alerts.length, unread, active: 0, acknowledged: 0, resolved: 0 };
    for (const a of alerts) c[a.status] += 1;
    return c;
  }, [alerts, unread]);

  const filtered = useMemo(
    () =>
      alerts.filter(
        (a) =>
          (status === 'all' || (status === 'unread' ? !isRead(a) : a.status === status)) &&
          (category === 'all' || a.category === category) &&
          (severity === 'all' || a.severity === severity),
      ),
    [alerts, status, category, severity, isRead],
  );

  const options: ReadonlyArray<SegmentedOption<StatusFilter>> = [
    { value: 'all', label: `All ${counts.all}` },
    { value: 'unread', label: `Unread ${counts.unread}` },
    { value: 'active', label: `Active ${counts.active}` },
    { value: 'acknowledged', label: `Acknowledged ${counts.acknowledged}` },
    { value: 'resolved', label: `Resolved ${counts.resolved}` },
  ];

  const selectedAnomaly = anomalyId ? anomalyById.get(anomalyId) ?? null : null;
  const activeFilters = status !== 'all' || category !== 'all' || severity !== 'all';
  const recentForLog: AlertItem[] = alerts.slice(0, 5);

  return (
    <>
      <PageHeader
        title="Alerts & notifications"
        description={
          derived
            ? 'Anomaly, budget and connection alerts. Delivery is simulated: no email or message is ever sent.'
            : 'Events written by your alert rules. Rule evaluation runs server-side; nothing here is derived in the browser.'
        }
        actions={
          <>
            {derived && (
              <Button variant="outline" size="sm" onClick={simulateAlert}>
                <FlaskConical className="h-3.5 w-3.5" aria-hidden /> Simulate incoming alert
              </Button>
            )}
            <Button size="sm" onClick={markAllRead} disabled={unread === 0}>
              <CheckCheck className="h-3.5 w-3.5" aria-hidden /> Mark all as read
            </Button>
          </>
        }
      />

      <section aria-label="Alert summary" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {/* "All caught up" is a claim about a system that is
            watching. With no rules and no evaluator run, the honest
            version is that nothing has fired. */}
        <KpiCard
          title="Unread"
          icon={Bell}
          tone={unread > 0 ? 'danger' : 'default'}
          value={String(unread)}
          hint={unread > 0 ? 'need your attention' : derived ? 'all caught up' : rules.length === 0 ? 'no rules defined' : 'nothing has fired'}
        />
        <KpiCard title="Active" icon={TriangleAlert} tone={counts.active > 0 ? 'warning' : 'default'} value={String(counts.active)} hint="not yet acknowledged" />
        <KpiCard title="Acknowledged" icon={Eye} value={String(counts.acknowledged)} hint="being looked at" />
        <KpiCard title="Resolved" icon={CheckCircle2} tone="success" value={String(counts.resolved)} hint="closed out" />
      </section>

      <div className="grid gap-3 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader className="gap-3">
            <div>
              <CardTitle>Alerts</CardTitle>
              <CardDescription>Acknowledging or resolving an anomaly alert updates the anomaly everywhere (shared workflow).</CardDescription>
            </div>
            <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
              <SegmentedControl ariaLabel="Alert status" options={options} value={status} onChange={setStatus} />
              <div className="flex gap-2 lg:ml-auto">
                <label className="sr-only" htmlFor="alert-category">Category</label>
                <Select id="alert-category" className="w-36" value={category} onChange={(e) => setCategory(e.target.value as AlertCategory | 'all')}>
                  <option value="all">All categories</option>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{ALERT_CATEGORY_LABEL[c]}</option>)}
                </Select>
                {/* `alert_events` has no severity column, so every
                    choice but "all" would return nothing. */}
                {derived && (
                  <>
                    <label className="sr-only" htmlFor="alert-severity">Severity</label>
                    <Select id="alert-severity" className="w-36" value={severity} onChange={(e) => setSeverity(e.target.value as Severity | 'all')}>
                      <option value="all">All severities</option>
                      {[...SEVERITIES].reverse().map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>)}
                    </Select>
                  </>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-sm text-muted-foreground">
                <CheckCircle2 className="h-6 w-6 text-success" aria-hidden />
                {alerts.length > 0
                  ? activeFilters
                    ? 'No alerts match these filters.'
                    : 'Nothing to show.'
                  : derived
                    ? 'No alerts right now.'
                    : 'No alert rule has fired. Nothing is evaluated until a rule exists and the evaluator runs.'}
                {activeFilters && <Button variant="outline" size="sm" onClick={() => { setStatus('all'); setCategory('all'); setSeverity('all'); }}>Clear filters</Button>}
              </div>
            ) : (
              <ul aria-label="Alert list">
                {filtered.map((a) => (
                  <AlertRow
                    key={a.id}
                    alert={a}
                    read={isRead(a)}
                    now={now}
                    channels={derived && !a.simulated ? channels : []}
                    workflow={derived}
                    onToggleRead={() => setRead(a.id, !isRead(a))}
                    onAction={(action) => act(a, action)}
                    onInvestigate={a.anomalyId && anomalyById.has(a.anomalyId) ? () => setAnomalyId(a.anomalyId) : undefined}
                  />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="space-y-3">
          {derived && <NotificationPreferences />}
          {!derived && <AlertRules rules={rules} />}
          <Card>
            <CardHeader>
              <CardTitle>{derived ? 'Delivery log (simulated)' : 'Delivery'}</CardTitle>
              <CardDescription>
                {derived
                  ? 'How the latest alerts would have been delivered. Nothing was actually sent.'
                  : 'Delivery is recorded by the server on each event. Channels come from the rule, not from a preference here.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {recentForLog.length === 0 ? (
                <p className="text-sm text-muted-foreground">No alerts yet.</p>
              ) : (
                <ul className="space-y-2.5">
                  {recentForLog.map((a) => (
                    <li key={a.id} className="text-sm">
                      <p className="truncate font-medium">{a.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {derived
                          ? `${a.simulated ? 'Simulated event · in-app only' : channels.join(' · ') || 'No channels enabled'} · `
                          : ''}
                        {formatRelative(a.timestamp, now)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              {simulatedCount > 0 && (
                <Button variant="ghost" size="sm" onClick={clearSimulated}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden /> Clear {simulatedCount} simulated event{simulatedCount === 1 ? '' : 's'}
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <InvestigationDialog anomaly={selectedAnomaly} onClose={() => setAnomalyId(null)} />
    </>
  );
}

/**
 * The rules behind the live feed.
 *
 * Without it the feed is unexplainable: an empty list could mean
 * "nothing fired" or "nothing is being watched", and those call for
 * opposite responses.
 */
function AlertRules({ rules }: { rules: ReturnType<typeof useAlerts>['rules'] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Alert rules</CardTitle>
        <CardDescription>What the server is watching. Rules are created through the API.</CardDescription>
      </CardHeader>
      <CardContent>
        {rules.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No rules exist, so nothing can fire. The feed above will stay empty until one is created.
          </p>
        ) : (
          <ul className="space-y-2.5">
            {rules.map((r) => (
              <li key={r.id} className="text-sm">
                <p className="truncate font-medium">{r.name}</p>
                <p className="text-xs text-muted-foreground">
                  {[r.type, r.metric, r.frequency, r.enabled ? 'enabled' : 'disabled'].join(' \u00b7 ')}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
