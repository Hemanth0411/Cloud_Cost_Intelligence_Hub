import type { NotificationPreferences, Severity } from '@/types/domain';

export const DEFAULT_PREFERENCES: NotificationPreferences = {
  channels: { inApp: true, email: true, slack: false },
  categories: { anomaly: true, budget: true, connection: true },
  minSeverity: 'medium',
};

const RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
export const SEVERITIES: readonly Severity[] = ['low', 'medium', 'high', 'critical'];

export const severityAtLeast = (severity: Severity, minimum: Severity): boolean => RANK[severity] >= RANK[minimum];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isSeverity = (v: unknown): v is Severity => typeof v === 'string' && (SEVERITIES as readonly string[]).includes(v);

/** Structural validation of stored preferences; returns null when the data is not usable. */
export function parsePreferences(raw: unknown): NotificationPreferences | null {
  if (!isRecord(raw) || !isRecord(raw.channels) || !isRecord(raw.categories)) return null;
  const { channels: c, categories: k } = raw;
  const flags = [c.inApp, c.email, c.slack, k.anomaly, k.budget, k.connection];
  if (!flags.every((f) => typeof f === 'boolean') || !isSeverity(raw.minSeverity)) return null;
  return {
    channels: { inApp: c.inApp === true, email: c.email === true, slack: c.slack === true },
    categories: { anomaly: k.anomaly === true, budget: k.budget === true, connection: k.connection === true },
    minSeverity: raw.minSeverity,
  };
}

/** Human-readable delivery channels. Delivery is always simulated. */
export function channelSummary(prefs: NotificationPreferences): string[] {
  const out: string[] = [];
  if (prefs.channels.inApp) out.push('In-app');
  if (prefs.channels.email) out.push('Email (simulated)');
  if (prefs.channels.slack) out.push('Slack (simulated)');
  return out;
}
