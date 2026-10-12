import type { AnomalyStatus } from '@/types/domain';

export interface WorkflowAction {
  to: AnomalyStatus;
  label: string;
  intent: 'primary' | 'secondary' | 'ghost';
}

/** The next steps available from each status. Every status can always be undone via "Reopen". */
export function workflowActions(status: AnomalyStatus): WorkflowAction[] {
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
