import type { AlertStatus, NotificationPreferences } from '@/types/domain';
import type { SimulatedAlert } from './build';
import { DEFAULT_PREFERENCES, parsePreferences, SEVERITIES } from './preferences';

export interface AlertState {
  /** Explicit read / unread choices (anything missing uses the default rule). */
  read: Record<string, boolean>;
  /** Status of non-anomaly alerts. Anomaly alerts follow the anomaly workflow. */
  statuses: Record<string, AlertStatus>;
  simulated: SimulatedAlert[];
  /** Counter used to give each simulated alert a unique id. */
  counter: number;
  prefs: NotificationPreferences;
}

export const EMPTY_ALERT_STATE: AlertState = { read: {}, statuses: {}, simulated: [], counter: 0, prefs: DEFAULT_PREFERENCES };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const STATUSES: readonly string[] = ['active', 'acknowledged', 'resolved'];

/** Structural validation of persisted alert state. Returns null if it is not usable. */
export function parseAlertState(raw: unknown): AlertState | null {
  if (!isRecord(raw) || !isRecord(raw.read) || !isRecord(raw.statuses) || !Array.isArray(raw.simulated) || typeof raw.counter !== 'number') return null;
  const prefs = parsePreferences(raw.prefs);
  if (!prefs) return null;

  const read: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw.read)) if (typeof v === 'boolean') read[k] = v;
  const statuses: Record<string, AlertStatus> = {};
  for (const [k, v] of Object.entries(raw.statuses)) if (typeof v === 'string' && STATUSES.includes(v)) statuses[k] = v as AlertStatus;

  const simulated = raw.simulated.flatMap((s): SimulatedAlert[] =>
    isRecord(s) && typeof s.id === 'string' && typeof s.title === 'string' && typeof s.message === 'string' && typeof s.timestamp === 'string' &&
    typeof s.severity === 'string' && (SEVERITIES as readonly string[]).includes(s.severity) && (s.accountId === null || typeof s.accountId === 'string')
      ? [{ id: s.id, title: s.title, message: s.message, timestamp: s.timestamp, severity: s.severity as SimulatedAlert['severity'], accountId: s.accountId }]
      : [],
  ).slice(-50);

  return { read, statuses, simulated, counter: Math.max(0, Math.floor(raw.counter)), prefs };
}
