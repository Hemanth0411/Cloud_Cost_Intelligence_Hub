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
import { getAlertAnomalies, getBudgetSnapshot, getCurrentMonthKey, getFilterOptions } from '@/lib/services/cost-service';
import type { AnomalyView } from '@/types/analytics';
import type { AlertItem, NotificationPreferences } from '@/types/domain';

const STORAGE_KEY = 'cloudlens:alerts';
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
  anomalyById: ReadonlyMap<string, AnomalyView>;
  prefs: NotificationPreferences;
  setPrefs: (prefs: NotificationPreferences) => void;
  simulateAlert: () => void;
  sendTest: () => void;
  simulatedCount: number;
  clearSimulated: () => void;
}

const Ctx = createContext<AlertsContextValue | null>(null);

/**
 * Alerts are derived: anomalies (shared workflow), budget risk, connection health, plus demo events the
 * user simulates. Read/unread, per-alert status, preferences and simulated events persist locally.
 * Delivery is simulated, so no email or message is ever sent.
 */
export function AlertsProvider({ children }: { children: ReactNode }) {
  const { config } = useDetectionConfig();
  const { overrides, setStatus } = useAnomalyStatus();
  const { connectionOf } = useConnections();
  const { toast } = useToast();
  const [state, setState] = useState<AlertState>(EMPTY_ALERT_STATE);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? parseAlertState(JSON.parse(raw)) : null;
      if (parsed) setState(parsed);
    } catch {
      /* corrupt storage: start clean */
    }
  }, []);

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

  const anomalies = useMemo(() => getAlertAnomalies(config, overrides), [config, overrides]);
  const anomalyById = useMemo(() => new Map(anomalies.map((a) => [a.id, a])), [anomalies]);

  const connectionSources = connectionsToSources(connectionOf);
  const connectionKey = JSON.stringify(connectionSources);

  const all = useMemo(() => {
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
  }, [anomalies, connectionKey, state.simulated, state.statuses]);

  const { visible, hidden } = useMemo(() => applyPreferences(all, state.prefs), [all, state.prefs]);
  const unread = useMemo(() => unreadCount(visible, state.read), [visible, state.read]);

  const setRead = useCallback((id: string, read: boolean) => update((p) => ({ ...p, read: { ...p.read, [id]: read } })), [update]);

  const markAllRead = useCallback(() => update((p) => ({ ...p, read: { ...p.read, ...Object.fromEntries(visible.map((a) => [a.id, true])) } })), [update, visible]);

  const act = useCallback(
    (alert: AlertItem, action: AlertAction) => {
      const t = transitionFor(alert, action);
      if (t.kind === 'anomaly') setStatus(t.anomalyId, t.to);
      else update((p) => ({ ...p, statuses: { ...p.statuses, [t.id]: t.to } }));
      if (action !== 'reopen') update((p) => ({ ...p, read: { ...p.read, [alert.id]: true } }));
    },
    [setStatus, update],
  );

  const setPrefs = useCallback((prefs: NotificationPreferences) => update((p) => ({ ...p, prefs })), [update]);

  const simulateAlert = useCallback(() => {
    const names = getFilterOptions().accounts.map((a) => a.name);
    const sim = createSimulatedAlert(state.counter, names, demoNow());
    update((p) => ({ ...p, counter: p.counter + 1, simulated: [...p.simulated, sim] }));
    toast({ tone: 'info', title: 'Simulated alert added', description: `${channelSummary(state.prefs).join(', ')}. Delivery is simulated; nothing was sent.` });
  }, [state.counter, state.prefs, update, toast]);

  const sendTest = useCallback(() => {
    const channels = channelSummary(state.prefs);
    const sim = createTestAlert(state.counter, channels, demoNow());
    update((p) => ({ ...p, counter: p.counter + 1, simulated: [...p.simulated, sim] }));
    toast({ tone: 'success', title: 'Test notification simulated', description: `Would be delivered via ${channels.join(', ') || 'no channels'}. Nothing was actually sent.` });
  }, [state.counter, state.prefs, update, toast]);

  const clearSimulated = useCallback(() => update((p) => ({ ...p, simulated: [] })), [update]);

  const value = useMemo<AlertsContextValue>(
    () => ({
      alerts: visible,
      hiddenCount: hidden,
      unread,
      isRead: (alert) => isReadFn(alert, state.read),
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
    }),
    [visible, hidden, unread, state.read, state.prefs, state.simulated.length, setRead, markAllRead, act, anomalyById, setPrefs, simulateAlert, sendTest, clearSimulated],
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
