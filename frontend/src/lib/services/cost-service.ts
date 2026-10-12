/**
 * Data-access facade. UI code only talks to this module, never to the
 * mock dataset or to `fetch` directly.
 *
 * Which mode it runs in is decided once per page load by `isMock()`
 * (`lib/mode.ts`), and nothing above this line can tell -- the same
 * contract `admin-service` already follows.
 *
 * THE LIVE ENDPOINTS, BY SCREEN:
 *
 *   loadFilterOptions -> GET /meta/accounts
 *                        GET /cost/breakdown?dimension=service   (per provider)
 *   loadDashboardData -> GET /cost/series?grain=day              (per provider)
 *                        GET /cost/compare?dimension=account
 *                        GET /cost/compare?dimension=service     (per provider)
 *                        GET /anomalies                          (per status)
 *   loadComparison    -> the same, with an explicit baseline window
 *   loadAnomalyData   -> GET /anomalies
 *   loadAlerts        -> GET /alerts/rules, GET /alerts/feed
 *
 * READS ARE ASYNC NOW, IN BOTH MODES. They used to be synchronous
 * because the dataset was a module-level object, and every view
 * already had a `status === 'loading'` branch that could not be
 * reached. Keeping one async shape means the mock path exercises the
 * same loading and error states the live path will hit, instead of
 * them being dead code that breaks the first time it runs.
 *
 * FILTER OPTIONS STAY SYNCHRONOUS, and that is a deliberate
 * exception. Twelve call sites read them during render -- the URL
 * filter parser, the filter bar, `dashboardLink`, the header. Making
 * those async would mean twelve loading states for a list of account
 * names. Instead `<AppDataGate>` loads them once, before any of those
 * components mount, and `getFilterOptions()` reads the cache. Calling
 * it before the gate resolves returns empty options rather than
 * throwing, because React still renders the tree once on the server.
 */
import { ApiError } from '@/lib/api/client';
import { generateInsightReport, type InsightReport } from '@/lib/insights/generate';
import { explainAnomaly, type AnomalyExplanation } from '@/lib/insights/narrative';
import { isMock } from '@/lib/mode';
import { getDataset } from '@/lib/mock/dataset';
import { getAnomalyContext, type AnomalyContext } from '@/lib/selectors/anomaly-context';
import { addDays } from '@/lib/dates';
import type { BudgetAlertSource } from '@/lib/alerts/build';
import { baseConnection } from '@/lib/mock/connections';
import { loadLiveAlerts, EMPTY_LIVE_ALERTS, type LiveAlerts } from '@/lib/live/alerts';
import {
  loadLiveAnomalies,
  scopeLiveAnomalies,
  thresholdsOf,
  writeLiveAnomalyStatus,
} from '@/lib/live/anomalies';
import { loadLiveComparison } from '@/lib/live/comparison';
import { loadLiveDashboard } from '@/lib/live/dashboard';
import { loadLiveOptions, liveDataEnd, type LiveOptions } from '@/lib/live/options';
import { reportAsOf, reportRestricted } from '@/lib/services/data-status';
import { getComparison } from '@/lib/selectors/comparison';
import { getAnomalyViews } from '@/lib/selectors/anomaly-views';
import { getDashboardData } from '@/lib/selectors/dashboard';
import { DEFAULT_ANOMALY_CONFIG, detectAnomalies } from '@/lib/selectors/detect-anomalies';
import { resolveRange } from '@/lib/selectors/range';
import type {
  AnomalyView,
  BaselineKind,
  ComparisonResult,
  DashboardData,
  DetectedAnomalyView,
  Filters,
  FullDashboardData,
  ResolvedRange,
  StatusOverrides,
} from '@/types/analytics';
import type { Account, AccountConnection, AnomalyConfig, AnomalyStatus, DetectedAnomaly, Provider, Service } from '@/types/domain';

/**
 * What the current mode can actually do, so the UI offers only that.
 *
 * Read these instead of calling `isMock()` in a component: the name
 * says WHY the control is missing, which is the thing a reader (and
 * the next person wiring an endpoint) needs.
 *
 * EVALUATED ONCE, AT IMPORT. On the server that is the build default,
 * because `localStorage` does not exist there. Every consumer renders
 * only AFTER an async load has resolved, which happens in the browser
 * where the value is correct, so the server never emits markup that
 * depends on one of these. A component that needs the mode during its
 * FIRST render must use `useMode()` instead, which resolves it in an
 * effect and therefore cannot mismatch the server HTML.
 */
export const COST_CAPABILITIES = {
  /** No budget column exists in any table. */
  budgets: isMock(),
  /** No insight endpoint. Generating prose would need Bedrock -- TODO-18. */
  insights: isMock(),
  /** `dim_service.service_category` is not exposed by any endpoint. */
  serviceCategories: isMock(),
  /** Connect / disconnect / sync are a simulation; no cloud API is called. */
  simulatedConnections: isMock(),
  /** The server detects; its thresholds are not settable from the browser. */
  detectionSettings: isMock(),
  /** Alerts are stored rows, not derived, so nothing can be simulated. */
  simulatedAlerts: isMock(),
  /** `alert_events` has no severity, so preference filtering cannot apply. */
  alertPreferences: isMock(),
} as const;

export interface FilterOptions {
  providers: Provider[];
  accounts: Account[];
  services: Service[];
  /**
   * Which services each account has spend in.
   *
   * NULL means "this source cannot say", not "none". Callers must not
   * turn it into an empty map -- the /services page showed every
   * service as being used by 0 accounts the first time one did.
   */
  serviceIdsByAccount: Record<string, string[]> | null;
  dataStart: string;
  dataEnd: string;
}

/**
 * Options before anything has loaded.
 *
 * `dataEnd` is yesterday rather than the epoch so that a range
 * resolved against it is a real window: an empty `dataEnd` made
 * `resolveRange` produce `Invalid Date` strings during the server
 * render.
 */
function emptyOptions(): FilterOptions {
  const end = liveDataEnd();
  return {
    providers: [],
    accounts: [],
    services: [],
    serviceIdsByAccount: null,
    dataStart: end,
    dataEnd: end,
  };
}

let cachedOptions: FilterOptions | null = null;
let liveOptions: LiveOptions | null = null;

function mockOptions(): FilterOptions {
  const ds = getDataset();
  return {
    providers: ds.providers,
    accounts: ds.accounts,
    services: ds.services,
    serviceIdsByAccount: Object.fromEntries(ds.serviceIdsByAccount),
    dataStart: ds.startDate,
    dataEnd: ds.endDate,
  };
}

/**
 * The cached options. Safe to call at any time, including before
 * `ensureFilterOptions` has resolved -- see the note at the top.
 */
export function getFilterOptions(): FilterOptions {
  if (cachedOptions) return cachedOptions;
  if (isMock()) {
    cachedOptions = mockOptions();
    return cachedOptions;
  }
  return emptyOptions();
}

/**
 * Load the options, once.
 *
 * A 403 is a designed state, not a failure: "a user with no grants
 * receives zero rows". It resolves with empty options and records the
 * restriction so the shell can explain it, because rendering a
 * sign-in loop or an error toast for a correctly-authenticated user
 * is the behaviour `lib/api/client.ts` exists to prevent.
 */
export async function ensureFilterOptions(): Promise<FilterOptions> {
  if (cachedOptions) return cachedOptions;
  if (isMock()) {
    cachedOptions = mockOptions();
    return cachedOptions;
  }
  try {
    const live = await loadLiveOptions();
    liveOptions = live;
    cachedOptions = {
      providers: live.providers,
      accounts: live.accounts,
      services: live.services,
      serviceIdsByAccount: null,
      dataStart: live.dataStart,
      dataEnd: live.dataEnd,
    };
    reportRestricted(false);
  } catch (error) {
    if (!(error instanceof ApiError && error.forbidden)) throw error;
    reportRestricted(true);
    liveOptions = {
      providers: [],
      accounts: [],
      services: [],
      dataStart: emptyOptions().dataStart,
      dataEnd: emptyOptions().dataEnd,
      unknownProviders: [],
    };
    cachedOptions = emptyOptions();
  }
  return cachedOptions;
}

function requireLiveOptions(): LiveOptions {
  if (!liveOptions) {
    throw new Error('Filter options have not loaded yet. <AppDataGate> must resolve first.');
  }
  return liveOptions;
}

/**
 * A read that a 403 should turn into "nothing to show" rather than an
 * error. Every cost read goes through it.
 */
async function tolerateForbidden<T>(read: () => Promise<T>, empty: T): Promise<T> {
  try {
    const value = await read();
    reportRestricted(false);
    return value;
  } catch (error) {
    if (error instanceof ApiError && error.forbidden) {
      reportRestricted(true);
      return empty;
    }
    throw error;
  }
}

// ---- Anomaly detection (mock only) -----------------------------------------------------------

const detectionCache = new Map<string, DetectedAnomaly[]>();

/**
 * Runs (and caches) the client-side detection engine.
 *
 * MOCK ONLY. In live mode the server has already detected, and a
 * second detector over data the browser does not have would simply
 * return nothing -- see `lib/live/anomalies.ts`.
 */
export function getAnomalies(config: AnomalyConfig): DetectedAnomaly[] {
  if (!isMock()) return [];
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

const EMPTY_ANOMALY_PAGE = (range: ResolvedRange): AnomalyPageData => ({
  range,
  anomalies: [],
  totalDetectedAllTime: 0,
});

export async function loadAnomalyData(
  filters: Filters,
  config: AnomalyConfig,
  overrides: StatusOverrides,
): Promise<AnomalyPageData> {
  if (isMock()) {
    const ds = getDataset();
    const detected = getAnomalies(config);
    const range = resolveRange(filters, { start: ds.startDate, end: ds.endDate });
    return {
      range,
      anomalies: getAnomalyViews(ds, detected, filters, range, overrides),
      totalDetectedAllTime: detected.length,
    };
  }

  const options = requireLiveOptions();
  const range = resolveRange(filters, { start: options.dataStart, end: options.dataEnd });
  return tolerateForbidden(async () => {
    const { anomalies, asOf } = await loadLiveAnomalies({
      accountNameById: new Map(options.accounts.map((a) => [a.id, a.name])),
      thresholds: thresholdsOf(config),
    });
    reportAsOf(asOf);
    return {
      range,
      anomalies: scopeLiveAnomalies(anomalies, filters, range, overrides),
      totalDetectedAllTime: anomalies.length,
    };
  }, EMPTY_ANOMALY_PAGE(range));
}

/** Persists a status change. Mock mode keeps it in local state; live mode writes it. */
export async function setAnomalyStatus(id: string, status: AnomalyStatus): Promise<void> {
  if (isMock()) return;
  await writeLiveAnomalyStatus(id, status);
}

/**
 * Narrow an anomaly to one the mock engines can reason about.
 *
 * They multiply by a detection window and divide by a baseline, and
 * an API finding has neither. A runtime check rather than a cast:
 * these three fields are exactly the ones that are null for a live
 * finding, so the check IS the mode test, and it stays correct if a
 * future endpoint starts returning some of them.
 */
function asDetectedView(a: AnomalyView): DetectedAnomalyView | null {
  return a.changePct !== null && a.windowDays !== null && a.impactCost !== null
    ? (a as DetectedAnomalyView)
    : null;
}

/** The same narrowing for a whole dashboard. */
function asFullDashboard(data: DashboardData): FullDashboardData | null {
  if (data.kpis.budget === null || data.kpis.savings === null || data.savings === null) return null;
  if (data.anomalies.some((a) => asDetectedView(a) === null)) return null;
  if (data.accounts.some((a) => a.monthlyBudget === null || a.environment === null)) return null;
  return data as FullDashboardData;
}

export interface Investigation {
  context: AnomalyContext;
  explanation: AnomalyExplanation;
}

/**
 * The evidence curve and the plain-English explanation for one anomaly.
 *
 * Returns null in live mode. The narrative needs the owning team, the
 * service category and the daily usage quantity beside the daily
 * cost; none of those exist in the API, and writing the sentence
 * without them would mean inventing the parts that make it readable.
 * The dialog shows the finding's own figures instead.
 */
export function investigateAnomaly(anomaly: AnomalyView, config: AnomalyConfig): Investigation | null {
  if (!isMock()) return null;
  const detected = asDetectedView(anomaly);
  if (!detected) return null;
  const ds = getDataset();
  const context = getAnomalyContext(ds, detected, getAnomalies(config), config);
  const account = ds.accountById.get(anomaly.accountId);
  const explanation = explainAnomaly({
    anomaly: detected,
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

export async function loadDashboardData(
  filters: Filters,
  statusOverrides: StatusOverrides = {},
  config: AnomalyConfig = DEFAULT_ANOMALY_CONFIG,
): Promise<DashboardData> {
  if (isMock()) {
    return getDashboardData(getDataset(), filters, statusOverrides, getAnomalies(config));
  }

  const options = requireLiveOptions();
  const page = await loadAnomalyData(filters, config, statusOverrides);
  return tolerateForbidden(
    () => loadLiveDashboard({ filters, options, anomalies: page.anomalies }),
    emptyDashboard(filters, options),
  );
}

/** A dashboard with nothing in it, for the 403 path. */
function emptyDashboard(filters: Filters, options: LiveOptions): DashboardData {
  const range = resolveRange(filters, { start: options.dataStart, end: options.dataEnd });
  return {
    range: { ...range, hasPrevious: false },
    kpis: {
      totalSpend: { value: 0, previous: null, deltaPct: null, series: [], avgDaily: 0 },
      previousSpend: { value: null, from: range.prevFrom, to: range.prevTo, changeAbs: null, changePct: null },
      monthToDate: { value: 0, previous: null, deltaPct: null, series: [] },
      forecast: { value: 0, previous: null, deltaPct: null, series: [], daysRemaining: 0, monthLabel: '' },
      budget: null,
      services: { inUse: 0, categories: null },
      anomalies: { active: 0, total: 0, criticalOrHigh: 0 },
      savings: null,
    },
    series: { day: [], week: [], month: [], year: [] },
    comparison: [],
    breakdowns: { provider: [], account: [], service: [] },
    accounts: [],
    anomalies: [],
    savings: null,
  };
}

// ---- AI insights (mock only) -----------------------------------------------------------

export interface InsightBundle {
  report: InsightReport;
  data: DashboardData;
}

/**
 * Null in live mode: there is no insight endpoint and the generator
 * reads the whole fact table. See COST_CAPABILITIES.insights.
 */
export function buildInsightBundle(
  filters: Filters,
  statusOverrides: StatusOverrides,
  config: AnomalyConfig,
): InsightBundle | null {
  if (!isMock()) return null;
  const ds = getDataset();
  const detected = getAnomalies(config);
  const data = getDashboardData(ds, filters, statusOverrides, detected);
  return { report: generateInsightReport(ds, filters, data, detected, config), data };
}

/** Builds the insight report from dashboard data that was already computed. */
export function buildInsightReport(
  filters: Filters,
  data: DashboardData,
  config: AnomalyConfig,
): InsightReport | null {
  if (!isMock()) return null;
  const full = asFullDashboard(data);
  if (!full) return null;
  return generateInsightReport(getDataset(), filters, full, getAnomalies(config), config);
}

// ---- Comparison ----------------------------------------------------------------------------------------

export async function loadComparison(filters: Filters, baseline: BaselineKind): Promise<ComparisonResult> {
  if (isMock()) return getComparison(getDataset(), filters, baseline);
  const options = requireLiveOptions();
  return tolerateForbidden(
    () => loadLiveComparison(filters, baseline, options),
    emptyComparison(filters, baseline, options),
  );
}

function emptyComparison(filters: Filters, baselineKind: BaselineKind, options: LiveOptions): ComparisonResult {
  const range = resolveRange(filters, { start: options.dataStart, end: options.dataEnd });
  return {
    baselineKind,
    range,
    baselineFrom: range.prevFrom,
    baselineTo: range.prevTo,
    hasBaseline: false,
    totals: { current: 0, baseline: 0, diff: 0, diffPct: null, avgCurrent: 0, avgBaseline: 0 },
    points: [],
    providers: [],
    accounts: [],
    services: [],
  };
}

// ---- Alerts ------------------------------------------------------------------------------------

/** Rules and the in-app feed. Empty in mock mode, where alerts are derived instead. */
export async function loadAlerts(): Promise<LiveAlerts> {
  if (isMock()) return EMPTY_LIVE_ALERTS;
  return tolerateForbidden(loadLiveAlerts, EMPTY_LIVE_ALERTS);
}

// ---- Connections and derived alert sources (mock only) -------------------------------------------

const ALL_SCOPE: Filters = { range: '30d', customFrom: null, customTo: null, providerId: 'all', accountId: 'all', serviceId: 'all' };

/**
 * Starting connection state of an account. MOCK ONLY.
 *
 * The live guard is not just tidiness: `getDataset()` generates the
 * whole 40,000-row mock estate on first touch, so an ungated call
 * from live mode would build it for nothing AND hand back an
 * invented status for a real account. Returning a disconnected
 * placeholder is safe because every consumer is gated on
 * `COST_CAPABILITIES.simulatedConnections`; this is the backstop for
 * one that is not.
 */
export function getBaseConnection(accountId: string): AccountConnection {
  if (!isMock()) return { status: 'disconnected', lastSyncedAt: '', changedAt: null };
  const ds = getDataset();
  const account = ds.accountById.get(accountId);
  const provider = account ? ds.providerById.get(account.providerId) : undefined;
  return account && provider
    ? baseConnection(account, provider)
    : { status: 'disconnected', lastSyncedAt: `${ds.endDate}T00:00:00Z`, changedAt: null };
}

let budgetSnapshot: BudgetAlertSource[] | null = null;

/** Month-to-date budget position of every account. MOCK ONLY: nothing stores a budget. */
export function getBudgetSnapshot(): BudgetAlertSource[] {
  if (!isMock()) return [];
  if (budgetSnapshot) return budgetSnapshot;
  const data = getDashboardData(getDataset(), ALL_SCOPE);
  budgetSnapshot = data.accounts.flatMap((a) =>
    a.monthlyBudget === null || a.projectedSpend === null || a.projectedPct === null || a.budgetStatus === null
      ? []
      : [{
          accountId: a.accountId,
          name: a.name,
          providerId: a.providerId,
          projectedSpend: a.projectedSpend,
          monthlyBudget: a.monthlyBudget,
          projectedPct: a.projectedPct,
          status: a.budgetStatus,
        }],
  );
  return budgetSnapshot;
}

/** Anomalies from the last 90 days, for the derived alert feed. MOCK ONLY. */
export function getAlertAnomalies(config: AnomalyConfig, overrides: StatusOverrides): DetectedAnomalyView[] {
  if (!isMock()) return [];
  const ds = getDataset();
  return getAnomalyViews(ds, getAnomalies(config), ALL_SCOPE, { from: addDays(ds.endDate, -89), to: ds.endDate }, overrides);
}

export function getCurrentMonthKey(): string {
  return getFilterOptions().dataEnd.slice(0, 7);
}
