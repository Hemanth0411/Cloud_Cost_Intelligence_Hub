import type {
  Anomaly,
  AnomalyStatus,
  Environment,
  Opportunity,
  ProviderId,
  ServiceCategory,
} from './domain';

/** User-driven anomaly status changes, layered over the detected baseline. */
export type StatusOverrides = Readonly<Record<string, AnomalyStatus>>;

export type DateRangePreset = '7d' | '30d' | '90d' | 'mtd' | 'ytd' | '12m' | 'custom';
export type Granularity = 'day' | 'week' | 'month' | 'year';

export interface Filters {
  range: DateRangePreset;
  /** Only used when `range` is 'custom'. ISO yyyy-MM-dd. */
  customFrom: string | null;
  customTo: string | null;
  providerId: ProviderId | 'all';
  accountId: string | 'all';
  serviceId: string | 'all';
}

export interface ResolvedRange {
  preset: DateRangePreset;
  from: string;
  to: string;
  days: number;
  prevFrom: string;
  prevTo: string;
  /** False when the equal-length previous period starts before the data does. */
  hasPrevious: boolean;
}

export interface KpiMetric {
  value: number;
  /** Comparison value; null when not comparable. */
  previous: number | null;
  deltaPct: number | null;
  /** Series for the sparkline. */
  series: number[];
}

export interface DashboardKpis {
  totalSpend: KpiMetric & { avgDaily: number };
  previousSpend: {
    value: number | null;
    from: string;
    to: string;
    changeAbs: number | null;
    changePct: number | null;
  };
  monthToDate: KpiMetric;
  forecast: KpiMetric & { daysRemaining: number; monthLabel: string };
  /**
   * Null when the source has no budgets AT ALL -- which is live mode,
   * because nothing in the schema stores one. That is a different
   * statement from `applicable: false`, which means "there are budgets
   * but this selection is not comparable against them" (a single
   * service is selected; budgets belong to whole accounts). Rendering
   * both as a dash with the same hint told people to clear a filter
   * that was not the problem.
   */
  budget: {
    applicable: boolean;
    monthlyBudget: number;
    mtdSpend: number;
    projectedSpend: number;
    mtdPct: number;
    projectedPct: number;
  } | null;
  /** `categories` is null when service categories are not available. */
  services: { inUse: number; categories: number | null };
  /** `active` = open + investigating + acknowledged. */
  anomalies: { active: number; total: number; criticalOrHigh: number };
  /** Null when no optimization engine ran: there is no savings endpoint. */
  savings: { monthly: number; pctOfRunRate: number; opportunities: number } | null;
}

export interface TrendPoint {
  /** Period start (inclusive). For daily buckets start === end. */
  start: string;
  end: string;
  aws: number;
  azure: number;
  gcp: number;
  total: number;
  /** True when the period is not fully covered by the dataset (e.g. current month). */
  partial: boolean;
}

export interface ComparisonPoint {
  index: number;
  currentDate: string;
  previousDate: string;
  current: number;
  previous: number | null;
}

export interface BreakdownItem {
  id: string;
  label: string;
  providerId: ProviderId;
  category?: ServiceCategory | null;
  cost: number;
  previousCost: number;
  deltaPct: number | null;
  sharePct: number;
}

export type BudgetStatus = 'on-track' | 'at-risk' | 'over-budget';

export interface AccountSummary {
  accountId: string;
  name: string;
  providerId: ProviderId;
  /** Null when the source has no such column -- see types/domain.ts. */
  environment: Environment | null;
  team: string | null;
  owner: string | null;
  region: string | null;
  externalId: string;
  cost: number;
  previousCost: number;
  deltaPct: number | null;
  sharePct: number;
  /** All six are null together: no budget means nothing to measure against. */
  monthlyBudget: number | null;
  mtdSpend: number | null;
  projectedSpend: number | null;
  mtdPct: number | null;
  projectedPct: number | null;
  budgetStatus: BudgetStatus | null;
}

export interface AnomalyView extends Anomaly {
  accountName: string;
  serviceName: string;
}

/** An `AnomalyView` from the client-side detector -- see `DetectedAnomaly`. */
export interface DetectedAnomalyView extends AnomalyView {
  changePct: number;
  windowDays: number;
  impactCost: number;
}

/** An account summary with the budget and metadata the mock estate has. */
export interface BudgetedAccountSummary extends AccountSummary {
  environment: Environment;
  team: string;
  owner: string;
  region: string;
  monthlyBudget: number;
  mtdSpend: number;
  projectedSpend: number;
  mtdPct: number;
  projectedPct: number;
  budgetStatus: BudgetStatus;
}

export interface DashboardData {
  range: ResolvedRange;
  kpis: DashboardKpis;
  /** Spend over time at each granularity. Only `day` follows the selected date range. */
  series: Record<Granularity, TrendPoint[]>;
  comparison: ComparisonPoint[];
  breakdowns: {
    provider: BreakdownItem[];
    account: BreakdownItem[];
    service: BreakdownItem[];
  };
  accounts: AccountSummary[];
  anomalies: AnomalyView[];
  /**
   * Null when no optimization pass ran. An EMPTY ARRAY would claim the
   * estate was examined and found nothing to save, which is a finding;
   * null says the question was never asked.
   */
  savings: Opportunity[] | null;
}

/**
 * A dashboard with every optional measure present -- i.e. one built
 * from the mock dataset.
 *
 * The insight generator and the optimizer are written against a
 * complete picture: they compare projected spend to a budget and rank
 * anomalies by windowed impact. Rather than teach them to say
 * "unknown" for a mode they never run in, they take this.
 */
export interface FullDashboardData extends DashboardData {
  kpis: DashboardKpis & {
    budget: NonNullable<DashboardKpis['budget']>;
    savings: NonNullable<DashboardKpis['savings']>;
  };
  accounts: BudgetedAccountSummary[];
  anomalies: DetectedAnomalyView[];
  savings: Opportunity[];
}

export type BaselineKind = 'previous' | 'year-ago';
export type ComparisonDimension = 'provider' | 'account' | 'service';

export interface ComparisonEntity {
  id: string;
  label: string;
  providerId: ProviderId;
  category?: ServiceCategory | null;
  current: number;
  baseline: number;
  /** current - baseline */
  diff: number;
  /** Null when there is no baseline or it was zero. */
  diffPct: number | null;
  /** Share of total current spend. */
  sharePct: number;
  /** Share of the total change this entity explains (can exceed 100% or be negative). */
  contributionPct: number | null;
  /**
   * Daily cost over the current period, one value per day.
   *
   * Null in live mode: a per-entity daily curve needs one
   * `/cost/series` call per entity, and the services dimension can
   * carry fifty. An array of zeros would draw a flat line that reads
   * as "spent nothing", so the chart is withheld instead.
   */
  dailyCurrent: number[] | null;
  dailyBaseline: number[] | null;
  /** Largest child in the current period (service for providers/accounts, account for services). */
  topChild: { label: string; cost: number } | null;
}

export interface ComparisonResult {
  baselineKind: BaselineKind;
  range: ResolvedRange;
  baselineFrom: string;
  baselineTo: string;
  hasBaseline: boolean;
  totals: {
    current: number;
    baseline: number;
    diff: number;
    diffPct: number | null;
    avgCurrent: number;
    avgBaseline: number;
  };
  points: ComparisonPoint[];
  providers: ComparisonEntity[];
  accounts: ComparisonEntity[];
  services: ComparisonEntity[];
}
