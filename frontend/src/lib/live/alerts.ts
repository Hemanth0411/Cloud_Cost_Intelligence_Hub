/**
 * Alerts, live.
 *
 * THE TWO MODELS ARE NOT THE SAME THING, and that is the whole reason
 * this file exists rather than a few `if (isMock())` branches.
 *
 * The mock DERIVES alerts, every page load, from three things: open
 * anomalies, accounts whose projected spend is near their budget, and
 * connections that look stale. The backend STORES them: an
 * `alert_rules` row says what to watch, an evaluator writes an
 * `alert_events` row when it fires, and the feed reads those rows.
 *
 * In live mode two of the three mock sources do not exist -- there are
 * no budgets in the schema and connection health is simulated -- so
 * leaving the derivation running would have put fabricated "Account X
 * is projected to exceed its budget" and "Account Y has not synced"
 * items in the notification bell on every page. Those are exactly the
 * claims the owner's rule forbids. The feed replaces them, and today
 * the feed is empty because no rule has been created and no evaluator
 * run has fired one.
 *
 * WHAT IS LOST, STATED PLAINLY: severity. `alert_events` has no
 * severity column, so `AlertItem.severity` is null for live items.
 * That is why the severity filter and the minimum-severity preference
 * are hidden in live mode -- a control that silently matches
 * everything is worse than no control.
 */
import {
  fetchAlertFeed,
  fetchAlertRules,
  markAlertEventRead,
  type AlertEventRow,
  type AlertRuleRow,
} from '@/lib/api/cost-api';
import { formatCurrency } from '@/lib/format';
import type { AlertCategory, AlertItem, AlertStatus } from '@/types/domain';

/**
 * Rule type -> the category the UI groups by.
 *
 * `threshold`, `forecast` and `digest` are all spend-against-a-number
 * rules, which is what the 'budget' category means on this screen.
 * Nothing live can produce a 'connection' item: connection health is
 * not evaluated by any rule.
 */
function categoryOf(ruleType: string): AlertCategory {
  return ruleType === 'anomaly' ? 'anomaly' : 'budget';
}

function statusOf(status: string): AlertStatus {
  if (status === 'read') return 'acknowledged';
  if (status === 'dismissed') return 'resolved';
  return 'active';
}

function messageOf(event: AlertEventRow): string {
  const parts: string[] = [];
  if (event.observedValue !== null) parts.push(`${formatCurrency(event.observedValue)} observed`);
  if (event.expectedValue !== null) parts.push(`${formatCurrency(event.expectedValue)} expected`);
  if (event.deliveryError) parts.push(`delivery failed: ${event.deliveryError}`);
  return parts.length > 0
    ? `${parts.join(' vs ')}.`
    : 'The rule fired. No observed or expected value was recorded.';
}

export function toAlertItem(event: AlertEventRow): AlertItem {
  return {
    id: event.id,
    category: categoryOf(event.type),
    // No severity column on alert_events. See the note above.
    severity: null,
    status: statusOf(event.status),
    title: event.ruleName || 'Alert',
    message: messageOf(event),
    timestamp: event.firedAt,
    // The event payload is free-form, so there is no guaranteed link
    // back to an anomaly, account or service. Guessing from payload
    // keys would make the links wrong exactly when the payload shape
    // changed.
    anomalyId: null,
    accountId: null,
    serviceId: null,
    simulated: false,
  };
}

export interface LiveAlerts {
  rules: AlertRuleRow[];
  items: AlertItem[];
  /** Feed rows still in 'new'. The server owns read state, not localStorage. */
  unread: number;
  asOf: string | null;
}

export const EMPTY_LIVE_ALERTS: LiveAlerts = { rules: [], items: [], unread: 0, asOf: null };

export async function loadLiveAlerts(): Promise<LiveAlerts> {
  const [rules, feed] = await Promise.all([fetchAlertRules(), fetchAlertFeed(100)]);
  return {
    rules,
    items: feed.data.map(toAlertItem),
    unread: feed.data.filter((e) => e.status === 'new').length,
    asOf: feed.asOf,
  };
}

export async function markLiveAlertRead(eventId: string): Promise<void> {
  await markAlertEventRead(eventId);
}
