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
  budget: {
    /** Budgets belong to accounts, so they are not comparable when a single service is selected. */
    applicable: boolean;
    monthlyBudget: number;
    mtdSpend: number;
    projectedSpend: number;
    mtdPct: number;
    projectedPct: number;
  };
  accounts: { connected: number; providers: number; degradedProviders: number };
  services: { inUse: number; categories: number };
  /** `active` = open + investigating + acknowledged. */
  anomalies: { active: number; total: number; criticalOrHigh: number };
  savings: { monthly: number; pctOfRunRate: number; opportunities: number };
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
  category?: ServiceCategory;
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
  environment: Environment;
  team: string;
  owner: string;
  region: string;
  externalId: string;
  cost: number;
  previousCost: number;
  deltaPct: number | null;
  sharePct: number;
  monthlyBudget: number;
  mtdSpend: number;
  projectedSpend: number;
  mtdPct: number;
  projectedPct: number;
  budgetStatus: BudgetStatus;
}

export interface AnomalyView extends Anomaly {
  accountName: string;
  serviceName: string;
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
  savings: Opportunity[];
}

export type BaselineKind = 'previous' | 'year-ago';
export type ComparisonDimension = 'provider' | 'account' | 'service';

export interface ComparisonEntity {
  id: string;
  label: string;
  providerId: ProviderId;
  category?: ServiceCategory;
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
  /** Daily cost over the current period, one value per day. */
  dailyCurrent: number[];
  dailyBaseline: number[];
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
