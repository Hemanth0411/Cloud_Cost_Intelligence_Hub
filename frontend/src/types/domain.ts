/**
 * Core domain model for the Cloud Cost Intelligence Platform.
 *
 * `DailyCost` is the single fact table. Every KPI, chart, table, comparison,
 * anomaly and insight is derived from it, which guarantees the numbers shown
 * on different screens always reconcile.
 */

export type ProviderId = 'aws' | 'azure' | 'gcp';
export type ConnectionStatus = 'connected' | 'degraded' | 'disconnected';
export type Environment = 'production' | 'staging' | 'development';
export type ServiceCategory =
  | 'compute'
  | 'storage'
  | 'database'
  | 'network'
  | 'analytics'
  | 'ai-ml';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type AnomalyStatus = 'open' | 'investigating' | 'acknowledged' | 'resolved' | 'dismissed';
export type AnomalyKind = 'spike' | 'sustained-increase' | 'drop' | 'sustained-decrease';

export interface Provider {
  id: ProviderId;
  name: string;
  status: ConnectionStatus;
  /** ISO timestamp of the last (simulated) billing sync. */
  lastSyncedAt: string;
}

export interface Account {
  id: string;
  providerId: ProviderId;
  name: string;
  /** Cloud-native identifier, e.g. an AWS account number. */
  externalId: string;
  environment: Environment;
  team: string;
  owner: string;
  region: string;
  monthlyBudget: number;
}

export interface Service {
  id: string;
  providerId: ProviderId;
  name: string;
  category: ServiceCategory;
}

export interface DailyCost {
  /** ISO date, yyyy-MM-dd (UTC). */
  date: string;
  providerId: ProviderId;
  accountId: string;
  serviceId: string;
  cost: number;
  usageQuantity: number;
}

export interface Anomaly {
  id: string;
  kind: AnomalyKind;
  /** Detection date (the day the rule fired). */
  date: string;
  providerId: ProviderId;
  accountId: string;
  serviceId: string;
  /** Observed cost per day. Spikes/drops: that day. Sustained: median of the recent window. */
  observedCost: number;
  /** Expected cost per day from the trailing baseline. */
  expectedCost: number;
  /** observedCost - expectedCost (negative for decreases). */
  differenceCost: number;
  /** Signed percent change versus expected. */
  changePct: number;
  /** Days the observation covers: 1 for spikes/drops, the window length for sustained changes. */
  windowDays: number;
  /** differenceCost x windowDays: dollars of deviation inside the detection window. */
  impactCost: number;
  severity: Severity;
  status: AnomalyStatus;
}

export interface SeverityThresholds {
  mediumPct: number;
  highPct: number;
  criticalPct: number;
  mediumImpact: number;
  highImpact: number;
  criticalImpact: number;
}

/** All detection thresholds. Defaults and presets live in `lib/selectors/detect-anomalies.ts`. */
export interface AnomalyConfig {
  /** Trailing days used to learn "normal". */
  baselineDays: number;
  /** Minimum comparable days required before judging a day. */
  minBaselineSamples: number;
  spikeSigma: number;
  spikeMinPct: number;
  dropSigma: number;
  dropMinPct: number;
  /** Ignore changes smaller than this many dollars per day. */
  minDailyDelta: number;
  sustainedWindowDays: number;
  sustainedIncreasePct: number;
  sustainedDecreasePct: number;
  sustainedMinDailyDelta: number;
  severity: SeverityThresholds;
}

export type Confidence = 'low' | 'medium' | 'high';
export type Effort = 'low' | 'medium' | 'high';

export interface Evidence {
  label: string;
  value: string;
}

/** A cost-saving idea. Savings are always estimates built from stated assumptions. */
export interface Opportunity {
  id: string;
  title: string;
  summary: string;
  /** Mid-point estimate, USD per month. */
  estimatedMonthlySavings: number;
  rangeLow: number;
  rangeHigh: number;
  /** Matching spend the estimate is applied to, normalised to a 30-day month. */
  basisMonthlySpend: number;
  assumption: string;
  confidence: Confidence;
  effort: Effort;
  evidence: Evidence[];
  actions: string[];
  relatedAccountIds: string[];
  relatedServiceIds: string[];
}

export type InsightKind = 'change' | 'anomaly' | 'budget' | 'trend' | 'concentration' | 'optimization';
export type InsightPriority = 'high' | 'medium' | 'low';

/** A plain-English explanation generated from calculated metrics (deterministic templates, no AI model). */
export interface CostInsight {
  id: string;
  kind: InsightKind;
  priority: InsightPriority;
  title: string;
  summary: string;
  evidence: Evidence[];
  investigateNext: string[];
  recommendedActions: string[];
  relatedAccountIds: string[];
  relatedServiceIds: string[];
  relatedAnomalyIds: string[];
}

export type AlertCategory = 'anomaly' | 'budget' | 'connection' | 'simulated';
export type AlertStatus = 'active' | 'acknowledged' | 'resolved';

/** One notification-worthy event. Alerts are derived from anomalies, budgets and connection state. */
export interface AlertItem {
  id: string;
  category: AlertCategory;
  severity: Severity;
  status: AlertStatus;
  title: string;
  message: string;
  /** ISO timestamp (UTC). */
  timestamp: string;
  anomalyId: string | null;
  accountId: string | null;
  serviceId: string | null;
  /** True for demo events created by the "simulate" buttons. */
  simulated: boolean;
}

export interface NotificationPreferences {
  /** Delivery is always simulated in this prototype; nothing is sent. */
  channels: { inApp: boolean; email: boolean; slack: boolean };
  categories: { anomaly: boolean; budget: boolean; connection: boolean };
  /** Alerts below this severity are hidden and do not count as unread. */
  minSeverity: Severity;
}

export type Connectivity = 'connected' | 'degraded' | 'disconnected';

export interface AccountConnection {
  status: Connectivity;
  /** ISO timestamp of the last successful (simulated) sync. */
  lastSyncedAt: string;
  /** ISO timestamp of the last connect/disconnect action, if the user made one. */
  changedAt: string | null;
}

export interface User {
  name: string;
  email: string;
  role: string;
}

// ---------------------------------------------------------------- admin
//
// Mirrors the backend's users / access_grants / audit_log tables. Field
// names are camelCase here and snake_case over the wire; the mapping
// belongs in admin-service, so nothing above this line cares.

/** Matches the backend exactly: there are two roles, not a spectrum. */
export type Role = 'superadmin' | 'user';

export type UserStatus = 'invited' | 'active' | 'disabled';

export interface ManagedUser {
  id: string;
  email: string;
  displayName: string | null;
  role: Role;
  status: UserStatus;
  invitedAt: string;
  lastSeenAt: string | null;
}

/**
 * One grant = one account, optionally narrowed to a single service.
 *
 * `serviceName: null` means every service in that account -- the same
 * convention as the SQL predicate, where a NULL service_name matches
 * any row. Keeping the null rather than inventing an 'all' sentinel is
 * what lets the UI and the database agree without a translation step.
 */
export interface Grant {
  id: string;
  userId: string;
  userEmail: string;
  providerId: string;
  accountId: string;
  accountName: string;
  serviceName: string | null;
  grantedBy: string;
  grantedAt: string;
  /** null = indefinite. */
  validUntil: string | null;
  /** Set once revoked; grants are never deleted, so history survives. */
  revokedAt: string | null;
  reason: string | null;
}

export type AuditAction =
  | 'user.invite'
  | 'user.disable'
  | 'grant.create'
  | 'grant.revoke'
  | 'connection.create'
  | 'connection.disable'
  | 'access.superadmin_bypass';

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  /** Free-form before/after snapshots, rendered as a diff, not raw JSON. */
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}
