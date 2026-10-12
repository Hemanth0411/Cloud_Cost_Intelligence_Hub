/**
 * Data-access facade. UI code only talks to this module, never to the mock
 * dataset directly. Swapping in real AWS/Azure/GCP APIs later means replacing
 * these function bodies, not touching components.
 */
import { generateInsightReport, type InsightReport } from '@/lib/insights/generate';
import { explainAnomaly, type AnomalyExplanation } from '@/lib/insights/narrative';
import { getDataset } from '@/lib/mock/dataset';
import { getAnomalyContext, type AnomalyContext } from '@/lib/selectors/anomaly-context';
import { addDays } from '@/lib/dates';
import type { BudgetAlertSource } from '@/lib/alerts/build';
import { baseConnection } from '@/lib/mock/connections';
import { getComparison } from '@/lib/selectors/comparison';
import { getAnomalyViews } from '@/lib/selectors/anomaly-views';
import { getDashboardData } from '@/lib/selectors/dashboard';
import { DEFAULT_ANOMALY_CONFIG, detectAnomalies } from '@/lib/selectors/detect-anomalies';
import { resolveRange } from '@/lib/selectors/range';
import type { AnomalyView, BaselineKind, ComparisonResult, DashboardData, Filters, ResolvedRange, StatusOverrides } from '@/types/analytics';
import type { Account, AccountConnection, Anomaly, AnomalyConfig, Provider, Service } from '@/types/domain';

export interface FilterOptions {
  providers: Provider[];
  accounts: Account[];
  services: Service[];
  /** Which services each account has spend in (drives dependent filter options). */
  serviceIdsByAccount: Record<string, string[]>;
  dataStart: string;
  dataEnd: string;
}

let cachedOptions: FilterOptions | null = null;

export function getFilterOptions(): FilterOptions {
  if (cachedOptions) return cachedOptions;
  const ds = getDataset();
  cachedOptions = {
    providers: ds.providers,
    accounts: ds.accounts,
    services: ds.services,
    serviceIdsByAccount: Object.fromEntries(ds.serviceIdsByAccount),
    dataStart: ds.startDate,
    dataEnd: ds.endDate,
  };
  return cachedOptions;
}

const delay = (ms: number): Promise<void> => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

// ---- Anomaly detection (configurable) --------------------------------------------------------
const detectionCache = new Map<string, Anomaly[]>();

/** Runs (and caches) the detection engine for a given threshold configuration. */
export function getAnomalies(config: AnomalyConfig): Anomaly[] {
  const key = JSON.stringify(config);
  if (key === JSON.stringify(DEFAULT_ANOMALY_CONFIG)) return getDataset().anomalies;
  const hit = detectionCache.get(key);
  if (hit) return hit;
  const ds = getDataset();
  const result = detectAnomalies(ds.costs, ds.endDate, config);
  if (detectionCache.size >= 12) detectionCache.clear();
  detectionCache.set(key, result);
  return result;
}

export interface AnomalyPageData {
  range: ResolvedRange;
  anomalies: AnomalyView[];
  /** Everything detected in the whole history with this config (not limited to the selected range). */
  totalDetectedAllTime: number;
}

export function readAnomalyData(filters: Filters, config: AnomalyConfig, overrides: StatusOverrides): AnomalyPageData {
  const ds = getDataset();
  const detected = getAnomalies(config);
  const range = resolveRange(filters, { start: ds.startDate, end: ds.endDate });
  return { range, anomalies: getAnomalyViews(ds, detected, filters, range, overrides), totalDetectedAllTime: detected.length };
}

export async function fetchAnomalyData(
  filters: Filters,
  config: AnomalyConfig,
  overrides: StatusOverrides,
  latencyMs = 0,
): Promise<AnomalyPageData> {
  await delay(latencyMs);
  return readAnomalyData(filters, config, overrides);
}

export interface Investigation {
  context: AnomalyContext;
  explanation: AnomalyExplanation;
}

/** Everything the investigation view shows for one anomaly: the evidence curve plus the plain-English explanation. */
export function investigateAnomaly(anomaly: AnomalyView, config: AnomalyConfig): Investigation {
  const ds = getDataset();
  const context = getAnomalyContext(ds, anomaly, getAnomalies(config), config);
  const account = ds.accountById.get(anomaly.accountId);
  const explanation = explainAnomaly({
    anomaly,
    context,
    config,
    providerName: ds.providerById.get(anomaly.providerId)?.name ?? anomaly.providerId,
    ownerName: account?.owner ?? 'the account owner',
    teamName: account?.team ?? 'the owning team',
    category: ds.serviceById.get(anomaly.serviceId)?.category ?? 'compute',
    serviceNameOf: (id) => ds.serviceById.get(id)?.name ?? id,
  });
  return { context, explanation };
}

// ---- Dashboard ----------------------------------------------------------------------------------
export function readDashboardData(
  filters: Filters,
  statusOverrides: StatusOverrides = {},
  config: AnomalyConfig = DEFAULT_ANOMALY_CONFIG,
): DashboardData {
  return getDashboardData(getDataset(), filters, statusOverrides, getAnomalies(config));
}

/** Optional latency is for callers that still want a simulated wait. Sidebar pages read synchronously. */
export async function fetchDashboardData(
  filters: Filters,
  latencyMs = 0,
  statusOverrides: StatusOverrides = {},
  config: AnomalyConfig = DEFAULT_ANOMALY_CONFIG,
): Promise<DashboardData> {
  await delay(latencyMs);
  return readDashboardData(filters, statusOverrides, config);
}

// ---- AI insights (deterministic templates) -----------------------------------------------------------
export interface InsightBundle {
  report: InsightReport;
  data: DashboardData;
}

export function buildInsightBundle(filters: Filters, statusOverrides: StatusOverrides, config: AnomalyConfig): InsightBundle {
  const ds = getDataset();
  const detected = getAnomalies(config);
  const data = getDashboardData(ds, filters, statusOverrides, detected);
  return { report: generateInsightReport(ds, filters, data, detected, config), data };
}

/** Builds the insight report from dashboard data that was already computed (avoids recomputing it). */
export function buildInsightReport(filters: Filters, data: DashboardData, config: AnomalyConfig): InsightReport {
  return generateInsightReport(getDataset(), filters, data, getAnomalies(config), config);
}

// ---- Comparison ----------------------------------------------------------------------------------------
export function readComparison(filters: Filters, baseline: BaselineKind): ComparisonResult {
  return getComparison(getDataset(), filters, baseline);
}

export async function fetchComparison(filters: Filters, baseline: BaselineKind, latencyMs = 0): Promise<ComparisonResult> {
  await delay(latencyMs);
  return readComparison(filters, baseline);
}

// ---- Connections and alerts -----------------------------------------------------------------------------------
const ALL_SCOPE: Filters = { range: '30d', customFrom: null, customTo: null, providerId: 'all', accountId: 'all', serviceId: 'all' };

/** Starting connection state of an account (before any simulated connect / disconnect / sync). */
export function getBaseConnection(accountId: string): AccountConnection {
  const ds = getDataset();
  const account = ds.accountById.get(accountId);
  const provider = account ? ds.providerById.get(account.providerId) : undefined;
  return account && provider
    ? baseConnection(account, provider)
    : { status: 'disconnected', lastSyncedAt: `${ds.endDate}T00:00:00Z`, changedAt: null };
}

let budgetSnapshot: BudgetAlertSource[] | null = null;

/** Month-to-date budget position of every account (independent of the dashboard filters). */
export function getBudgetSnapshot(): BudgetAlertSource[] {
  if (budgetSnapshot) return budgetSnapshot;
  const data = getDashboardData(getDataset(), ALL_SCOPE);
  budgetSnapshot = data.accounts.map((a) => ({
    accountId: a.accountId,
    name: a.name,
    providerId: a.providerId,
    projectedSpend: a.projectedSpend,
    monthlyBudget: a.monthlyBudget,
    projectedPct: a.projectedPct,
    status: a.budgetStatus,
  }));
  return budgetSnapshot;
}

/** Anomalies from the last 90 days across all accounts, with the user's workflow applied: the source for alerts. */
export function getAlertAnomalies(config: AnomalyConfig, overrides: StatusOverrides): AnomalyView[] {
  const ds = getDataset();
  return getAnomalyViews(ds, getAnomalies(config), ALL_SCOPE, { from: addDays(ds.endDate, -89), to: ds.endDate }, overrides);
}

export function getCurrentMonthKey(): string {
  return getDataset().endDate.slice(0, 7);
}
