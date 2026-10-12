/**
 * Sanity checks for the mock dataset and selector layer.
 * Run with: npm run verify:data
 */
import { accountsToCsv, anomaliesToCsv, insightsToCsv, savingsToCsv, toCsv, trendToCsv } from '@/lib/export';
import { getDataset } from '@/lib/mock/dataset';
import { anomalyTimeline, DEFAULT_ANOMALY_FILTER, filterAnomalies, getAnomalyViews, summarizeAnomalies } from '@/lib/selectors/anomaly-views';
import { getDashboardData } from '@/lib/selectors/dashboard';
import { ANOMALY_PRESETS, DEFAULT_ANOMALY_CONFIG, detectAnomalies, matchPreset } from '@/lib/selectors/detect-anomalies';
import { resolveRange } from '@/lib/selectors/range';
import { buildInsightBundle, getAnomalies, investigateAnomaly } from '@/lib/services/cost-service';
import { validateConfig } from '@/lib/anomaly-config-fields';
import { workflowActions } from '@/lib/anomaly-workflow';
import { dashboardLink } from '@/lib/links';
import type { AnomalyStatus, Connectivity, NotificationPreferences } from '@/types/domain';
import { passwordStrength, validateConfirm, validateEmail, validateLogin, validateName, validatePassword, validateRegistration, validateReset } from '@/lib/auth/validation';
import { checkResetToken, consumeResetToken, createResetToken, DEMO_ADMIN, findUser, listUsers, randomToken, registerUser, RESET_TOKEN_TTL_MS, signIn, TOKENS_KEY, USERS_KEY, type KeyValueStore } from '@/lib/auth/store';
import { DEMO_CREDENTIALS } from '@/lib/auth/constants';
import { CONNECTION_FIELDS, deriveProviderStatus, sampleConnectionDetails, summarizeConnections, validateConnectionDetails } from '@/lib/connections';
import { formatDateTime, formatRelative } from '@/lib/format';
import { shiftYears } from '@/lib/dates';
import { entitiesFor, getComparison } from '@/lib/selectors/comparison';
import { applyPreferences, buildAlerts, defaultRead, detectionTimestamp, isRead, unreadCount, type AlertSources } from '@/lib/alerts/build';
import { availableActions, transitionFor } from '@/lib/alerts/actions';
import { channelSummary, DEFAULT_PREFERENCES, parsePreferences, severityAtLeast } from '@/lib/alerts/preferences';
import { createSimulatedAlert, createTestAlert } from '@/lib/alerts/simulate';
import { getAlertAnomalies, getBaseConnection, getBudgetSnapshot, getCurrentMonthKey } from '@/lib/services/cost-service';
import { DEMO_NOW_ISO } from '@/lib/clock';
import { EMPTY_ALERT_STATE, parseAlertState } from '@/lib/alerts/state';
import { parseConnectionOverrides } from '@/lib/connections';
import { maskEmail } from '@/lib/auth/validation';
import { isUser } from '@/lib/auth/session';
import type { DashboardData, Filters, Granularity } from '@/types/analytics';

const ds = getDataset();
let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.error(`  FAIL  ${name} ${detail}`);
  }
}
const near = (a: number, b: number, tol = 0.05): boolean => Math.abs(a - b) <= tol;
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const usd = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;
const addDaysIso = (iso: string, n: number): string => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

const base: Filters = { range: '30d', customFrom: null, customTo: null, providerId: 'all', accountId: 'all', serviceId: 'all' };

// --- Dataset integrity -------------------------------------------------------
check('costs are non-empty', ds.costs.length > 0);
check('dataset spans 2024-01-01 -> 2026-10-11', ds.startDate === '2024-01-01' && ds.endDate === '2026-10-11');
check('no non-positive costs', ds.costs.every((c) => c.cost > 0));
const seen = new Set<string>();
let dupes = 0;
for (const c of ds.costs) {
  const k = `${c.date}|${c.accountId}|${c.serviceId}`;
  if (seen.has(k)) dupes += 1;
  seen.add(k);
}
check('no duplicate (date, account, service) rows', dupes === 0, `dupes=${dupes}`);
check('every row maps to known account/service', ds.costs.every((c) => ds.accountById.has(c.accountId) && ds.serviceById.has(c.serviceId)));
check('row provider matches account provider', ds.costs.every((c) => ds.accountById.get(c.accountId)?.providerId === c.providerId));
check('row provider matches service provider', ds.costs.every((c) => ds.serviceById.get(c.serviceId)?.providerId === c.providerId));

// --- Build the filter matrix ----------------------------------------------------
const matrix: Filters[] = [];
for (const range of ['7d', '30d', '90d', 'mtd', 'ytd', '12m'] as const) {
  matrix.push({ ...base, range });
  for (const p of ['aws', 'azure', 'gcp'] as const) matrix.push({ ...base, range, providerId: p });
}
for (const a of ds.accounts) {
  matrix.push({ ...base, providerId: a.providerId, accountId: a.id });
  for (const sid of ds.serviceIdsByAccount.get(a.id) ?? []) {
    matrix.push({ ...base, range: '90d', providerId: a.providerId, accountId: a.id, serviceId: sid });
  }
}
for (const s of ds.services) matrix.push({ ...base, range: 'ytd', serviceId: s.id, providerId: s.providerId });
matrix.push({ ...base, range: 'custom', customFrom: '2025-03-01', customTo: '2025-05-31' });
matrix.push({ ...base, range: 'custom', customFrom: '2026-06-30', customTo: '2026-06-01' }); // reversed on purpose
matrix.push({ ...base, range: 'custom', customFrom: '2024-01-01', customTo: '2024-02-15' }); // no previous period

const rowsFor = (f: Filters, from: string, to: string): number =>
  ds.costs
    .filter(
      (c) =>
        c.date >= from && c.date <= to &&
        (f.providerId === 'all' || c.providerId === f.providerId) &&
        (f.accountId === 'all' || c.accountId === f.accountId) &&
        (f.serviceId === 'all' || c.serviceId === f.serviceId),
    )
    .reduce((a, c) => a + c.cost, 0);

for (const f of matrix) {
  const label = `${f.range}/${f.providerId}/${f.accountId}/${f.serviceId}`;
  const d: DashboardData = getDashboardData(ds, f);
  const total = d.kpis.totalSpend.value;
  const raw = rowsFor(f, d.range.from, d.range.to);

  check(`[${label}] KPI total == raw rows`, near(total, raw), `${total} vs ${raw}`);
  check(`[${label}] daily series sums to total`, near(sum(d.series.day.map((t) => t.total)), total, 0.5));
  check(`[${label}] daily series length == days`, d.series.day.length === d.range.days);
  check(`[${label}] sparkline sums to total`, near(sum(d.kpis.totalSpend.series), total));
  check(`[${label}] provider breakdown sums to total`, near(sum(d.breakdowns.provider.map((p) => p.cost)), total));
  check(`[${label}] account breakdown sums to total`, near(sum(d.breakdowns.account.map((p) => p.cost)), total));
  check(`[${label}] service breakdown sums to total`, near(sum(d.breakdowns.service.map((p) => p.cost)), total));
  check(`[${label}] account table sums to total`, near(sum(d.accounts.map((a) => a.cost)), total));
  check(`[${label}] shares sum to ~100%`, total === 0 || near(sum(d.breakdowns.service.map((p) => p.sharePct)), 100, 0.01));
  check(`[${label}] services KPI == service breakdown size`, d.kpis.services.inUse === d.breakdowns.service.length);
  check(`[${label}] connected accounts KPI == account rows`, d.kpis.accounts.connected === d.accounts.length);
  check(`[${label}] anomalies inside range and scope`,
    d.anomalies.every((a) => a.date >= d.range.from && a.date <= d.range.to &&
      (f.providerId === 'all' || a.providerId === f.providerId) &&
      (f.accountId === 'all' || a.accountId === f.accountId) &&
      (f.serviceId === 'all' || a.serviceId === f.serviceId)));
  check(`[${label}] anomaly KPI total == list`, d.kpis.anomalies.total === d.anomalies.length);
  check(`[${label}] forecast >= MTD`, d.kpis.forecast.value >= d.kpis.monthToDate.value);
  check(`[${label}] budget applicable only without service filter`, d.kpis.budget.applicable === (f.serviceId === 'all'));
  check(`[${label}] account MTD sums to KPI MTD`, near(sum(d.accounts.map((a) => a.mtdSpend)), d.kpis.monthToDate.value));
  check(`[${label}] account projections sum to KPI forecast`, near(sum(d.accounts.map((a) => a.projectedSpend)), d.kpis.forecast.value, 0.5));

  // previous period + comparison
  const prev = d.kpis.previousSpend;
  check(`[${label}] previous-period availability matches range`, (prev.value !== null) === d.range.hasPrevious);
  if (d.range.hasPrevious && prev.value !== null) {
    check(`[${label}] previous spend == raw rows`, near(prev.value, rowsFor(f, d.range.prevFrom, d.range.prevTo)));
    check(`[${label}] change = current - previous`, near(prev.changeAbs ?? NaN, total - prev.value));
    check(`[${label}] comparison previous sums to previous spend`, near(sum(d.comparison.map((c) => c.previous ?? 0)), prev.value, 0.5));
  } else {
    check(`[${label}] comparison has no previous values`, d.comparison.every((c) => c.previous === null));
  }
  check(`[${label}] comparison current sums to total`, near(sum(d.comparison.map((c) => c.current)), total, 0.5));
  check(`[${label}] comparison length == days`, d.comparison.length === d.range.days);

  // savings
  check(`[${label}] savings KPI == sum of opportunities`, d.kpis.savings.monthly === sum(d.savings.map((s) => s.estimatedMonthlySavings)));
  check(`[${label}] savings are non-negative and below run-rate`, d.kpis.savings.monthly >= 0 && d.kpis.savings.pctOfRunRate < 60);
  check(`[${label}] every opportunity range is ordered low <= mid <= high`, d.savings.every((o) => o.rangeLow <= o.estimatedMonthlySavings && o.estimatedMonthlySavings <= o.rangeHigh));
  check(`[${label}] every opportunity states an assumption and evidence`, d.savings.every((o) => o.assumption.length > 20 && o.evidence.length > 0 && o.actions.length > 0));
}

// --- Granularity series (scope-aware, fixed windows) -------------------------------
const gran: Granularity[] = ['week', 'month', 'year'];
for (const f of [base, { ...base, providerId: 'azure' as const }, { ...base, providerId: 'aws' as const, accountId: 'aws-prod-core' }, { ...base, serviceId: 'aws-ec2', providerId: 'aws' as const }]) {
  const d = getDashboardData(ds, f);
  for (const g of gran) {
    const pts = d.series[g];
    const from = pts[0]?.start ?? '';
    const to = pts[pts.length - 1]?.end ?? '';
    const lastDay = to > ds.endDate ? ds.endDate : to;
    const raw = rowsFor(f, from < ds.startDate ? ds.startDate : from, lastDay);
    check(`[${g}/${f.providerId}/${f.accountId}/${f.serviceId}] bucket sum == raw rows in window`, near(sum(pts.map((p) => p.total)), raw, 1), `${sum(pts.map((p) => p.total))} vs ${raw}`);
    check(`[${g}] buckets are contiguous`, pts.every((p, i) => i === 0 || p.start > (pts[i - 1]?.end ?? '')));
    check(`[${g}] provider split sums to bucket total`, pts.every((p) => near(p.aws + p.azure + p.gcp, p.total, 0.02)));
  }
  check('week series has 26 buckets', d.series.week.length === 26);
  check('month series has 12 buckets', d.series.month.length === 12);
  check('year series covers 2024-2026', d.series.year.map((p) => p.start.slice(0, 4)).join() === '2024,2025,2026');
  check('current month is flagged partial', d.series.month[11]?.partial === true && d.series.month[10]?.partial === false);
  check('current year is flagged partial, 2025 is not', d.series.year[2]?.partial === true && d.series.year[1]?.partial === false);
}
{
  const all = getDashboardData(ds, base);
  const everything = ds.costs.reduce((a, c) => a + c.cost, 0);
  check('yearly series sums to the whole dataset', near(sum(all.series.year.map((p) => p.total)), everything, 1));
}

// --- Dependent filter data -------------------------------------------------------------
check('every account has a service list', ds.accounts.every((a) => (ds.serviceIdsByAccount.get(a.id)?.length ?? 0) > 0));

// --- Anomaly engine ----------------------------------------------------------------------------
const kinds = new Set(ds.anomalies.map((a) => a.kind));
check('all four anomaly kinds are detected', kinds.size === 4, [...kinds].join());
check('anomaly detection finds 40+ incidents across history', ds.anomalies.length >= 40, `found ${ds.anomalies.length}`);
check('anomaly ids are unique', new Set(ds.anomalies.map((a) => a.id)).size === ds.anomalies.length);
const years = new Set(ds.anomalies.map((a) => a.date.slice(0, 4)));
check('anomalies exist in 2024, 2025 and 2026', years.has('2024') && years.has('2025') && years.has('2026'), [...years].join());
check('detection is deterministic (re-run is identical)', JSON.stringify(detectAnomalies(ds.costs, ds.endDate, DEFAULT_ANOMALY_CONFIG)) === JSON.stringify(ds.anomalies));
check('every anomaly is internally coherent', ds.anomalies.every((a) =>
  near(a.differenceCost, a.observedCost - a.expectedCost, 0.02) &&
  near(a.impactCost, a.differenceCost * a.windowDays, 0.05) &&
  (a.differenceCost >= 0) === (a.changePct >= 0) &&
  near(a.changePct, (a.differenceCost / a.expectedCost) * 100, 0.1) &&
  a.expectedCost > 0 && a.observedCost > 0));
check('spikes/increases are positive, drops/decreases negative', ds.anomalies.every((a) => (a.kind === 'spike' || a.kind === 'sustained-increase') === (a.differenceCost > 0)));
check('sustained findings use the 7-day window, single-day ones use 1', ds.anomalies.every((a) => a.windowDays === (a.kind.startsWith('sustained') ? 7 : 1)));
check('every anomaly maps to a known account, service and matching provider', ds.anomalies.every((a) => ds.accountById.get(a.accountId)?.providerId === a.providerId && ds.serviceById.get(a.serviceId)?.providerId === a.providerId));
check('no single-day flag duplicates a confirmed level shift (same series, within 7 days before)', ds.anomalies.filter((a) => a.kind.startsWith('sustained')).every((s) =>
  !ds.anomalies.some((x) => x.id !== s.id && x.accountId === s.accountId && x.serviceId === s.serviceId && x.kind === (s.kind === 'sustained-increase' ? 'spike' : 'drop') && x.date <= s.date && x.date > addDaysIso(s.date, -7))));
check('dev weekend dips are not reported as drops', !ds.anomalies.some((a) => a.kind === 'drop' && ds.accountById.get(a.accountId)?.environment === 'development' && a.changePct > -45 && a.changePct < -35));
check('severity thresholds are respected (critical >= high >= medium impact/pct rule)', ds.anomalies.every((a) => {
  const t = DEFAULT_ANOMALY_CONFIG.severity;
  const p = Math.abs(a.changePct), d = Math.abs(a.impactCost);
  const expected = p >= t.criticalPct || d >= t.criticalImpact ? 'critical' : p >= t.highPct || d >= t.highImpact ? 'high' : p >= t.mediumPct || d >= t.mediumImpact ? 'medium' : 'low';
  return a.severity === expected;
}));

// configurable thresholds actually change behaviour, monotonically
const nCons = detectAnomalies(ds.costs, ds.endDate, ANOMALY_PRESETS.conservative).length;
const nBal = detectAnomalies(ds.costs, ds.endDate, ANOMALY_PRESETS.balanced).length;
const nSens = detectAnomalies(ds.costs, ds.endDate, ANOMALY_PRESETS.sensitive).length;
check('sensitivity is monotonic: conservative <= balanced <= sensitive', nCons <= nBal && nBal <= nSens, `${nCons}/${nBal}/${nSens}`);
check('presets produce different results', nCons < nSens);
check('preset matching works', matchPreset(ANOMALY_PRESETS.sensitive) === 'sensitive' && matchPreset({ ...DEFAULT_ANOMALY_CONFIG, spikeSigma: 9 }) === 'custom');
check('an extreme config detects nothing', detectAnomalies(ds.costs, ds.endDate, { ...DEFAULT_ANOMALY_CONFIG, spikeMinPct: 5000, dropMinPct: 5000, sustainedIncreasePct: 5000, sustainedDecreasePct: 5000 }).length === 0);
check('facade returns cached default and custom configs', getAnomalies(DEFAULT_ANOMALY_CONFIG) === ds.anomalies && getAnomalies(ANOMALY_PRESETS.sensitive).length === nSens);

// filters, summary, timeline
{
  const r = resolveRange(base, { start: ds.startDate, end: ds.endDate });
  const wide = resolveRange({ ...base, range: '12m' }, { start: ds.startDate, end: ds.endDate });
  const views = getAnomalyViews(ds, ds.anomalies, base, wide);
  const sum0 = summarizeAnomalies(views);
  check('summary totals match', sum0.total === views.length && Object.values(sum0.bySeverity).reduce((a, b) => a + b, 0) === views.length && Object.values(sum0.byStatus).reduce((a, b) => a + b, 0) === views.length && Object.values(sum0.byKind).reduce((a, b) => a + b, 0) === views.length);
  for (const sev of ['critical', 'high', 'medium', 'low'] as const) {
    check(`severity filter '${sev}' returns only ${sev}`, filterAnomalies(views, { ...DEFAULT_ANOMALY_FILTER, severity: sev }).every((a) => a.severity === sev) && filterAnomalies(views, { ...DEFAULT_ANOMALY_FILTER, severity: sev }).length === sum0.bySeverity[sev]);
  }
  for (const st of ['open', 'investigating', 'acknowledged', 'resolved', 'dismissed'] as const) {
    check(`status filter '${st}' matches summary`, filterAnomalies(views, { ...DEFAULT_ANOMALY_FILTER, status: st }).length === sum0.byStatus[st]);
  }
  check("status filter 'active' == summary.active", filterAnomalies(views, { ...DEFAULT_ANOMALY_FILTER, status: 'active' }).length === sum0.active);
  for (const k of ['spike', 'drop', 'sustained-increase', 'sustained-decrease'] as const) {
    check(`kind filter '${k}' matches summary`, filterAnomalies(views, { ...DEFAULT_ANOMALY_FILTER, kind: k }).length === sum0.byKind[k]);
  }
  check('combined filters intersect', filterAnomalies(views, { severity: 'high', status: 'active', kind: 'spike' }).every((a) => a.severity === 'high' && a.kind === 'spike' && a.status !== 'resolved' && a.status !== 'dismissed'));
  const tl = anomalyTimeline(views, wide);
  check('timeline buckets account for every anomaly', tl.reduce((a, b) => a + b.total, 0) === views.length);
  check('timeline severity split sums to bucket totals', tl.every((b) => b.critical + b.high + b.medium + b.low === b.total));
  check('account/service filters narrow anomalies', getAnomalyViews(ds, ds.anomalies, { ...base, accountId: 'aws-prod-core', providerId: 'aws' }, wide).every((a) => a.accountId === 'aws-prod-core'));
  const od = getAnomalyViews(ds, ds.anomalies, base, r, { [views[0]?.id ?? '']: 'dismissed' });
  check('status overrides apply through views', od.every((a) => a.id !== views[0]?.id || a.status === 'dismissed'));
}

// --- Workflow overrides feed dashboard + insights -----------------------------------------------------
{
  const d0 = getDashboardData(ds, base);
  const target = d0.anomalies.find((a) => a.status === 'open');
  check('there is an open anomaly to act on', target !== undefined);
  if (target) {
    const d1 = getDashboardData(ds, base, { [target.id]: 'resolved' });
    check('resolving lowers the active count by exactly 1', d1.kpis.anomalies.active === d0.kpis.anomalies.active - 1);
    check('resolving keeps the detected total', d1.kpis.anomalies.total === d0.kpis.anomalies.total);
    check('resolving an anomaly lowers (or keeps) potential savings', d1.kpis.savings.monthly <= d0.kpis.savings.monthly);
    check('overrides do not alter spend figures', d1.kpis.totalSpend.value === d0.kpis.totalSpend.value);
    const d2 = getDashboardData(ds, base, { [target.id]: 'investigating' });
    check("'investigating' still counts as active", d2.kpis.anomalies.active === d0.kpis.anomalies.active);
    const ins0 = buildInsightBundle(base, {}, DEFAULT_ANOMALY_CONFIG).report.insights.filter((i) => i.kind === 'anomaly');
    const ins1 = buildInsightBundle(base, Object.fromEntries(d0.anomalies.map((a) => [a.id, 'resolved' as const])), DEFAULT_ANOMALY_CONFIG).report.insights.filter((i) => i.kind === 'anomaly');
    check('anomaly insights exist, and vanish when every anomaly is resolved', ins0.length > 0 && ins1.length === 0, `${ins0.length}/${ins1.length}`);
  }
}

// --- Insight engine ---------------------------------------------------------------------------------------
{
  const BAD = /NaN|undefined|Infinity|null|\[object/;
  const scopes: Filters[] = [
    base,
    { ...base, range: '90d' }, { ...base, range: '7d' }, { ...base, range: '12m' }, { ...base, range: 'ytd' }, { ...base, range: 'mtd' },
    { ...base, range: 'custom', customFrom: '2025-03-01', customTo: '2025-05-31' },
    { ...base, range: 'custom', customFrom: '2024-01-01', customTo: '2024-02-15' },
    { ...base, providerId: 'aws' }, { ...base, providerId: 'azure' }, { ...base, providerId: 'gcp' },
    { ...base, providerId: 'aws', accountId: 'aws-prod-core' },
    { ...base, providerId: 'azure', accountId: 'azure-ai-services', serviceId: 'azure-openai' },
    { ...base, serviceId: 'gcp-bigquery', providerId: 'gcp' },
  ];
  for (const f of scopes) {
    const label = `${f.range}/${f.providerId}/${f.accountId}/${f.serviceId}`;
    const a = buildInsightBundle(f, {}, DEFAULT_ANOMALY_CONFIG);
    const b = buildInsightBundle(f, {}, DEFAULT_ANOMALY_CONFIG);
    check(`[insights ${label}] deterministic`, JSON.stringify(a.report) === JSON.stringify(b.report));
    const r = a.report;
    check(`[insights ${label}] headline mentions spend`, /\$[\d.]+[KMB]?/.test(r.headline) && !BAD.test(r.headline), r.headline);
    check(`[insights ${label}] has insights`, r.insights.length >= 1);
    check(`[insights ${label}] unique ids`, new Set(r.insights.map((i) => i.id)).size === r.insights.length);
    check(`[insights ${label}] sorted by priority`, r.insights.every((i, k) => k === 0 || ['high', 'medium', 'low'].indexOf((r.insights[k - 1] ?? i).priority) <= ['high', 'medium', 'low'].indexOf(i.priority)));
    const text = r.insights.map((i) => [i.title, i.summary, ...i.evidence.flatMap((e) => [e.label, e.value]), ...i.investigateNext, ...i.recommendedActions].join(' ')).join(' ');
    check(`[insights ${label}] no NaN/undefined/null in generated text`, !BAD.test(text), (text.match(BAD) ?? [''])[0]);
    check(`[insights ${label}] each insight has evidence, next steps and actions`, r.insights.every((i) => i.evidence.length > 0 && i.investigateNext.length > 0 && i.recommendedActions.length > 0 && i.summary.length > 40));
    const anomalyIds = new Set(a.data.anomalies.map((x) => x.id));
    check(`[insights ${label}] related anomalies exist in scope`, r.insights.every((i) => i.relatedAnomalyIds.every((id) => anomalyIds.has(id))));
    check(`[insights ${label}] related accounts/services exist`, r.insights.every((i) => i.relatedAccountIds.every((id) => ds.accountById.has(id)) && i.relatedServiceIds.every((id) => ds.serviceById.has(id))));
    check(`[insights ${label}] optimization text labels savings as estimates`, r.insights.filter((i) => i.kind === 'optimization').every((i) => /estimate/i.test(i.summary)));
    check(`[insights ${label}] no root-cause claims`, !/\b(caused by|because of a|due to a|root cause is)\b/i.test(text), (text.match(/\b(caused by|because of a|due to a|root cause is)\b/i) ?? [''])[0]);
  }
  const main = buildInsightBundle(base, {}, DEFAULT_ANOMALY_CONFIG);
  const change = main.report.insights.find((i) => i.kind === 'change');
  check('change insight names a contributing account and service', !!change && change.relatedAccountIds.length === 1 && change.relatedServiceIds.length === 1);
  check('change insight cites the same total as the KPI', !!change && change.evidence[0]?.label === 'This period');
  check('different scope changes the insight text', buildInsightBundle({ ...base, providerId: 'aws' }, {}, DEFAULT_ANOMALY_CONFIG).report.headline !== main.report.headline);
  check('insights CSV rows == insights', insightsToCsv(main.report.insights).split('\r\n').length >= main.report.insights.length + 1);
}

// --- Workflow rules, links, settings validation, investigation text ------------------------------
{
  const statuses: AnomalyStatus[] = ['open', 'investigating', 'acknowledged', 'resolved', 'dismissed'];
  for (const st of statuses) {
    const acts = workflowActions(st);
    check(`workflow '${st}' offers actions and never targets itself`, acts.length > 0 && acts.every((a) => a.to !== st));
  }
  check('resolved/dismissed can only be reopened', ['resolved', 'dismissed'].every((st) => workflowActions(st as AnomalyStatus).map((a) => a.to).join() === 'open'));
  check('active anomalies can reach resolved and dismissed', (['open', 'investigating', 'acknowledged'] as const).every((st) => workflowActions(st).some((a) => a.to === 'resolved') || st === 'open'));
  check('open anomalies can start investigating, acknowledge or dismiss', workflowActions('open').map((a) => a.to).join() === 'investigating,acknowledged,dismissed');
  check('every status is reachable in the workflow', statuses.every((st) => st === 'open' ? workflowActions('resolved').some((a) => a.to === 'open') : statuses.some((from) => workflowActions(from).some((a) => a.to === st))));

  check('link: account sets provider + account', dashboardLink({ accountId: 'aws-prod-core' }) === '/dashboard?provider=aws&account=aws-prod-core');
  check('link: service-only sets provider + service', dashboardLink({ serviceId: 'gcp-bigquery' }) === '/dashboard?provider=gcp&service=gcp-bigquery');
  check('link: account + valid service keeps both', dashboardLink({ accountId: 'aws-prod-core', serviceId: 'aws-ec2' }) === '/dashboard?provider=aws&account=aws-prod-core&service=aws-ec2');
  check('link: service not used by the account is dropped', dashboardLink({ accountId: 'aws-prod-core', serviceId: 'aws-sagemaker' }) === '/dashboard?provider=aws&account=aws-prod-core');
  check('link: no filters -> plain dashboard', dashboardLink({}) === '/dashboard');

  check('default and preset configs validate', validateConfig(DEFAULT_ANOMALY_CONFIG).length === 0 && (['conservative', 'balanced', 'sensitive'] as const).every((p) => validateConfig(ANOMALY_PRESETS[p]).length === 0));
  check('out-of-range values are rejected', validateConfig({ ...DEFAULT_ANOMALY_CONFIG, spikeMinPct: 1 }).length > 0 && validateConfig({ ...DEFAULT_ANOMALY_CONFIG, dropMinPct: 150 }).length > 0 && validateConfig({ ...DEFAULT_ANOMALY_CONFIG, baselineDays: 3 }).length > 0);
  check('NaN (empty input) is rejected', validateConfig({ ...DEFAULT_ANOMALY_CONFIG, minDailyDelta: Number.NaN }).length > 0);
  check('severity thresholds must increase', validateConfig({ ...DEFAULT_ANOMALY_CONFIG, severity: { ...DEFAULT_ANOMALY_CONFIG.severity, mediumPct: 200 } }).length > 0 && validateConfig({ ...DEFAULT_ANOMALY_CONFIG, severity: { ...DEFAULT_ANOMALY_CONFIG.severity, highImpact: 100 } }).length > 0);

  // Every detected anomaly can be investigated, with clean text and sane evidence.
  const wide = resolveRange({ ...base, range: 'custom', customFrom: ds.startDate, customTo: ds.endDate }, { start: ds.startDate, end: ds.endDate });
  const everyView = getAnomalyViews(ds, ds.anomalies, base, wide);
  check('the whole history is available as anomaly views', everyView.length === ds.anomalies.length);
  let badText = 0, badContext = 0, badShare = 0, noSteps = 0;
  for (const v of everyView) {
    const inv = investigateAnomaly(v, DEFAULT_ANOMALY_CONFIG);
    const text = [inv.explanation.headline, inv.explanation.whatChanged, inv.explanation.contribution ?? '', inv.explanation.usageNote ?? '', inv.explanation.concurrentNote ?? '', ...inv.explanation.investigateNext, ...inv.explanation.recommendedActions, ...inv.explanation.evidence.map((e) => `${e.label} ${e.value}`)].join(' ');
    if (/NaN|undefined|Infinity|null|\[object/.test(text)) badText += 1;
    if (inv.context.points.length < 8 || !inv.context.points.some((p) => p.date === v.date)) badContext += 1;
    const c = inv.context.account.contributionPct;
    if (c !== null && (c < 0 || c > 100)) badShare += 1;
    if (inv.explanation.investigateNext.length === 0 || inv.explanation.recommendedActions.length === 0) noSteps += 1;
  }
  check('every anomaly explanation is free of NaN/undefined', badText === 0, `${badText} bad`);
  check('every anomaly has a context curve containing its detection date', badContext === 0, `${badContext} bad`);
  check('account contribution share stays within 0-100%', badShare === 0, `${badShare} bad`);
  check('every anomaly has investigate/action guidance', noSteps === 0);
  const sample = everyView.find((v) => v.kind === 'sustained-increase');
  if (sample) {
    const inv = investigateAnomaly(sample, DEFAULT_ANOMALY_CONFIG);
    check('sustained explanation mentions the monthly run-rate', /per month/.test(inv.explanation.whatChanged));
    check('sustained context window starts 6 days before detection', inv.context.windowStart < sample.date);
  }
  const decrease = everyView.find((v) => v.kind === 'drop');
  if (decrease) {
    const inv = investigateAnomaly(decrease, DEFAULT_ANOMALY_CONFIG);
    check('drop explanation warns it may signal an outage rather than savings', /outage/i.test(inv.explanation.investigateNext.join(' ')));
    check('drop explanation uses the word "below"', /below/.test(inv.explanation.whatChanged));
  }
}

// --- Simulated authentication ---------------------------------------------------------------------------------
function memoryStore(): KeyValueStore & { dump(): string } {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); }, dump: () => JSON.stringify([...m]) };
}
{
  check('email: empty/invalid/valid', validateEmail('') !== null && validateEmail('a@b') !== null && validateEmail('no at.com') !== null && validateEmail('  a@b.co ') === null);
  check('name rules', validateName('') !== null && validateName('A') !== null && validateName('Al') === null && validateName('x'.repeat(61)) !== null);
  check('password policy: length, letter and number required', validatePassword('') !== null && validatePassword('short1') !== null && validatePassword('longpassword') !== null && validatePassword('12345678') !== null && validatePassword('Passw0rd!') === null && validatePassword(DEMO_CREDENTIALS.password) === null);
  check('confirm must match', validateConfirm('a', '') !== null && validateConfirm('abc', 'abd') !== null && validateConfirm('abc', 'abc') === null);
  check('strength meter is monotone and labelled', passwordStrength('abc').label === 'Too short' && passwordStrength('abcdefg1').score === 1 && passwordStrength('Abcdefg1').score === 2 && passwordStrength('Abcdefg1!xyz').label === 'Strong' && passwordStrength(DEMO_CREDENTIALS.password).score === 4);
  check('login validation requires both fields', Object.keys(validateLogin({ email: '', password: '' })).length === 2 && Object.keys(validateLogin({ email: 'a@b.co', password: 'x' })).length === 0);
  check('registration validation reports every problem', Object.keys(validateRegistration({ name: '', email: 'x', password: 'a', confirm: 'b', acceptedDemoTerms: false })).length === 5 && Object.keys(validateRegistration({ name: 'Sam', email: 'sam@x.io', password: 'Passw0rd1', confirm: 'Passw0rd1', acceptedDemoTerms: true })).length === 0);
  check('reset validation', Object.keys(validateReset({ password: 'a', confirm: 'b' })).length === 2 && Object.keys(validateReset({ password: 'Passw0rd1', confirm: 'Passw0rd1' })).length === 0);

  const store = memoryStore();
  const t0 = Date.UTC(2026, 9, 12, 5, 0, 0);
  const reg = registerUser(store, { name: '  Sam Lee ', email: 'Sam.Lee@Example.com', role: 'Engineer' }, t0);
  check('registration succeeds and normalizes the email', reg.ok && reg.user.email === 'sam.lee@example.com' && reg.user.name === 'Sam Lee');
  check('registered user can be found case-insensitively', findUser(store, 'SAM.LEE@example.com')?.name === 'Sam Lee' && listUsers(store).length === 1);
  check('duplicate email is rejected', !registerUser(store, { name: 'Other', email: 'sam.lee@example.com', role: 'Engineer' }, t0).ok);
  check('the built-in demo email cannot be registered', !registerUser(store, { name: 'X Y', email: DEMO_ADMIN.email.toUpperCase(), role: 'Admin' }, t0).ok);
  check('NO password material is ever written to storage', !store.dump().toLowerCase().includes('passw0rd') && !/password/i.test(store.getItem(USERS_KEY) ?? ''));

  check('demo admin signs in with the documented credentials', signIn(store, DEMO_CREDENTIALS.email, DEMO_CREDENTIALS.password).ok);
  check('demo admin rejects a wrong password', !signIn(store, DEMO_CREDENTIALS.email, 'WrongPassword1').ok);
  check('registered account signs in with a policy-compliant password (none is stored)', signIn(store, 'sam.lee@example.com', 'Whatever123').ok);
  check('registered account rejects a non-compliant password', !signIn(store, 'sam.lee@example.com', 'short').ok);
  const unknown = signIn(store, 'nobody@example.com', 'Whatever123');
  const wrong = signIn(store, DEMO_CREDENTIALS.email, 'nope-nope-1');
  check('unknown email and wrong password give the same message (no user enumeration)', !unknown.ok && !wrong.ok && unknown.error === wrong.error);

  for (let i = 0; i < 30; i += 1) registerUser(store, { name: `User ${i}`, email: `u${i}@example.com`, role: 'Viewer' }, t0);
  check('registered demo accounts are capped', listUsers(store).length === 25);

  const s2 = memoryStore();
  registerUser(s2, { name: 'Sam Lee', email: 'sam@x.io', role: 'Engineer' }, t0);
  check('reset: unknown email yields no token', createResetToken(s2, 'ghost@x.io', t0) === null);
  const tok = createResetToken(s2, 'SAM@x.io', t0, () => 'a'.repeat(32));
  check('reset: known email yields a token expiring in 15 minutes', tok !== null && tok.expiresAt - t0 === RESET_TOKEN_TTL_MS && RESET_TOKEN_TTL_MS === 900000);
  check('reset: token is valid before expiry', checkResetToken(s2, 'a'.repeat(32), t0 + 60_000).status === 'valid');
  check('reset: token expires', checkResetToken(s2, 'a'.repeat(32), t0 + RESET_TOKEN_TTL_MS + 1).status === 'expired');
  check('reset: unknown token is invalid', checkResetToken(s2, 'b'.repeat(32), t0).status === 'invalid');
  check('reset: consuming works once, then the token is used', consumeResetToken(s2, 'a'.repeat(32), t0).status === 'valid' && consumeResetToken(s2, 'a'.repeat(32), t0).status === 'used');
  check('reset: an expired token cannot be consumed', consumeResetToken(s2, 'a'.repeat(32), t0 + RESET_TOKEN_TTL_MS + 5).status === 'used');
  createResetToken(s2, 'sam@x.io', t0, () => 'c'.repeat(32));
  createResetToken(s2, 'sam@x.io', t0 + 1000, () => 'd'.repeat(32));
  check('reset: a new request supersedes the earlier token', checkResetToken(s2, 'c'.repeat(32), t0 + 2000).status === 'invalid' && checkResetToken(s2, 'd'.repeat(32), t0 + 2000).status === 'valid');
  check('reset: the demo admin can request a reset', createResetToken(s2, DEMO_ADMIN.email, t0) !== null);
  check('reset tokens are random 32-hex strings', /^[0-9a-f]{32}$/.test(randomToken()) && randomToken() !== randomToken());
  check('reset storage holds no password material', !/password/i.test(s2.getItem(TOKENS_KEY) ?? ''));
  const broken = memoryStore(); broken.setItem(USERS_KEY, '{not json'); broken.setItem(TOKENS_KEY, '[1,2,3]');
  check('corrupt storage degrades gracefully', listUsers(broken).length === 0 && checkResetToken(broken, 'x', t0).status === 'invalid');
}

// --- Connections ------------------------------------------------------------------------------------------------
{
  check('provider status roll-up', deriveProviderStatus(['connected', 'connected']) === 'connected' && deriveProviderStatus(['connected', 'degraded']) === 'degraded' && deriveProviderStatus(['connected', 'disconnected']) === 'degraded' && deriveProviderStatus(['disconnected', 'disconnected']) === 'disconnected' && deriveProviderStatus([]) === 'disconnected');
  const statuses: Record<string, Connectivity> = Object.fromEntries(ds.accounts.map((a) => [a.id, getBaseConnection(a.id).status]));
  const summary = summarizeConnections(ds.accounts, (id) => statuses[id] ?? 'disconnected');
  check('base connection: AWS/Azure healthy, GCP degraded', ds.accounts.every((a) => statuses[a.id] === (a.providerId === 'gcp' ? 'degraded' : 'connected')));
  check('summary counts add up', summary.healthy + summary.degraded + summary.disconnected === ds.accounts.length && summary.linked === summary.healthy + summary.degraded && summary.providers === 3 && summary.degradedProviders === 1);
  const after = summarizeConnections(ds.accounts, (id) => (id === 'aws-sandbox' ? 'disconnected' : (statuses[id] ?? 'disconnected')));
  check('disconnecting an account lowers the linked count by one', after.linked === summary.linked - 1 && after.disconnected === 1);
  check('base sync times are valid ISO timestamps and deterministic', ds.accounts.every((a) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(getBaseConnection(a.id).lastSyncedAt) && getBaseConnection(a.id).lastSyncedAt === getBaseConnection(a.id).lastSyncedAt));
  check('sample connection details are valid for every account', ds.accounts.every((a) => Object.keys(validateConnectionDetails(a.providerId, sampleConnectionDetails(a))).length === 0), ds.accounts.map((a) => JSON.stringify(validateConnectionDetails(a.providerId, sampleConnectionDetails(a)))).join());
  check('sample details cover every form field', ds.accounts.every((a) => CONNECTION_FIELDS[a.providerId].every((f) => (sampleConnectionDetails(a)[f.key] ?? '') !== '')));
  check('invalid connection details are rejected', Object.keys(validateConnectionDetails('aws', { roleArn: 'arn:aws:iam::123:role/x' })).length === 1 && Object.keys(validateConnectionDetails('azure', { tenantId: 'x', subscriptionId: '' })).length === 2 && Object.keys(validateConnectionDetails('gcp', { projectId: 'Bad_Project' })).length === 1 && Object.keys(validateConnectionDetails('aws', {})).length === 1);
}

// --- Time formatting -----------------------------------------------------------------------------------------------
{
  const now = new Date('2026-10-12T04:30:00Z');
  check('relative: seconds/minutes/hours/days/dates', formatRelative('2026-10-12T04:29:40Z', now) === 'just now' && formatRelative('2026-10-12T04:25:00Z', now) === '5 min ago' && formatRelative('2026-10-12T01:30:00Z', now) === '3 h ago' && formatRelative('2026-10-10T04:30:00Z', now) === '2 d ago' && formatRelative('2026-09-20T04:30:00Z', now) === 'Sep 20, 2026' && formatRelative('2026-10-12T05:00:00Z', now) === 'just now');
  check('absolute timestamps are UTC and labelled', formatDateTime('2026-10-12T04:05:00Z') === 'Oct 12, 2026, 04:05 UTC');
  check('year shifting handles leap days', shiftYears('2026-10-11', -1) === '2025-10-11' && shiftYears('2024-02-29', 1) === '2025-02-28' && shiftYears('2024-02-29', 4) === '2028-02-29');
}

// --- Comparison (reconciles with the dashboard) ---------------------------------------------------------------------
{
  const scopes: Filters[] = [
    base, { ...base, range: '7d' }, { ...base, range: '90d' }, { ...base, range: 'mtd' }, { ...base, range: 'ytd' }, { ...base, range: '12m' },
    { ...base, providerId: 'aws' }, { ...base, providerId: 'azure', accountId: 'azure-ai-services' },
    { ...base, providerId: 'gcp', accountId: 'gcp-customer-web', serviceId: 'gcp-gke' }, { ...base, serviceId: 'aws-ec2', providerId: 'aws' },
    { ...base, range: 'custom', customFrom: '2025-03-01', customTo: '2025-05-31' },
  ];
  for (const f of scopes) {
    const label = `${f.range}/${f.providerId}/${f.accountId}/${f.serviceId}`;
    const d = getDashboardData(ds, f);
    const c = getComparison(ds, f, 'previous');
    check(`[compare ${label}] current total == dashboard KPI`, near(c.totals.current, d.kpis.totalSpend.value));
    check(`[compare ${label}] baseline == dashboard previous period`, c.hasBaseline === d.range.hasPrevious && near(c.totals.baseline, d.kpis.previousSpend.value ?? 0));
    check(`[compare ${label}] diff and % match the dashboard`, near(c.totals.diff, d.kpis.previousSpend.changeAbs ?? 0, 0.05) && (c.totals.diffPct === null ? d.kpis.previousSpend.changePct === null : near(c.totals.diffPct, d.kpis.previousSpend.changePct ?? NaN, 0.001)));
    const pairs: Array<[string, typeof c.providers, typeof d.breakdowns.provider]> = [['provider', c.providers, d.breakdowns.provider], ['account', c.accounts, d.breakdowns.account], ['service', c.services, d.breakdowns.service]];
    for (const [name, mine, theirs] of pairs) {
      check(`[compare ${label}] ${name} current costs equal dashboard breakdown`, mine.length === theirs.length && theirs.every((t) => near(mine.find((m) => m.id === t.id)?.current ?? NaN, t.cost)));
      check(`[compare ${label}] ${name} baseline costs equal dashboard previous costs`, theirs.every((t) => near(mine.find((m) => m.id === t.id)?.baseline ?? NaN, c.hasBaseline ? t.previousCost : 0)));
      check(`[compare ${label}] ${name} entities sum to totals`, near(sum(mine.map((m) => m.current)), c.totals.current) && near(sum(mine.map((m) => m.baseline)), c.totals.baseline));
      check(`[compare ${label}] ${name} diffs sum to the total diff`, near(sum(mine.map((m) => m.diff)), c.totals.diff, 0.1));
      check(`[compare ${label}] ${name} diffPct sign matches diff`, mine.every((m) => m.diffPct === null || (m.diff >= 0) === (m.diffPct >= 0)));
      check(`[compare ${label}] ${name} contributions sum to 100% when there is a change`, !c.hasBaseline || c.totals.diff === 0 || near(sum(mine.map((m) => m.contributionPct ?? 0)), 100, 0.01));
      check(`[compare ${label}] ${name} daily arrays have one value per day and sum to the entity`, mine.every((m) => m.dailyCurrent.length === c.range.days && m.dailyBaseline.length === c.range.days && near(sum(m.dailyCurrent), m.current, 0.5 + c.range.days * 0.005)));
      check(`[compare ${label}] ${name} shares add to ~100%`, c.totals.current === 0 || near(sum(mine.map((m) => m.sharePct)), 100, 0.01));
      check(`[compare ${label}] ${name} sorted by current spend`, mine.every((m, i) => i === 0 || (mine[i - 1]?.current ?? 0) >= m.current));
      check(`[compare ${label}] ${name} top child exists for every entity with spend`, mine.every((m) => m.current === 0 || m.topChild !== null));
    }
    check(`[compare ${label}] overlay points match`, c.points.length === c.range.days && near(sum(c.points.map((p) => p.current)), c.totals.current, 0.5) && near(sum(c.points.map((p) => p.previous ?? 0)), c.totals.baseline, 0.5));
    check(`[compare ${label}] entitiesFor picks the right list`, entitiesFor(c, 'provider') === c.providers && entitiesFor(c, 'account') === c.accounts && entitiesFor(c, 'service') === c.services);

    const y = getComparison(ds, f, 'year-ago');
    const rawYear = ds.costs.filter((r) => r.date >= y.baselineFrom && r.date <= y.baselineTo && (f.providerId === 'all' || r.providerId === f.providerId) && (f.accountId === 'all' || r.accountId === f.accountId) && (f.serviceId === 'all' || r.serviceId === f.serviceId)).reduce((a, r) => a + r.cost, 0);
    check(`[compare-yoy ${label}] baseline window is one year earlier`, y.baselineFrom === shiftYears(y.range.from, -1) && y.hasBaseline === (y.baselineFrom >= ds.startDate));
    check(`[compare-yoy ${label}] baseline spend equals the raw rows`, !y.hasBaseline || near(y.totals.baseline, rawYear));
    check(`[compare-yoy ${label}] current side is unchanged by the baseline choice`, near(y.totals.current, c.totals.current));
    check(`[compare-yoy ${label}] entity baselines sum to the baseline`, near(sum(y.providers.map((m) => m.baseline)), y.totals.baseline) && near(sum(y.services.map((m) => m.baseline)), y.totals.baseline));
  }
  check('no previous baseline for the earliest custom range', !getComparison(ds, { ...base, range: 'custom', customFrom: '2024-01-01', customTo: '2024-02-15' }, 'previous').hasBaseline && getComparison(ds, { ...base, range: 'custom', customFrom: '2024-01-01', customTo: '2024-02-15' }, 'previous').providers.every((p) => p.diffPct === null && p.contributionPct === null));
  check('no year-ago baseline when it predates the data', !getComparison(ds, { ...base, range: 'custom', customFrom: '2024-03-01', customTo: '2024-04-01' }, 'year-ago').hasBaseline);
  check('provider filter limits compared services to that provider', getComparison(ds, { ...base, providerId: 'aws' }, 'previous').services.every((x) => x.providerId === 'aws'));
}

// --- Alerts and notifications ---------------------------------------------------------------------------------------------
{
  const connections = ds.accounts.map((a) => { const c = getBaseConnection(a.id); return { accountId: a.id, name: a.name, providerId: a.providerId, status: c.status, lastSyncedAt: c.lastSyncedAt, changedAt: c.changedAt }; });
  const sources = (over: Partial<AlertSources> = {}, overrides: Record<string, AnomalyStatus> = {}): AlertSources => ({
    anomalies: getAlertAnomalies(DEFAULT_ANOMALY_CONFIG, overrides), budgets: getBudgetSnapshot(), connections, simulated: [], monthKey: getCurrentMonthKey(), syncedAt: '2026-10-12T04:00:00Z', ...over,
  });
  const src = sources();
  const alerts = buildAlerts(src, {});
  const budgetAlerts = src.budgets.filter((b) => b.status !== 'on-track').length;
  const connAlerts = connections.filter((c) => c.status !== 'connected').length;

  check('alert count = anomalies + budget issues + connection issues', alerts.length === src.anomalies.length + budgetAlerts + connAlerts, `${alerts.length} vs ${src.anomalies.length}+${budgetAlerts}+${connAlerts}`);
  check('alert ids are unique and deterministic', new Set(alerts.map((a) => a.id)).size === alerts.length && JSON.stringify(buildAlerts(sources(), {})) === JSON.stringify(alerts));
  check('alerts are sorted newest first', alerts.every((a, i) => i === 0 || (alerts[i - 1]?.timestamp ?? '') >= a.timestamp));
  check('every alert has a valid UTC timestamp not after the demo clock', alerts.every((a) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(a.timestamp) && a.timestamp <= DEMO_NOW_ISO));
  check('anomaly alerts keep the anomaly severity and link back to it', alerts.filter((a) => a.category === 'anomaly').every((a) => src.anomalies.some((x) => x.id === a.anomalyId && x.severity === a.severity)));
  check('anomaly alerts are timestamped the morning after the anomaly date', src.anomalies.every((x) => detectionTimestamp(x).slice(0, 10) > x.date && /T0[23]:/.test(detectionTimestamp(x))));
  check('anomaly alert status follows the anomaly workflow', alerts.filter((a) => a.category === 'anomaly').every((a) => { const x = src.anomalies.find((y) => y.id === a.anomalyId); return x !== undefined && a.status === (x.status === 'acknowledged' ? 'acknowledged' : x.status === 'resolved' || x.status === 'dismissed' ? 'resolved' : 'active'); }));
  const target = src.anomalies.find((x) => x.status === 'open' || x.status === 'investigating');
  if (target) {
    const resolved = buildAlerts(sources({}, { [target.id]: 'resolved' }), {});
    const acked = buildAlerts(sources({}, { [target.id]: 'acknowledged' }), {});
    check('resolving an anomaly resolves its alert (shared workflow)', resolved.find((a) => a.anomalyId === target.id)?.status === 'resolved');
    check('acknowledging an anomaly acknowledges its alert', acked.find((a) => a.anomalyId === target.id)?.status === 'acknowledged');
  }
  check('budget alerts only for accounts at risk or over budget, with matching severity', alerts.filter((a) => a.category === 'budget').every((a) => { const b = src.budgets.find((x) => `budget-${x.accountId}-${src.monthKey}` === a.id); return b !== undefined && b.status !== 'on-track' && a.severity === (b.status === 'over-budget' ? 'high' : 'medium'); }));
  check('degraded GCP accounts raise connection alerts', alerts.filter((a) => a.category === 'connection').length === 3 && alerts.filter((a) => a.category === 'connection').every((a) => /sync is delayed/.test(a.title) && a.severity === 'medium'));
  const disconnectedConn = connections.map((c) => (c.accountId === 'aws-sandbox' ? { ...c, status: 'disconnected' as Connectivity, changedAt: '2026-10-12T04:40:00Z' } : c));
  const dis = buildAlerts(sources({ connections: disconnectedConn }), {}).find((a) => a.id === 'conn-aws-sandbox-disconnected');
  check('disconnecting an account raises a high-severity alert at the time of disconnect', dis?.severity === 'high' && dis.timestamp === '2026-10-12T04:40:00Z' && /disconnected/.test(dis.title));
  const healed = buildAlerts(sources({ connections: connections.map((c) => ({ ...c, status: 'connected' as Connectivity })) }), {});
  check('syncing degraded accounts clears their alerts', healed.filter((a) => a.category === 'connection').length === 0);
  const local = buildAlerts(src, { [alerts.find((a) => a.category === 'budget')?.id ?? '']: 'acknowledged' });
  check('local status overrides apply to non-anomaly alerts', local.find((a) => a.category === 'budget')?.status === 'acknowledged');

  // preferences
  const sim = [createSimulatedAlert(0, ds.accounts.map((a) => a.name), new Date('2026-10-12T04:45:00Z'))];
  const withSim = buildAlerts(sources({ simulated: sim }), {});
  const strict: NotificationPreferences = { ...DEFAULT_PREFERENCES, minSeverity: 'critical' };
  const noBudget: NotificationPreferences = { ...DEFAULT_PREFERENCES, minSeverity: 'low', categories: { anomaly: true, budget: false, connection: true } };
  const all = applyPreferences(withSim, { ...DEFAULT_PREFERENCES, minSeverity: 'low' });
  const def = applyPreferences(withSim, DEFAULT_PREFERENCES);
  const str = applyPreferences(withSim, strict);
  check('lowest threshold shows everything', all.visible.length === withSim.length && all.hidden === 0);
  check('raising the minimum severity hides more (monotonic)', str.visible.length <= def.visible.length && def.visible.length <= all.visible.length);
  check('hidden count is consistent', def.hidden === withSim.length - def.visible.length && str.hidden === withSim.length - str.visible.length);
  check('visible alerts respect the minimum severity (simulated events excepted)', str.visible.every((a) => a.simulated || severityAtLeast(a.severity, 'critical')));
  check('category toggles remove that category', applyPreferences(withSim, noBudget).visible.every((a) => a.category !== 'budget') && applyPreferences(withSim, noBudget).visible.some((a) => a.category === 'anomaly'));
  check('simulated demo events are always shown', str.visible.some((a) => a.simulated));
  check('severityAtLeast ordering', severityAtLeast('high', 'medium') && !severityAtLeast('low', 'medium') && severityAtLeast('critical', 'critical'));

  // read / unread
  const vis = def.visible;
  const noneRead = {} as Record<string, boolean>;
  const baselineUnread = unreadCount(vis, noneRead);
  check('simulated alerts start unread; resolved and old alerts start read', vis.filter((a) => a.simulated).every((a) => !defaultRead(a)) && vis.filter((a) => a.status === 'resolved' && !a.simulated).every((a) => defaultRead(a)));
  check('default unread matches the per-alert rule', baselineUnread === vis.filter((a) => !defaultRead(a)).length && baselineUnread > 0);
  const allRead = Object.fromEntries(vis.map((a) => [a.id, true]));
  check('marking all as read gives zero unread', unreadCount(vis, allRead) === 0);
  const firstUnread = vis.find((a) => !isRead(a, noneRead));
  if (firstUnread) {
    check('marking one alert read lowers the count by one', unreadCount(vis, { [firstUnread.id]: true }) === baselineUnread - 1);
    check('marking a read alert unread raises the count by one', unreadCount(vis, { ...allRead, [firstUnread.id]: false }) === 1);
  }
  check('hidden alerts never count as unread', unreadCount(str.visible, noneRead) <= unreadCount(def.visible, noneRead) + 0 + sim.length);

  // transitions
  const anomalyAlert = alerts.find((a) => a.category === 'anomaly');
  const budgetAlert = alerts.find((a) => a.category === 'budget');
  if (anomalyAlert && budgetAlert) {
    const t1 = transitionFor(anomalyAlert, 'acknowledge'), t2 = transitionFor(anomalyAlert, 'resolve'), t3 = transitionFor(anomalyAlert, 'reopen');
    check('anomaly alert actions map onto the anomaly workflow', t1.kind === 'anomaly' && t1.to === 'acknowledged' && t2.kind === 'anomaly' && t2.to === 'resolved' && t3.kind === 'anomaly' && t3.to === 'open' && t1.kind === 'anomaly' && t1.anomalyId === anomalyAlert.anomalyId);
    const l1 = transitionFor(budgetAlert, 'acknowledge'), l2 = transitionFor(budgetAlert, 'resolve'), l3 = transitionFor(budgetAlert, 'reopen');
    check('other alerts keep a local status', l1.kind === 'local' && l1.to === 'acknowledged' && l2.kind === 'local' && l2.to === 'resolved' && l3.kind === 'local' && l3.to === 'active' && l1.kind === 'local' && l1.id === budgetAlert.id);
  }
  check('available actions per status', availableActions('active').join() === 'acknowledge,resolve' && availableActions('acknowledged').join() === 'resolve,reopen' && availableActions('resolved').join() === 'reopen');

  // simulation + honesty
  const names = ds.accounts.map((a) => a.name);
  const made = [0, 1, 2, 3, 4, 5].map((i) => createSimulatedAlert(i, names, new Date('2026-10-12T05:00:00Z')));
  check('simulated alerts cycle severities and have unique ids', new Set(made.map((m) => m.id)).size === 6 && new Set(made.slice(0, 4).map((m) => m.severity)).size === 4);
  check('every simulated alert says it is simulated', made.every((m) => /Simulated/.test(m.message)));
  const test = createTestAlert(9, channelSummary({ ...DEFAULT_PREFERENCES, channels: { inApp: true, email: true, slack: true } }), new Date('2026-10-12T05:00:00Z'));
  check('test notification states nothing was sent', /Nothing was actually sent/.test(test.message) && /Email \(simulated\)/.test(test.message) && /Slack \(simulated\)/.test(test.message));
  const prose = [...alerts, ...withSim].map((a) => `${a.title} ${a.message}`).join(' ');
  check('alert text has no NaN/undefined and never claims a real email or message was sent', !/NaN|undefined|Infinity|\bnull\b/.test(prose) && !/\b(emailed|email sent|sent an email|message sent)\b/i.test(prose));
  check('channel summary labels email and Slack as simulated', channelSummary(DEFAULT_PREFERENCES).join() === 'In-app,Email (simulated)' && channelSummary({ ...DEFAULT_PREFERENCES, channels: { inApp: false, email: false, slack: false } }).length === 0);
  check('preferences parse round-trips and rejects junk', JSON.stringify(parsePreferences(JSON.parse(JSON.stringify(DEFAULT_PREFERENCES)))) === JSON.stringify(DEFAULT_PREFERENCES) && parsePreferences({ channels: {}, categories: {}, minSeverity: 'x' }) === null && parsePreferences(null) === null && parsePreferences({ ...DEFAULT_PREFERENCES, minSeverity: 'bogus' }) === null);
}

// --- Persisted state parsers and small helpers ---------------------------------------------------------------------------
{
  check('alert state round-trips', JSON.stringify(parseAlertState(JSON.parse(JSON.stringify(EMPTY_ALERT_STATE)))) === JSON.stringify(EMPTY_ALERT_STATE));
  check('alert state rejects junk', parseAlertState(null) === null && parseAlertState({}) === null && parseAlertState({ read: {}, statuses: {}, simulated: [], counter: 'x', prefs: DEFAULT_PREFERENCES }) === null && parseAlertState({ read: {}, statuses: {}, simulated: [], counter: 0, prefs: { bad: true } }) === null);
  const messy = parseAlertState({
    read: { a: true, b: 'yes' }, statuses: { x: 'resolved', y: 'bogus' }, counter: -4, prefs: DEFAULT_PREFERENCES,
    simulated: [{ id: 's1', title: 't', message: 'm', timestamp: 'now', severity: 'high', accountId: null }, { id: 's2', title: 5 }, { id: 's3', title: 't', message: 'm', timestamp: 'x', severity: 'severe', accountId: null }],
  });
  check('alert state keeps only valid entries', messy !== null && Object.keys(messy.read).join() === 'a' && Object.keys(messy.statuses).join() === 'x' && messy.simulated.length === 1 && messy.counter === 0);
  const conns = parseConnectionOverrides({ a: { status: 'connected', lastSyncedAt: 'x', changedAt: null }, b: { status: 'weird', lastSyncedAt: 'x', changedAt: null }, c: { status: 'disconnected', lastSyncedAt: 'y', changedAt: 'z' }, d: 5 });
  check('connection overrides keep only valid entries', conns !== null && Object.keys(conns).join() === 'a,c' && parseConnectionOverrides([]) === null && parseConnectionOverrides(null) === null);
  check('session user guard', isUser({ name: 'a', email: 'b', role: 'c' }) && !isUser({ name: 'a' }) && !isUser(null) && !isUser('x'));
  check('emails are masked without leaking the local part', maskEmail('sam.lee@example.com') === 's*****@example.com' && !maskEmail('sam.lee@example.com').includes('lee') && maskEmail('a@b.co').endsWith('@b.co') && maskEmail('nope') === 'nope');
}

// --- CSV export ------------------------------------------------------------------------------------------
{
  const d = getDashboardData(ds, base);
  check('CSV escapes commas, quotes and newlines', toCsv(['a'], [['x,y'], ['he said "hi"'], ['l1\nl2']]) === 'a\r\n"x,y"\r\n"he said ""hi"""\r\n"l1\nl2"');
  for (const g of ['day', 'week', 'month', 'year'] as const) {
    check(`${g} trend CSV rows == buckets`, trendToCsv(d.series[g]).split('\r\n').length === d.series[g].length + 1);
  }
  check('accounts CSV rows == accounts', accountsToCsv(d.accounts).split('\r\n').length === d.accounts.length + 1);
  check('savings CSV rows == opportunities', savingsToCsv(d.savings).split('\r\n').length === d.savings.length + 1);
  check('anomalies CSV has header and rows', anomaliesToCsv(d.anomalies).split('\r\n').length === d.anomalies.length + 1 && (anomaliesToCsv(d.anomalies).split('\r\n')[0] ?? '').startsWith('detected_on,kind'));
  const csvTotal = trendToCsv(d.series.day).split('\r\n').slice(1).reduce((acc, line) => acc + Number(line.split(',')[6]), 0);
  check('daily CSV total matches KPI total', near(csvTotal, d.kpis.totalSpend.value, 1));
}

// --- Report -----------------------------------------------------------------------------------
const all = getDashboardData(ds, base);
console.log(`\nDataset: ${ds.startDate} -> ${ds.endDate}  rows=${ds.costs.length}  accounts=${ds.accounts.length}  services=${ds.services.length}  anomalies=${ds.anomalies.length}`);
const k = all.kpis;
console.log(`30d spend ${usd(k.totalSpend.value)} vs prev ${usd(k.previousSpend.value ?? 0)} (${k.previousSpend.changePct?.toFixed(1)}%) | MTD ${usd(k.monthToDate.value)} | forecast ${usd(k.forecast.value)} | budget ${usd(k.budget.monthlyBudget)} (${k.budget.projectedPct.toFixed(1)}%)`);
console.log(`accounts ${k.accounts.connected} | services ${k.services.inUse} | anomalies ${k.anomalies.total} (${k.anomalies.active} active) | savings ${usd(k.savings.monthly)}/mo (${k.savings.pctOfRunRate.toFixed(1)}% of run-rate)`);
console.log('Yearly:', all.series.year.map((p) => `${p.start.slice(0, 4)}=${usd(p.total)}${p.partial ? '*' : ''}`).join('  '));
console.log('\nAccounts (projected vs budget):');
for (const a of all.accounts) console.log(`  ${a.name.padEnd(22)} ${usd(a.projectedSpend).padStart(9)} / ${usd(a.monthlyBudget).padStart(9)} = ${a.projectedPct.toFixed(0).padStart(3)}%  ${a.budgetStatus}`);
console.log('\nSavings opportunities:');
for (const s of all.savings) console.log(`  ${usd(s.estimatedMonthlySavings).padStart(8)}  (${usd(s.rangeLow)}-${usd(s.rangeHigh)}) ${s.confidence.padEnd(6)} ${s.title}`);
console.log('\nHeadline:', buildInsightBundle(base, {}, DEFAULT_ANOMALY_CONFIG).report.headline);
console.log('\nAnomalies by year:', [...years].sort().map((y) => `${y}:${ds.anomalies.filter((a) => a.date.startsWith(y)).length}`).join('  '));

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
