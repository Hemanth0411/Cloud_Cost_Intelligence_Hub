/**
 * The cost, meta, anomaly and alert endpoints, typed.
 *
 * This is the wire layer only: it knows the URLs, the parameter names
 * and the exact shape that comes back. It does not know what a
 * dashboard is. Everything that turns these rows into screen data
 * lives in `lib/live/*`.
 *
 * THREE THINGS ABOUT THE WIRE THAT THE TYPES CANNOT SAY:
 *
 *  * MONEY ARRIVES AS A JSON NUMBER. The backend computes in `Decimal`
 *    (numeric(18,6)) precisely so sub-cent digits survive, and then
 *    FastAPI encodes it with `float()`. So the precision argument is
 *    already lost by the time it reaches us and there is nothing to
 *    preserve here -- but the values must still be read defensively,
 *    because a future encoder change to strings would otherwise turn
 *    every total into `NaN` silently. `num()` accepts both.
 *
 *  * `delta_pct` IS `null`, NEVER `0` OR `Infinity`, when the baseline
 *    period was zero. "No comparison possible" and "no change" are
 *    different facts and the UI renders them differently, so the null
 *    must survive all the way to the component. `pctOrNull` is the
 *    only conversion allowed to touch it.
 *
 *  * EVERY READ CARRIES `as_of`, AND IT CAN BE `null`. It is the finish
 *    time of the last successful ingest, so it is null until one has
 *    run -- which is the state this account is in today. A UI that
 *    formats it unconditionally prints "Invalid Date".
 */
import { get, post } from '@/lib/api/client';
import { reportAsOf } from '@/lib/services/data-status';

// ---------------------------------------------------------------- shapes

/** `api/envelope.py:Envelope`, after camelising. */
export interface Envelope<T> {
  data: T[];
  asOf: string | null;
  metric: string | null;
  currency: string;
  partialPeriod: boolean;
  rowCount: number;
}

/** `GET /cost/series` -- one row per period that HAS data. Empty periods are absent. */
export interface SeriesRow {
  /** Period start, `yyyy-MM-dd`. For `grain=day` this is the day itself. */
  period: string;
  cost: number;
  currency: string;
}

/** `GET /cost/breakdown` -- `key` is the dimension value. */
export interface DimensionRow {
  key: string;
  cost: number;
  currency: string;
}

/** `GET /cost/compare`. */
export interface CompareRow {
  key: string;
  current: number;
  previous: number;
  deltaAbs: number;
  /** Null when the previous period was zero. Never 0, never Infinity. */
  deltaPct: number | null;
}

/** `GET /meta/accounts`. `accountName` is nullable in `dim_account`. */
export interface MetaAccount {
  provider: string;
  accountId: string;
  accountName: string | null;
}

/** `GET /anomalies`. The detector emits step / spike / creep, and rises only. */
export interface FindingRow {
  id: string;
  provider: string;
  accountId: string;
  serviceName: string;
  detectedForDate: string;
  method: string;
  kind: string;
  baselineValue: number;
  observedValue: number;
  deltaAbs: number;
  deltaPct: number | null;
  score: number;
  status: 'new' | 'acknowledged' | 'dismissed';
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
}

/** `GET /alerts/rules`. */
export interface AlertRuleRow {
  id: string;
  name: string;
  type: string;
  scopeProvider: string | null;
  scopeAccount: string | null;
  scopeService: string | null;
  metric: string;
  comparator: string | null;
  thresholdValue: number | null;
  windowDays: number;
  frequency: string;
  channels: string[];
  enabled: boolean;
  createdAt: string;
}

/** `GET /alerts/feed`. `payload` is free-form rule output. */
export interface AlertEventRow {
  id: string;
  ruleId: string;
  ruleName: string;
  type: string;
  firedAt: string;
  observedValue: number | null;
  expectedValue: number | null;
  payload: Record<string, unknown> | null;
  status: string;
  deliveredAt: string | null;
  deliveryError: string | null;
}

// ------------------------------------------------------------ coercion

/** A number from whatever the encoder produced. Non-numeric becomes 0. */
export function num(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** A percentage that stays null. See the note on `delta_pct` above. */
export function pctOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------- requests

export type Grain = 'day' | 'week' | 'month' | 'quarter' | 'year';
export type Dimension = 'provider' | 'account' | 'service' | 'region' | 'charge_category';

/** Provider / account / service narrowing, shared by every cost read. */
export interface CostScope {
  provider?: string;
  accountId?: string;
  service?: string;
}

const scopeQuery = (scope: CostScope): Record<string, string | undefined> => ({
  provider: scope.provider,
  account_id: scope.accountId,
  service: scope.service,
});

export async function fetchSeries(args: CostScope & {
  start: string;
  end: string;
  grain?: Grain;
}): Promise<Envelope<SeriesRow>> {
  const raw = await get<Envelope<Record<string, unknown>>>('/cost/series', {
    query: { start: args.start, end: args.end, grain: args.grain ?? 'day', ...scopeQuery(args) },
  });
  reportAsOf(raw.asOf ?? null);
  return {
    ...raw,
    data: (raw.data ?? []).map((r) => ({
      period: String(r.period ?? ''),
      cost: num(r.cost),
      currency: String(r.currency ?? 'USD'),
    })),
  };
}

export async function fetchBreakdown(args: CostScope & {
  start: string;
  end: string;
  dimension: Dimension;
  limit?: number;
}): Promise<Envelope<DimensionRow>> {
  const raw = await get<Envelope<Record<string, unknown>>>('/cost/breakdown', {
    query: {
      start: args.start,
      end: args.end,
      dimension: args.dimension,
      limit: args.limit ?? 500,
      ...scopeQuery(args),
    },
  });
  reportAsOf(raw.asOf ?? null);
  return {
    ...raw,
    data: (raw.data ?? []).map((r) => ({
      key: String(r.key ?? ''),
      cost: num(r.cost),
      currency: String(r.currency ?? 'USD'),
    })),
  };
}

/**
 * Period-over-period for one dimension.
 *
 * Leaving `previousStart` / `previousEnd` out makes the server use the
 * immediately preceding window of equal length -- the same window
 * `resolveRange` computes for "vs previous", so the two agree without
 * either side being told about the other. The year-ago baseline on
 * /compare is the case that must pass them explicitly.
 */
export async function fetchCompare(args: CostScope & {
  currentStart: string;
  currentEnd: string;
  dimension: Dimension;
  previousStart?: string;
  previousEnd?: string;
}): Promise<Envelope<CompareRow>> {
  const raw = await get<Envelope<Record<string, unknown>>>('/cost/compare', {
    query: {
      current_start: args.currentStart,
      current_end: args.currentEnd,
      dimension: args.dimension,
      previous_start: args.previousStart,
      previous_end: args.previousEnd,
      ...scopeQuery(args),
    },
  });
  reportAsOf(raw.asOf ?? null);
  return {
    ...raw,
    data: (raw.data ?? []).map((r) => ({
      key: String(r.key ?? ''),
      current: num(r.current),
      previous: num(r.previous),
      deltaAbs: num(r.deltaAbs),
      deltaPct: pctOrNull(r.deltaPct),
    })),
  };
}

/** `/meta/accounts` has no `metric` or `partial_period`; only `data` and `as_of`. */
export async function fetchAccounts(): Promise<{ data: MetaAccount[]; asOf: string | null }> {
  const raw = await get<{ data?: MetaAccount[]; asOf?: string | null }>('/meta/accounts');
  reportAsOf(raw.asOf ?? null);
  return { data: raw.data ?? [], asOf: raw.asOf ?? null };
}

export async function fetchFindings(args: {
  status?: 'new' | 'acknowledged' | 'dismissed';
  limit?: number;
} = {}): Promise<{ data: FindingRow[]; asOf: string | null }> {
  const raw = await get<{ data?: Record<string, unknown>[]; asOf?: string | null }>('/anomalies', {
    query: { status: args.status ?? 'new', limit: args.limit ?? 200 },
  });
  const data = (raw.data ?? []).map((r): FindingRow => ({
    id: String(r.id ?? ''),
    provider: String(r.provider ?? ''),
    accountId: String(r.accountId ?? ''),
    serviceName: String(r.serviceName ?? ''),
    detectedForDate: String(r.detectedForDate ?? ''),
    method: String(r.method ?? ''),
    kind: String(r.kind ?? ''),
    baselineValue: num(r.baselineValue),
    observedValue: num(r.observedValue),
    deltaAbs: num(r.deltaAbs),
    deltaPct: pctOrNull(r.deltaPct),
    score: num(r.score),
    status: r.status === 'acknowledged' || r.status === 'dismissed' ? r.status : 'new',
    acknowledgedBy: typeof r.acknowledgedBy === 'string' ? r.acknowledgedBy : null,
    acknowledgedAt: typeof r.acknowledgedAt === 'string' ? r.acknowledgedAt : null,
  }));
  reportAsOf(raw.asOf ?? null);
  return { data, asOf: raw.asOf ?? null };
}

export async function fetchAlertRules(): Promise<AlertRuleRow[]> {
  const raw = await get<{ data?: Record<string, unknown>[] }>('/alerts/rules');
  return (raw.data ?? []).map((r): AlertRuleRow => ({
    id: String(r.id ?? ''),
    name: String(r.name ?? ''),
    type: String(r.type ?? ''),
    scopeProvider: typeof r.scopeProvider === 'string' ? r.scopeProvider : null,
    scopeAccount: typeof r.scopeAccount === 'string' ? r.scopeAccount : null,
    scopeService: typeof r.scopeService === 'string' ? r.scopeService : null,
    metric: String(r.metric ?? 'effective_cost'),
    comparator: typeof r.comparator === 'string' ? r.comparator : null,
    thresholdValue: r.thresholdValue === null || r.thresholdValue === undefined ? null : num(r.thresholdValue),
    windowDays: num(r.windowDays),
    frequency: String(r.frequency ?? ''),
    // `channels` is a jsonb column, so it arrives as an array already.
    channels: Array.isArray(r.channels) ? r.channels.map(String) : [],
    enabled: r.enabled !== false,
    createdAt: String(r.createdAt ?? ''),
  }));
}

/**
 * The in-app feed.
 *
 * `payload` is whatever the rule evaluator wrote, so its KEYS are data
 * and must not be camelised -- the same argument as the audit log's
 * before/after snapshots.
 */
export async function fetchAlertFeed(limit = 100): Promise<{ data: AlertEventRow[]; asOf: string | null }> {
  const raw = await get<{ data?: Record<string, unknown>[]; asOf?: string | null }>('/alerts/feed', {
    query: { limit },
    opaque: ['payload'],
  });
  const data = (raw.data ?? []).map((r): AlertEventRow => ({
    id: String(r.id ?? ''),
    ruleId: String(r.ruleId ?? ''),
    ruleName: String(r.ruleName ?? ''),
    type: String(r.type ?? ''),
    firedAt: String(r.firedAt ?? ''),
    observedValue: r.observedValue === null || r.observedValue === undefined ? null : num(r.observedValue),
    expectedValue: r.expectedValue === null || r.expectedValue === undefined ? null : num(r.expectedValue),
    payload: typeof r.payload === 'object' && r.payload !== null && !Array.isArray(r.payload)
      ? (r.payload as Record<string, unknown>)
      : null,
    status: String(r.status ?? 'new'),
    deliveredAt: typeof r.deliveredAt === 'string' ? r.deliveredAt : null,
    deliveryError: typeof r.deliveryError === 'string' ? r.deliveryError : null,
  }));
  reportAsOf(raw.asOf ?? null);
  return { data, asOf: raw.asOf ?? null };
}

// --------------------------------------------------------------- writes

/**
 * Acknowledge or dismiss a finding.
 *
 * The API answers 404 for a finding the caller may not see, so a 404
 * here is "not yours or not there" and is deliberately not
 * distinguishable -- telling an unauthorized caller that a finding
 * exists is the leak the backend is avoiding.
 */
export function ackFinding(findingId: string, status: 'acknowledged' | 'dismissed'): Promise<unknown> {
  return post(`/anomalies/${encodeURIComponent(findingId)}/ack`, undefined, { query: { status } });
}

/** `POST /anomalies/scan`: what one detection pass did. Superadmin only. */
export interface ScanOutcome {
  seriesScanned: number;
  findings: number;
  created: number;
  updated: number;
}

export async function runDetection(): Promise<ScanOutcome> {
  const raw = await post<Partial<ScanOutcome>>('/anomalies/scan');
  return {
    seriesScanned: Number(raw.seriesScanned ?? 0),
    findings: Number(raw.findings ?? 0),
    created: Number(raw.created ?? 0),
    updated: Number(raw.updated ?? 0),
  };
}

export function markAlertEventRead(eventId: string): Promise<unknown> {
  return post(`/alerts/feed/${encodeURIComponent(eventId)}/read`);
}
