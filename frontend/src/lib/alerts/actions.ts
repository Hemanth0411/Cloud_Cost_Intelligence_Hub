import type { AlertItem, AlertStatus, AnomalyStatus } from '@/types/domain';

export type AlertAction = 'acknowledge' | 'resolve' | 'reopen';

export type Transition =
  | { kind: 'anomaly'; anomalyId: string; to: AnomalyStatus }
  | { kind: 'local'; id: string; to: AlertStatus };

export const ACTION_LABELS: Record<AlertAction, string> = {
  acknowledge: 'Acknowledge',
  resolve: 'Resolve',
  reopen: 'Reopen',
};

export function availableActions(status: AlertStatus): AlertAction[] {
  switch (status) {
    case 'active':
      return ['acknowledge', 'resolve'];
    case 'acknowledged':
      return ['resolve', 'reopen'];
    default:
      return ['reopen'];
  }
}

/**
 * Anomaly alerts share their workflow with the Anomalies page (one source of truth), so acting on an
 * alert acknowledges/resolves the underlying anomaly. Other alerts keep a local status.
 */
export function transitionFor(alert: AlertItem, action: AlertAction): Transition {
  if (alert.anomalyId !== null) {
    const to: AnomalyStatus = action === 'acknowledge' ? 'acknowledged' : action === 'resolve' ? 'resolved' : 'open';
    return { kind: 'anomaly', anomalyId: alert.anomalyId, to };
  }
  const to: AlertStatus = action === 'acknowledge' ? 'acknowledged' : action === 'resolve' ? 'resolved' : 'active';
  return { kind: 'local', id: alert.id, to };
}
