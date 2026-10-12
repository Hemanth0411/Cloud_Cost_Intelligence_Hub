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
/**
 * `creep` comes from the backend detector only.
 *
 * The server's MadDetector classifies step / spike / creep and flags
 * RISES ONLY (`if delta <= 0: continue`), so it never emits a drop;
 * the client-side detector that powers the mock emits the other four
 * and never a creep. Both sets live in one union because the anomaly
 * screens render whichever mode produced them, and collapsing creep
 * into 'sustained-increase' would merge two counts the detector
 * deliberately separates: a creep is still climbing, a step jumped
 * and held.
 */
export type AnomalyKind =
  | 'spike'
  | 'sustained-increase'
  | 'creep'
  | 'drop'
  | 'sustained-decrease';

/**
 * NULLABLE FIELDS ARE "THIS SOURCE CANNOT SAY", NOT "ZERO".
 *
 * The mock dataset invented a cloud estate: budgets, owning teams,
 * environments, service categories and connection health. The API
 * serves cost rows out of `fact_cost_daily` and account names out of
 * `dim_account`, and neither table has any of those columns. Filling
 * them with 0 / 'production' / 'connected' in live mode would put a
 * number on the screen that nothing stands behind, which is the one
 * thing this app must not do. So they are nullable, and every renderer
 * has to decide what absent looks like.
 */
export interface Provider {
  id: ProviderId;
  name: string;
  /** Null in live mode: connection health is simulated, never measured. */
  status: ConnectionStatus | null;
  /** ISO timestamp of the last (simulated) billing sync. Null in live mode. */
  lastSyncedAt: string | null;
}

export interface Account {
  id: string;
  providerId: ProviderId;
  name: string;
  /** Cloud-native identifier, e.g. an AWS account number. In live mode this IS the id. */
  externalId: string;
  /** The four below have no column in `dim_account`; null in live mode. */
  environment: Environment | null;
  team: string | null;
  owner: string | null;
  region: string | null;
  /** No budget is stored anywhere in the backend. Null in live mode. */
  monthlyBudget: number | null;
}

export interface Service {
  /** In live mode the service NAME is the id: it is what the API groups by. */
  id: string;
  providerId: ProviderId;
  name: string;
  /**
   * `dim_service.service_category` exists but no endpoint exposes it,
   * so this is null in live mode until one does.
   */
  category: ServiceCategory | null;
}

/**
 * THE MOCK'S OWN TYPES, where the nullable fields above are always
 * filled.
 *
 * The invented estate HAS budgets, owners and categories, and the
 * selectors that only ever run over it -- the optimizer, the insight
 * generator, the anomaly narrative -- read them on every line. Giving
 * those selectors a narrowed input type keeps that invariant checked
 * by the compiler instead of asserted with `!` at seventy call sites,
 * and means a future live caller cannot be passed in by mistake.
 */
export interface MockProvider extends Provider {
  status: ConnectionStatus;
  lastSyncedAt: string;
}

export interface MockAccount extends Account {
  environment: Environment;
  team: string;
  owner: string;
  region: string;
  monthlyBudget: number;
}

export interface MockService extends Service {
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

/**
 * The two slices of `DailyCost` the time-series maths actually reads.
 *
 * Live mode has no fact rows -- `/cost/series` returns one total per
 * period, with no account or service attached -- so the bucketing and
 * month-statistics helpers take these instead of the full row. That
 * keeps ONE implementation of the forecast formula: two modes
 * computing "month to date plus the trailing 7-day average" slightly
 * differently is a discrepancy nobody would find until someone
 * compared screenshots.
 */
export type CostRow = Pick<DailyCost, 'date' | 'cost'>;
export type ProviderCostRow = CostRow & Pick<DailyCost, 'providerId'>;

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
  /**
   * Signed percent change versus expected.
   *
   * NULL WHEN THE BASELINE WAS ZERO, and that is the common
   * switched-something-on case, not an edge case: a service with no
   * prior charges has a zero median, so "percent change" has no
   * value. Zero would read as "no change" on the exact finding that
   * matters most.
   */
  changePct: number | null;
  /**
   * Days the observation covers: 1 for spikes/drops, the window length
   * for sustained changes.
   *
   * Null for findings from the API: `anomaly_findings` stores only
   * `detected_for_date`, so the run length the server grouped over is
   * not persisted and cannot be recovered here.
   */
  windowDays: number | null;
  /** differenceCost x windowDays. Null whenever `windowDays` is. */
  impactCost: number | null;
  severity: Severity;
  status: AnomalyStatus;
}

/**
 * An anomaly from the CLIENT-SIDE detector.
 *
 * It measures a window, so it knows how long the change ran and what
 * it cost over that window; the API's findings do not (see the note
 * on `windowDays`). Anything that multiplies by a window length takes
 * this type.
 */
export interface DetectedAnomaly extends Anomaly {
  changePct: number;
  windowDays: number;
  impactCost: number;
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
  /**
   * Null for items that came from `alert_events`, which has no
   * severity column. Derived mock alerts always have one.
   */
  severity: Severity | null;
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

/**
 * Every action the backend actually writes, plus 'user.disable' which
 * only the mock does.
 *
 * `audit_log.action` is a free-form text column, so this union is a
 * convenience for labelling and NOT a guarantee. The audit screen must
 * render an action it has never heard of -- a new backend action would
 * otherwise appear as an empty badge, which looks like a missing row
 * rather than a missing label.
 */
export type AuditAction =
  | 'user.invite'
  | 'user.disable'
  | 'grant.create'
  | 'grant.revoke'
  | 'connection.create'
  | 'connection.update'
  | 'connection.enable'
  | 'connection.disable'
  | 'anomaly.scan'
  | 'access.superadmin_bypass';

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  /** Widened on purpose: see the note on AuditAction. */
  action: AuditAction | string;
  entityType: string;
  entityId: string;
  /** Free-form before/after snapshots, rendered as a diff, not raw JSON. */
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}
