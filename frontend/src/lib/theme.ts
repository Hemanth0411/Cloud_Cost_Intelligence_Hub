import type { BudgetStatus } from '@/types/analytics';
import type { AlertCategory, AlertStatus, AnomalyKind, AnomalyStatus, Connectivity, Environment, ProviderId, Severity } from '@/types/domain';

/** Recharts needs concrete color strings; these resolve through CSS variables so dark mode just works. */
export const PROVIDER_COLOR: Record<ProviderId, string> = {
  aws: 'hsl(var(--provider-aws))',
  azure: 'hsl(var(--provider-azure))',
  gcp: 'hsl(var(--provider-gcp))',
};

export const PROVIDER_SHORT_NAME: Record<ProviderId, string> = {
  aws: 'AWS',
  azure: 'Azure',
  gcp: 'GCP',
};

export const PROVIDER_ORDER: readonly ProviderId[] = ['aws', 'azure', 'gcp'];

export const ENVIRONMENT_LABEL: Record<Environment, string> = {
  production: 'Production',
  staging: 'Staging',
  development: 'Development',
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

export const SEVERITY_CLASS: Record<Severity, string> = {
  low: 'bg-muted text-muted-foreground',
  medium: 'bg-warning/15 text-warning',
  high: 'bg-destructive/15 text-destructive',
  critical: 'bg-destructive text-destructive-foreground',
};

export const BUDGET_STATUS_LABEL: Record<BudgetStatus, string> = {
  'on-track': 'On track',
  'at-risk': 'At risk',
  'over-budget': 'Over budget',
};

export const BUDGET_STATUS_CLASS: Record<BudgetStatus, string> = {
  'on-track': 'bg-success/15 text-success',
  'at-risk': 'bg-warning/15 text-warning',
  'over-budget': 'bg-destructive/15 text-destructive',
};

export const BUDGET_BAR_CLASS: Record<BudgetStatus, string> = {
  'on-track': 'bg-success',
  'at-risk': 'bg-warning',
  'over-budget': 'bg-destructive',
};

export const ANOMALY_STATUS_LABEL: Record<AnomalyStatus, string> = {
  open: 'Open',
  investigating: 'Investigating',
  acknowledged: 'Acknowledged',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

export const ANOMALY_STATUS_CLASS: Record<AnomalyStatus, string> = {
  open: 'bg-destructive/15 text-destructive',
  investigating: 'bg-primary/15 text-primary',
  acknowledged: 'bg-warning/15 text-warning',
  resolved: 'bg-success/15 text-success',
  dismissed: 'bg-muted text-muted-foreground',
};

/** Increases are shown in red (cost went up), decreases in blue (needs checking, not necessarily good news). */
export const ANOMALY_KIND_CLASS: Record<AnomalyKind, string> = {
  // Server-side detector only: a run that is still climbing.
  creep: 'bg-warning/15 text-warning',
  spike: 'bg-destructive/15 text-destructive',
  'sustained-increase': 'bg-warning/15 text-warning',
  drop: 'bg-primary/15 text-primary',
  'sustained-decrease': 'bg-primary/15 text-primary',
};

export const CONNECTION_LABEL: Record<Connectivity | 'syncing', string> = {
  connected: 'Connected',
  degraded: 'Sync delayed',
  disconnected: 'Disconnected',
  syncing: 'Syncing…',
};

export const CONNECTION_CLASS: Record<Connectivity | 'syncing', string> = {
  connected: 'bg-success/15 text-success',
  degraded: 'bg-warning/15 text-warning',
  disconnected: 'bg-destructive/15 text-destructive',
  syncing: 'bg-primary/15 text-primary',
};

export const ALERT_STATUS_LABEL: Record<AlertStatus, string> = { active: 'Active', acknowledged: 'Acknowledged', resolved: 'Resolved' };
export const ALERT_STATUS_CLASS: Record<AlertStatus, string> = {
  active: 'bg-destructive/15 text-destructive',
  acknowledged: 'bg-warning/15 text-warning',
  resolved: 'bg-success/15 text-success',
};

export const ALERT_CATEGORY_LABEL: Record<AlertCategory, string> = {
  anomaly: 'Anomaly',
  budget: 'Budget',
  connection: 'Connection',
  simulated: 'Simulated',
};

// ---------------------------------------------------------- absent values
//
// Several of the maps above are indexed by a field that is null when
// the data source does not carry it (see types/domain.ts). These
// lookups render the absence instead of crashing on `MAP[null]`, and
// they all render it the SAME WAY -- an em dash and a muted tone --
// so "we do not know" never looks like a measured low value.

/** The one string every screen uses for a value that does not exist. */
export const ABSENT = '—';

export const environmentLabel = (value: Environment | null): string =>
  value === null ? ABSENT : ENVIRONMENT_LABEL[value];

export const severityLabel = (value: Severity | null): string =>
  value === null ? ABSENT : SEVERITY_LABEL[value];

export const severityClass = (value: Severity | null): string =>
  value === null ? 'bg-muted text-muted-foreground' : SEVERITY_CLASS[value];

export const budgetStatusLabel = (value: BudgetStatus | null): string =>
  value === null ? 'No budget set' : BUDGET_STATUS_LABEL[value];

export const budgetStatusClass = (value: BudgetStatus | null): string =>
  value === null ? 'bg-muted text-muted-foreground' : BUDGET_STATUS_CLASS[value];
