import { dayOfWeek } from '@/lib/dates';
import { formatCompactCurrency, formatPercent } from '@/lib/format';
import type { Dataset } from '@/lib/mock/dataset';
import type { DetectedAnomalyView } from '@/types/analytics';
import type { Confidence, DailyCost, Effort, Environment, Evidence, Opportunity, ServiceCategory } from '@/types/domain';
import { isActive } from './anomaly-views';

/**
 * Optimization opportunities. Every figure is an ESTIMATE: matching spend from the dataset times an
 * assumed saving range (low / mid / high) that is stated on the opportunity. Evidence lines come from
 * the same rows (weekend vs weekday cost, day-to-day stability, share of spend), so each idea shows
 * what in the data supports it and what the data cannot tell us.
 */

interface RuleStats {
  base: number;
  usage: number;
  byDate: Map<string, number>;
  byAccount: Map<string, number>;
  byService: Map<string, number>;
}

interface Rule {
  id: string;
  title: string;
  effort: Effort;
  pct: { low: number; mid: number; high: number };
  matches: (env: Environment, category: ServiceCategory) => boolean;
  /** Builds the narrative pieces from the measured stats. */
  describe: (m: Measures) => { summary: string; assumption: string; confidence: Confidence; actions: string[]; evidence: Evidence[] };
}

interface Measures {
  monthlyBasis: number;
  shareOfTotalPct: number;
  weekendRatio: number | null;
  weekdayVariability: number | null;
  topAccount: string;
  topService: string;
  usageUnits: number;
}

const NON_PROD: readonly Environment[] = ['development', 'staging'];
const usd = formatCompactCurrency;

const RULES: Rule[] = [
  {
    id: 'schedule-nonprod',
    title: 'Schedule non-production compute',
    effort: 'low',
    pct: { low: 0.2, mid: 0.32, high: 0.45 },
    matches: (env, cat) => NON_PROD.includes(env) && cat === 'compute',
    describe: (m) => {
      const r = m.weekendRatio;
      const steady = r !== null && r >= 0.4;
      return {
        summary:
          r === null
            ? `Development and staging compute costs about ${usd(m.monthlyBasis)} per month. Widen the date range to see how it behaves at weekends.`
            : steady
              ? `Development and staging compute costs about ${usd(m.monthlyBasis)} per month, and weekend spend is still ${formatPercent(r * 100, 0)} of weekday spend. That pattern suggests much of it keeps running outside working hours.`
              : `Development and staging compute costs about ${usd(m.monthlyBasis)} per month. Weekend spend is already only ${formatPercent((r ?? 0) * 100, 0)} of weekday spend, so part of this may already be scheduled.`,
        assumption: 'Assumes shutting resources down outside business hours removes 20–45% of their cost (mid 32%). Real savings depend on which resources can safely be stopped.',
        confidence: steady ? 'high' : 'medium',
        actions: [
          `Start with ${m.topAccount}, the largest non-production compute spender.`,
          'Apply start/stop schedules to instances and node pools tagged as non-production.',
          'Keep an override tag for resources that must stay up (CI runners, shared test data).',
        ],
        evidence: [
          { label: 'Non-prod compute spend', value: `${usd(m.monthlyBasis)} / month` },
          { label: 'Weekend vs weekday spend', value: r === null ? 'Not enough days in range' : formatPercent(r * 100, 0) },
          { label: 'Largest spender', value: m.topAccount },
        ],
      };
    },
  },
  {
    id: 'rightsize-prod',
    title: 'Review production compute sizing',
    effort: 'medium',
    pct: { low: 0.05, mid: 0.09, high: 0.15 },
    matches: (env, cat) => env === 'production' && cat === 'compute',
    describe: (m) => ({
      summary: `Production compute costs about ${usd(m.monthlyBasis)} per month (${formatPercent(m.shareOfTotalPct, 0)} of spend in view). Even a modest reduction is material at this size, but this dataset has no CPU or memory utilization, so the figure is only a rough range.`,
      assumption: 'Assumes 5–15% (mid 9%) from rightsizing, a common range in practice. Not derived from utilization data, which this dataset lacks; validate before acting.',
      confidence: 'low',
      actions: [
        `Pull CPU and memory utilization for ${m.topService} in ${m.topAccount} before changing anything.`,
        'Shortlist instances with sustained low utilization and test one size down in staging first.',
      ],
      evidence: [
        { label: 'Production compute spend', value: `${usd(m.monthlyBasis)} / month` },
        { label: 'Share of spend in view', value: formatPercent(m.shareOfTotalPct, 0) },
        { label: 'Utilization metrics', value: 'Not available in this dataset' },
      ],
    }),
  },
  {
    id: 'commit-databases',
    title: 'Commit to steady production databases',
    effort: 'low',
    pct: { low: 0.12, mid: 0.2, high: 0.28 },
    matches: (env, cat) => env === 'production' && cat === 'database',
    describe: (m) => {
      const cv = m.weekdayVariability;
      const confidence: Confidence = cv === null ? 'low' : cv < 0.08 ? 'high' : cv < 0.15 ? 'medium' : 'low';
      return {
        summary:
          cv !== null && cv < 0.15
            ? `Production databases cost about ${usd(m.monthlyBasis)} per month and weekday spend varies by only ${formatPercent(cv * 100, 0)} day to day. Steady usage like this is what reserved or committed capacity is designed for.`
            : `Production databases cost about ${usd(m.monthlyBasis)} per month. Daily spend is fairly variable, so commit only to the steady baseline.`,
        assumption: 'Assumes a commitment covering the steady baseline discounts it by 12–28% (mid 20%). Commitment terms, eligibility and coverage are not modelled.',
        confidence,
        actions: [
          `Check commitment options for ${m.topService} in ${m.topAccount}, the largest production database spend.`,
          'Commit to roughly the minimum daily usage, not the average, to avoid paying for unused capacity.',
        ],
        evidence: [
          { label: 'Production database spend', value: `${usd(m.monthlyBasis)} / month` },
          { label: 'Weekday spend variability', value: cv === null ? 'n/a' : `${formatPercent(cv * 100, 0)} (lower is steadier)` },
          { label: 'Largest spender', value: `${m.topService} · ${m.topAccount}` },
        ],
      };
    },
  },
  {
    id: 'storage-tiering',
    title: 'Tier infrequently used storage',
    effort: 'low',
    pct: { low: 0.08, mid: 0.15, high: 0.25 },
    matches: (_env, cat) => cat === 'storage',
    describe: (m) => ({
      summary: `Storage costs about ${usd(m.monthlyBasis)} per month (${formatPercent(m.shareOfTotalPct, 0)} of spend in view). Lifecycle rules that move rarely read data to cheaper tiers can reduce this, but access patterns are not in this dataset.`,
      assumption: 'Assumes 8–25% (mid 15%) from lifecycle tiering. The share of cold data is unknown here, so the range is wide and low-confidence.',
      confidence: m.shareOfTotalPct >= 8 ? 'medium' : 'low',
      actions: [
        `Review access patterns for ${m.topService} in ${m.topAccount}, the largest storage spend.`,
        'Add lifecycle rules for data untouched for 30–90 days and enable storage analytics to confirm.',
      ],
      evidence: [
        { label: 'Storage spend', value: `${usd(m.monthlyBasis)} / month` },
        { label: 'Share of spend in view', value: formatPercent(m.shareOfTotalPct, 0) },
        { label: 'Access-pattern data', value: 'Not available in this dataset' },
      ],
    }),
  },
  {
    id: 'idle-ml-dev',
    title: 'Trim ML development capacity',
    effort: 'medium',
    pct: { low: 0.15, mid: 0.25, high: 0.35 },
    matches: (env, cat) => env === 'development' && cat === 'ai-ml',
    describe: (m) => {
      const r = m.weekendRatio;
      return {
        summary:
          r !== null && r >= 0.4
            ? `ML spend in development accounts is about ${usd(m.monthlyBasis)} per month and weekend spend is ${formatPercent(r * 100, 0)} of weekday spend, so capacity looks to be running when nobody is working.`
            : `ML spend in development accounts is about ${usd(m.monthlyBasis)} per month.`,
        assumption: 'Assumes 15–35% (mid 25%) from stopping unused notebooks and endpoints and using smaller or interruptible capacity for experiments.',
        confidence: r !== null && r >= 0.4 ? 'medium' : 'low',
        actions: [
          `Review running notebooks, training jobs and endpoints in ${m.topAccount}.`,
          'Set auto-stop on idle notebooks and prefer interruptible capacity for experiments.',
        ],
        evidence: [
          { label: 'Dev ML spend', value: `${usd(m.monthlyBasis)} / month` },
          { label: 'Weekend vs weekday spend', value: r === null ? 'Not enough days in range' : formatPercent(r * 100, 0) },
          { label: 'Largest spender', value: `${m.topService} · ${m.topAccount}` },
        ],
      };
    },
  },
  {
    id: 'reduce-egress',
    title: 'Reduce data transfer and delivery costs',
    effort: 'high',
    pct: { low: 0.06, mid: 0.12, high: 0.2 },
    matches: (_env, cat) => cat === 'network',
    describe: (m) => ({
      summary: `Networking and data transfer cost about ${usd(m.monthlyBasis)} per month (${formatPercent(m.shareOfTotalPct, 0)} of spend in view). Caching, compression and keeping traffic in-region can lower it, though the traffic breakdown is not in this dataset.`,
      assumption: 'Assumes 6–20% (mid 12%) from caching and traffic changes. Highest effort, and the traffic mix is unknown here.',
      confidence: 'low',
      actions: [
        `Break down ${m.topService} charges by region and destination in the billing console.`,
        'Evaluate CDN caching and in-region routing for the largest flows.',
      ],
      evidence: [
        { label: 'Network spend', value: `${usd(m.monthlyBasis)} / month` },
        { label: 'Share of spend in view', value: formatPercent(m.shareOfTotalPct, 0) },
        { label: 'Traffic breakdown', value: 'Not available in this dataset' },
      ],
    }),
  },
];

const ANOMALY_PCT = { low: 0.25, mid: 0.4, high: 0.6 };

const topKey = (map: Map<string, number>): string | undefined =>
  [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

const topKeys = (map: Map<string, number>, n: number): string[] =>
  [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

const bump = (map: Map<string, number>, key: string, value: number): void => {
  map.set(key, (map.get(key) ?? 0) + value);
};

function weekendRatio(byDate: Map<string, number>): number | null {
  let weekday = 0;
  let weekdayN = 0;
  let weekend = 0;
  let weekendN = 0;
  for (const [date, cost] of byDate) {
    const d = dayOfWeek(date);
    if (d === 0 || d === 6) {
      weekend += cost;
      weekendN += 1;
    } else {
      weekday += cost;
      weekdayN += 1;
    }
  }
  if (weekdayN < 3 || weekendN < 1 || weekday <= 0) return null;
  return weekend / weekendN / (weekday / weekdayN);
}

/** Coefficient of variation of weekday totals: standard deviation / mean. */
function weekdayVariability(byDate: Map<string, number>): number | null {
  const values = [...byDate].filter(([d]) => {
    const w = dayOfWeek(d);
    return w !== 0 && w !== 6;
  }).map(([, v]) => v);
  if (values.length < 5) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean <= 0) return null;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

export interface OpportunityResult {
  opportunities: Opportunity[];
  monthlyTotal: number;
  rangeLow: number;
  rangeHigh: number;
}

export function computeOpportunities(
  ds: Dataset,
  rows: readonly DailyCost[],
  anomalies: readonly DetectedAnomalyView[],
  days: number,
): OpportunityResult {
  const monthly = 30 / days;
  const totalSpend = rows.reduce((acc, r) => acc + r.cost, 0);
  const stats = new Map<string, RuleStats>(
    RULES.map((r) => [r.id, { base: 0, usage: 0, byDate: new Map(), byAccount: new Map(), byService: new Map() }]),
  );

  for (const row of rows) {
    const env = ds.accountById.get(row.accountId)?.environment;
    const category = ds.serviceById.get(row.serviceId)?.category;
    if (!env || !category) continue;
    for (const rule of RULES) {
      if (!rule.matches(env, category)) continue;
      const s = stats.get(rule.id);
      if (!s) continue;
      s.base += row.cost;
      s.usage += row.usageQuantity;
      bump(s.byDate, row.date, row.cost);
      bump(s.byAccount, row.accountId, row.cost);
      bump(s.byService, row.serviceId, row.cost);
    }
  }

  const accountName = (id: string | undefined): string => (id ? ds.accountById.get(id)?.name ?? id : 'n/a');
  const serviceName = (id: string | undefined): string => (id ? ds.serviceById.get(id)?.name ?? id : 'n/a');

  const opportunities: Opportunity[] = [];
  for (const rule of RULES) {
    const s = stats.get(rule.id);
    if (!s || s.base <= 0) continue;
    const monthlyBasis = s.base * monthly;
    const measures: Measures = {
      monthlyBasis,
      shareOfTotalPct: totalSpend > 0 ? (s.base / totalSpend) * 100 : 0,
      weekendRatio: weekendRatio(s.byDate),
      weekdayVariability: weekdayVariability(s.byDate),
      topAccount: accountName(topKey(s.byAccount)),
      topService: serviceName(topKey(s.byService)),
      usageUnits: s.usage,
    };
    const d = rule.describe(measures);
    opportunities.push({
      id: `opp-${rule.id}`,
      title: rule.title,
      summary: d.summary,
      estimatedMonthlySavings: Math.round(monthlyBasis * rule.pct.mid),
      rangeLow: Math.round(monthlyBasis * rule.pct.low),
      rangeHigh: Math.round(monthlyBasis * rule.pct.high),
      basisMonthlySpend: Math.round(monthlyBasis),
      assumption: d.assumption,
      confidence: d.confidence,
      effort: rule.effort,
      evidence: d.evidence,
      actions: d.actions,
      relatedAccountIds: topKeys(s.byAccount, 3),
      relatedServiceIds: topKeys(s.byService, 3),
    });
  }

  // Unresolved cost increases are avoidable spend too. One-off spikes are scaled to a month; sustained increases use their daily run-rate.
  const active = anomalies.filter((a) => isActive(a.status) && a.differenceCost > 0);
  const spikes = active.filter((a) => a.kind === 'spike');
  const sustained = active.filter((a) => a.kind === 'sustained-increase');
  const spikeMonthly = spikes.reduce((acc, a) => acc + a.impactCost, 0) * monthly;
  const sustainedMonthly = sustained.reduce((acc, a) => acc + a.differenceCost * 30, 0);
  const anomalyBasis = spikeMonthly + sustainedMonthly;
  if (anomalyBasis > 0) {
    const byAccount = new Map<string, number>();
    const byService = new Map<string, number>();
    for (const a of active) {
      bump(byAccount, a.accountId, a.impactCost);
      bump(byService, a.serviceId, a.impactCost);
    }
    const largest = [...active].sort((a, b) => b.impactCost - a.impactCost).slice(0, 3);
    opportunities.push({
      id: 'opp-contain-anomalies',
      title: 'Prevent repeat cost spikes and drift',
      summary: `${active.length} unresolved cost increase${active.length === 1 ? '' : 's'} added deviation worth about ${usd(anomalyBasis)} on a monthly basis (${spikes.length} spike${spikes.length === 1 ? '' : 's'}, ${sustained.length} sustained). Alerts and faster follow-up reduce how much of this recurs.`,
      assumption: 'Assumes 25–60% (mid 40%) of this deviation is avoidable with budget alerts and quicker response. One-off spikes are scaled to a 30-day month; sustained increases use their daily run-rate x 30.',
      estimatedMonthlySavings: Math.round(anomalyBasis * ANOMALY_PCT.mid),
      rangeLow: Math.round(anomalyBasis * ANOMALY_PCT.low),
      rangeHigh: Math.round(anomalyBasis * ANOMALY_PCT.high),
      basisMonthlySpend: Math.round(anomalyBasis),
      confidence: 'medium',
      effort: 'medium',
      evidence: largest.map((a) => ({
        label: `${a.serviceName} · ${a.accountName}`,
        value: `${a.kind === 'spike' ? 'spike' : 'sustained'} · +${usd(a.impactCost)} (${a.date})`,
      })),
      actions: [
        'Resolve or dismiss the listed anomalies once reviewed so only live issues remain.',
        'Create daily-cost alerts on the affected services at about 30% above their expected cost.',
      ],
      relatedAccountIds: topKeys(byAccount, 3),
      relatedServiceIds: topKeys(byService, 3),
    });
  }

  opportunities.sort((a, b) => b.estimatedMonthlySavings - a.estimatedMonthlySavings);
  return {
    opportunities,
    monthlyTotal: opportunities.reduce((acc, o) => acc + o.estimatedMonthlySavings, 0),
    rangeLow: opportunities.reduce((acc, o) => acc + o.rangeLow, 0),
    rangeHigh: opportunities.reduce((acc, o) => acc + o.rangeHigh, 0),
  };
}
