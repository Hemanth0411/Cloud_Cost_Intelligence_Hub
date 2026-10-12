import type { AnomalyStatus } from '@/types/domain';

export interface WorkflowAction {
  to: AnomalyStatus;
  label: string;
  intent: 'primary' | 'secondary' | 'ghost';
}

/**
 * The next steps available from each status.
 *
 * `persisted` restricts the list to the transitions the BACKEND has.
 * `anomaly_findings.status` is CHECKed to new / acknowledged /
 * dismissed, so "Start investigating" and "Mark resolved" would be
 * 422s, and "Reopen" has no endpoint at all. Offering a button that
 * fails is worse than not offering it, and keeping the extra states
 * only in the browser would mean the workflow silently reset on the
 * next page load.
 */
const PERSISTED: readonly AnomalyStatus[] = ['acknowledged', 'dismissed'];

export function workflowActions(status: AnomalyStatus, persisted = false): WorkflowAction[] {
  const all = allActions(status);
  return persisted ? all.filter((a) => PERSISTED.includes(a.to)) : all;
}

function allActions(status: AnomalyStatus): WorkflowAction[] {
  switch (status) {
    case 'open':
      return [
        { to: 'investigating', label: 'Start investigating', intent: 'primary' },
        { to: 'acknowledged', label: 'Acknowledge', intent: 'secondary' },
        { to: 'dismissed', label: 'Dismiss', intent: 'ghost' },
      ];
    case 'investigating':
      return [
        { to: 'resolved', label: 'Mark resolved', intent: 'primary' },
        { to: 'acknowledged', label: 'Acknowledge', intent: 'secondary' },
        { to: 'dismissed', label: 'Dismiss', intent: 'ghost' },
      ];
    case 'acknowledged':
      return [
        { to: 'resolved', label: 'Mark resolved', intent: 'primary' },
        { to: 'investigating', label: 'Investigate', intent: 'secondary' },
        { to: 'dismissed', label: 'Dismiss', intent: 'ghost' },
      ];
    default:
      return [{ to: 'open', label: 'Reopen', intent: 'secondary' }];
  }
}
