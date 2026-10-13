'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useConnections } from '@/components/connections/connections-context';
import { useDetectionConfig } from '@/components/anomalies/detection-config-context';
import { useAnomalyStatus } from '@/components/dashboard/anomaly-status-context';
import { useToast } from '@/components/ui/toast';
import { transitionFor, type AlertAction } from '@/lib/alerts/actions';
import { applyPreferences, buildAlerts, isRead as isReadFn, unreadCount, type AlertSources } from '@/lib/alerts/build';
import { channelSummary } from '@/lib/alerts/preferences';
import { createSimulatedAlert, createTestAlert } from '@/lib/alerts/simulate';
import { EMPTY_ALERT_STATE, parseAlertState, type AlertState } from '@/lib/alerts/state';
import { demoNow } from '@/lib/clock';
import { markLiveAlertRead, type LiveAlerts } from '@/lib/live/alerts';
import {
  COST_CAPABILITIES,
  getAlertAnomalies,
  getBudgetSnapshot,
  getCurrentMonthKey,
  getFilterOptions,
  loadAlerts,
} from '@/lib/services/cost-service';
import type { DetectedAnomalyView } from '@/types/analytics';
import type { AlertItem, NotificationPreferences } from '@/types/domain';

const STORAGE_KEY = 'costhub:alerts';
const SYNC_TIMESTAMP = '2026-10-12T04:00:00Z';

interface AlertsContextValue {
  /** Alerts after the user's notification preferences. */
  alerts: AlertItem[];
  hiddenCount: number;
  unread: number;
  isRead: (alert: AlertItem) => boolean;
  setRead: (id: string, read: boolean) => void;
  markAllRead: () => void;
  act: (alert: AlertItem, action: AlertAction) => void;
  anomalyById: ReadonlyMap<string, DetectedAnomalyView>;
  prefs: NotificationPreferences;
  setPrefs: (prefs: NotificationPreferences) => void;
  simulateAlert: () => void;
  sendTest: () => void;
  simulatedCount: number;
  clearSimulated: () => void;
  /** Rules that produced the live feed. Empty in mock mode, where alerts are derived. */
  rules: LiveAlerts['rules'];
  /** True while the live feed is still being fetched. */
  loading: boolean;
}

const Ctx = createContext<AlertsContextValue | null>(null);

/**
 * Alerts, from whichever of the two models is in play.
 *
 * MOCK MODE -- DERIVED. Every page load recomputes them from open
 * anomalies, accounts near their budget, and connections that look
 * stale, plus any event the user simulated. Read/unread, per-alert
 * status and preferences live in localStorage.
 *
 * LIVE MODE -- STORED. `alert_rules` says what to watch and an
 * evaluator writes `alert_events`; the feed is those rows.
 *
 * THE DERIVATION IS SWITCHED OFF IN LIVE MODE, not merged with the
 * feed. Two of its three sources do not exist against the API: no
 * table stores a budget, and connection health is simulated. Left
 * running it put "Account X is projected to exceed its budget" and
 * "Account Y has not synced in 3 days" in the notification bell on
 * every page -- about real, named accounts, from numbers nothing
 * measured. `getBudgetSnapshot` and `getAlertAnomalies` return empty
 * arrays in live mode for the same reason, so this is belt and
 * braces, deliberately.
 *
 * READ STATE HAS TWO HOMES. Derived alerts have nowhere to record it
 * but the browser. Feed rows have `alert_events.status`, so marking
 * one read is a `POST` -- and must be, or it comes back unread on
 * another device.
 */
export function AlertsProvider({ children }: { children: ReactNode }) {
  const { config } = useDetectionConfig();
  const { overrides, setStatus } = useAnomalyStatus();
  const { connectionOf } = useConnections();
  const { toast } = useToast();
  const [state, setState] = useState<AlertState>(EMPTY_ALERT_STATE);
  const [live, setLive] = useState<LiveAlerts | null>(null);
  const [loading, setLoading] = useState(!COST_CAPABILITIES.simulatedAlerts);
  const derived = COST_CAPABILITIES.simulatedAlerts;

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? parseAlertState(JSON.parse(raw)) : null;
      if (parsed) setState(parsed);
    } catch {
      /* corrupt storage: start clean */
    }
  }, []);

  // One fetch on mount. The feed is not polled: an evaluator run is a
  // scheduled job, so a new event cannot appear between two clicks,
  // and a poll would be a request per minute for a table that
  // changes daily.
  useEffect(() => {
    if (derived) return;
    let cancelled = false;
    loadAlerts()
      .then((result) => !cancelled && setLive(result))
      .catch(() => {
        // Alerts are chrome on every page. A failure here must not
        // take the page with it, so the bell simply shows nothing.
        if (!cancelled) setLive(null);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [derived]);

  const update = useCallback((fn: (prev: AlertState) => AlertState) => {
    setState((prev) => {
      const next = fn(prev);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const anomalies = useMemo(() => (derived ? getAlertAnomalies(config, overrides) : []), [derived, config, overrides]);
  const anomalyById = useMemo(() => new Map(anomalies.map((a) => [a.id, a])), [anomalies]);

  const connectionSources = derived ? connectionsToSources(connectionOf) : [];
  const connectionKey = JSON.stringify(connectionSources);

  const all = useMemo(() => {
    if (!derived) return live?.items ?? [];
    const sources: AlertSources = {
      anomalies,
      budgets: getBudgetSnapshot(),
      connections: connectionSources,
      simulated: state.simulated,
      monthKey: getCurrentMonthKey(),
      syncedAt: SYNC_TIMESTAMP,
    };
    return buildAlerts(sources, state.statuses);
    // connectionSources is derived from connectionKey, so the key is the stable dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derived, live, anomalies, connectionKey, state.simulated, state.statuses]);

  const { visible, hidden } = useMemo(
    // Preferences filter DERIVED alerts only. Feed rows carry no
    // severity and no category the user chose, so a preference would
    // silently hide rows the server decided to send.
    () => (derived ? applyPreferences(all, state.prefs) : { visible: all, hidden: 0 }),
    [derived, all, state.prefs],
  );

  const isRead = useCallback(
    (alert: AlertItem): boolean =>
      // The server owns read state for feed rows; localStorage owns it
      // for derived ones.
      derived ? isReadFn(alert, state.read) : alert.status !== 'active',
    [derived, state.read],
  );

  const unread = useMemo(
    () => (derived ? unreadCount(visible, state.read) : live?.unread ?? 0),
    [derived, visible, state.read, live],
  );

  const setRead = useCallback(
    (id: string, read: boolean) => {
      if (derived) {
        update((p) => ({ ...p, read: { ...p.read, [id]: read } }));
        return;
      }
      // `POST /alerts/feed/{id}/read` only marks READ. There is no
      // endpoint to mark one unread again, so the control is not
      // offered in live mode and this guard is the backstop.
      if (!read) return;
      setLive((prev) =>
        prev === null
          ? prev
          : {
              ...prev,
              items: prev.items.map((a) => (a.id === id ? { ...a, status: 'acknowledged' } : a)),
              unread: Math.max(0, prev.unread - 1),
            },
      );
      void markLiveAlertRead(id).catch((cause: unknown) => {
        toast({
          tone: 'warning',
          title: 'Could not mark that alert read',
          description: cause instanceof Error ? cause.message : 'The API rejected the update.',
        });
      });
    },
    [derived, update, toast],
  );

  const markAllRead = useCallback(() => {
    if (derived) {
      update((p) => ({ ...p, read: { ...p.read, ...Object.fromEntries(visible.map((a) => [a.id, true])) } }));
      return;
    }
    for (const alert of visible) {
      if (alert.status === 'active') setRead(alert.id, true);
    }
  }, [derived, update, visible, setRead]);

  const act = useCallback(
    (alert: AlertItem, action: AlertAction) => {
      if (!derived) {
        // Acknowledge / resolve / reopen have no counterpart on
        // `alert_events`, whose only transition is 'read'. The row
        // does not offer the buttons; this keeps the contract if it
        // ever does.
        setRead(alert.id, true);
        return;
      }
      const t = transitionFor(alert, action);
      if (t.kind === 'anomaly') setStatus(t.anomalyId, t.to);
      else update((p) => ({ ...p, statuses: { ...p.statuses, [t.id]: t.to } }));
      if (action !== 'reopen') update((p) => ({ ...p, read: { ...p.read, [alert.id]: true } }));
    },
    [derived, setStatus, update, setRead],
  );

  const setPrefs = useCallback((prefs: NotificationPreferences) => update((p) => ({ ...p, prefs })), [update]);

  const simulateAlert = useCallback(() => {
    if (!derived) return;
    const names = getFilterOptions().accounts.map((a) => a.name);
    const sim = createSimulatedAlert(state.counter, names, demoNow());
    update((p) => ({ ...p, counter: p.counter + 1, simulated: [...p.simulated, sim] }));
    toast({ tone: 'info', title: 'Simulated alert added', description: `${channelSummary(state.prefs).join(', ')}. Delivery is simulated; nothing was sent.` });
  }, [derived, state.counter, state.prefs, update, toast]);

  const sendTest = useCallback(() => {
    if (!derived) return;
    const channels = channelSummary(state.prefs);
    const sim = createTestAlert(state.counter, channels, demoNow());
    update((p) => ({ ...p, counter: p.counter + 1, simulated: [...p.simulated, sim] }));
    toast({ tone: 'success', title: 'Test notification simulated', description: `Would be delivered via ${channels.join(', ') || 'no channels'}. Nothing was actually sent.` });
  }, [derived, state.counter, state.prefs, update, toast]);

  const clearSimulated = useCallback(() => update((p) => ({ ...p, simulated: [] })), [update]);

  const value = useMemo<AlertsContextValue>(
    () => ({
      alerts: visible,
      hiddenCount: hidden,
      unread,
      isRead,
      setRead,
      markAllRead,
      act,
      anomalyById,
      prefs: state.prefs,
      setPrefs,
      simulateAlert,
      sendTest,
      simulatedCount: state.simulated.length,
      clearSimulated,
      rules: live?.rules ?? [],
      loading,
    }),
    [visible, hidden, unread, isRead, setRead, markAllRead, act, anomalyById, state.prefs, state.simulated.length, setPrefs, simulateAlert, sendTest, clearSimulated, live, loading],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function connectionsToSources(connectionOf: (id: string) => { status: 'connected' | 'degraded' | 'disconnected'; lastSyncedAt: string; changedAt: string | null }): AlertSources['connections'] {
  return getFilterOptions().accounts.map((a) => {
    const c = connectionOf(a.id);
    return { accountId: a.id, name: a.name, providerId: a.providerId, status: c.status, lastSyncedAt: c.lastSyncedAt, changedAt: c.changedAt };
  });
}

export function useAlerts(): AlertsContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAlerts must be used within <AlertsProvider>');
  return ctx;
}
