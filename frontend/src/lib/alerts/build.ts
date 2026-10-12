import { addDays } from '@/lib/dates';
import { formatCompactCurrency, formatCurrency, formatDateTime, formatSignedPercent } from '@/lib/format';
import { hashString } from '@/lib/mock/seed';
import { KIND_LABELS } from '@/lib/selectors/detect-anomalies';
import { DEMO_NOW_ISO } from '@/lib/clock';
import type { AnomalyView, BudgetStatus } from '@/types/analytics';
import type { AlertItem, AlertStatus, AnomalyStatus, Connectivity, NotificationPreferences, ProviderId, Severity } from '@/types/domain';
import { severityAtLeast } from './preferences';

export interface BudgetAlertSource {
  accountId: string;
  name: string;
  providerId: ProviderId;
  projectedSpend: number;
  monthlyBudget: number;
  projectedPct: number;
  status: BudgetStatus;
}

export interface ConnectionAlertSource {
  accountId: string;
  name: string;
  providerId: ProviderId;
  status: Connectivity;
  lastSyncedAt: string;
  changedAt: string | null;
}

export interface SimulatedAlert {
  id: string;
  severity: Severity;
  title: string;
  message: string;
  timestamp: string;
  accountId: string | null;
}

export interface AlertSources {
  anomalies: readonly AnomalyView[];
  budgets: readonly BudgetAlertSource[];
  connections: readonly ConnectionAlertSource[];
  simulated: readonly SimulatedAlert[];
  /** yyyy-MM of the current month, used to make budget alert ids month-specific. */
  monthKey: string;
  /** Timestamp for alerts raised by the latest billing sync. */
  syncedAt: string;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Billing data lands early the next morning, so an anomaly on day D is "detected" at 02:00-03:59 UTC on D+1. */
export function detectionTimestamp(anomaly: Pick<AnomalyView, 'id' | 'date'>): string {
  const h = hashString(anomaly.id);
  return `${addDays(anomaly.date, 1)}T${pad(2 + (h % 2))}:${pad((h >>> 3) % 60)}:00Z`;
}

export function alertStatusFromAnomaly(status: AnomalyStatus): AlertStatus {
  if (status === 'acknowledged') return 'acknowledged';
  if (status === 'resolved' || status === 'dismissed') return 'resolved';
  return 'active';
}

export function buildAlerts(src: AlertSources, localStatuses: Readonly<Record<string, AlertStatus>>): AlertItem[] {
  const alerts: AlertItem[] = [];

  for (const a of src.anomalies) {
    alerts.push({
      id: `alert-${a.id}`,
      category: 'anomaly',
      severity: a.severity,
      status: alertStatusFromAnomaly(a.status),
      title: `${a.serviceName} ${KIND_LABELS[a.kind].toLowerCase()} in ${a.accountName}`,
      message: `${formatCurrency(a.observedCost)} observed vs ${formatCurrency(a.expectedCost)} expected (${formatSignedPercent(a.changePct, 0)}) for ${a.date}${a.windowDays > 1 ? `, typical daily cost over ${a.windowDays} days` : ''}.`,
      timestamp: detectionTimestamp(a),
      anomalyId: a.id,
      accountId: a.accountId,
      serviceId: a.serviceId,
      simulated: false,
    });
  }

  for (const b of src.budgets) {
    if (b.status === 'on-track') continue;
    const id = `budget-${b.accountId}-${src.monthKey}`;
    const over = b.status === 'over-budget';
    alerts.push({
      id,
      category: 'budget',
      severity: over ? 'high' : 'medium',
      status: localStatuses[id] ?? 'active',
      title: over ? `${b.name} is projected to exceed its budget` : `${b.name} is close to its budget`,
      message: `Projected ${formatCompactCurrency(b.projectedSpend)} of a ${formatCompactCurrency(b.monthlyBudget)} monthly budget (${b.projectedPct.toFixed(0)}%).`,
      timestamp: src.syncedAt,
      anomalyId: null,
      accountId: b.accountId,
      serviceId: null,
      simulated: false,
    });
  }

  for (const c of src.connections) {
    if (c.status === 'connected') continue;
    const id = `conn-${c.accountId}-${c.status}`;
    const disconnected = c.status === 'disconnected';
    alerts.push({
      id,
      category: 'connection',
      severity: disconnected ? 'high' : 'medium',
      status: localStatuses[id] ?? 'active',
      title: disconnected ? `${c.name} is disconnected` : `${c.name} sync is delayed`,
      message: disconnected
        ? `New cost data is no longer syncing. Last successful sync: ${formatDateTime(c.lastSyncedAt)}.`
        : `The last successful sync was ${formatDateTime(c.lastSyncedAt)}. Cost data may be out of date.`,
      timestamp: disconnected ? (c.changedAt ?? c.lastSyncedAt) : c.lastSyncedAt,
      anomalyId: null,
      accountId: c.accountId,
      serviceId: null,
      simulated: false,
    });
  }

  for (const s of src.simulated) {
    alerts.push({
      id: s.id,
      category: 'simulated',
      severity: s.severity,
      status: localStatuses[s.id] ?? 'active',
      title: s.title,
      message: s.message,
      timestamp: s.timestamp,
      anomalyId: null,
      accountId: s.accountId,
      serviceId: null,
      simulated: true,
    });
  }

  const rank: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return alerts.sort((x, y) => (x.timestamp === y.timestamp ? rank[x.severity] - rank[y.severity] || (x.id < y.id ? -1 : 1) : x.timestamp < y.timestamp ? 1 : -1));
}

/** Hides alerts the user opted out of. Simulated demo events always show. */
export function applyPreferences(alerts: readonly AlertItem[], prefs: NotificationPreferences): { visible: AlertItem[]; hidden: number } {
  const visible = alerts.filter((a) => {
    if (a.category === 'simulated') return true;
    return prefs.categories[a.category] && severityAtLeast(a.severity, prefs.minSeverity);
  });
  return { visible, hidden: alerts.length - visible.length };
}

const THREE_DAYS_MS = 3 * 86_400_000;

/** Before the user touches anything: old alerts count as read, recent and simulated ones as unread. */
export function defaultRead(alert: AlertItem): boolean {
  if (alert.simulated) return false;
  if (alert.status === 'resolved') return true;
  return Date.parse(DEMO_NOW_ISO) - Date.parse(alert.timestamp) > THREE_DAYS_MS;
}

export const isRead = (alert: AlertItem, readMap: Readonly<Record<string, boolean>>): boolean => readMap[alert.id] ?? defaultRead(alert);

export function unreadCount(visible: readonly AlertItem[], readMap: Readonly<Record<string, boolean>>): number {
  return visible.filter((a) => !isRead(a, readMap)).length;
}
