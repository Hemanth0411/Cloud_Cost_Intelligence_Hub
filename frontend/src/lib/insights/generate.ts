import { addDays } from '@/lib/dates';
import { formatCompactCurrency, formatDateRange, formatPercent } from '@/lib/format';
import type { Dataset } from '@/lib/mock/dataset';
import { getAnomalyContext } from '@/lib/selectors/anomaly-context';
import { isActive, SEVERITY_ORDER } from '@/lib/selectors/anomaly-views';
import { getContributors, increaseConcentration, type PairDelta } from '@/lib/selectors/contributors';
import { isIncrease } from '@/lib/selectors/detect-anomalies';
import { getScope } from '@/lib/selectors/scope';
import type { DetectedAnomalyView, FullDashboardData, Filters } from '@/types/analytics';
import type { AnomalyConfig, CostInsight, DailyCost, DetectedAnomaly, InsightKind, InsightPriority } from '@/types/domain';
import { explainAnomaly } from './narrative';

export interface InsightReport {
  /** Executive summary, generated from the same numbers as the insights below. */
  headline: string;
  insights: CostInsight[];
  subject: string;
  periodPhrase: string;
  stats: { rowsAnalyzed: number; anomaliesConsidered: number; opportunities: number };
}

const usd = formatCompactCurrency;
const abs = Math.abs;
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

const PERIOD_PHRASES: Record<Filters['range'], string> = {
  '7d': 'the last 7 days',
  '30d': 'the last 30 days',
  '90d': 'the last 90 days',
  mtd: 'the month to date',
  ytd: 'the year to date',
  '12m': 'the last 12 months',
  custom: '',
};

const PRIORITY_RANK: Record<InsightPriority, number> = { high: 0, medium: 1, low: 2 };
const KIND_RANK: Record<InsightKind, number> = { anomaly: 0, budget: 1, change: 2, trend: 3, optimization: 4, concentration: 5 };

const sum = (rows: readonly DailyCost[], from: string, to: string, pick: (r: DailyCost) => number = (r) => r.cost): number => {
  let total = 0;
  for (const r of rows) if (r.date >= from && r.date <= to) total += pick(r);
  return total;
};

function sumByService(rows: readonly DailyCost[], from: string, to: string, pick: (r: DailyCost) => number): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rows) if (r.date >= from && r.date <= to) map.set(r.serviceId, (map.get(r.serviceId) ?? 0) + pick(r));
  return map;
}

export function generateInsightReport(
  ds: Dataset,
  filters: Filters,
  data: FullDashboardData,
  detected: readonly DetectedAnomaly[],
  config: AnomalyConfig,
): InsightReport {
  const { range, kpis } = data;
  const scoped = getScope(ds, filters).rows;
  const accountName = (id: string): string => ds.accountById.get(id)?.name ?? id;
  const serviceName = (id: string): string => ds.serviceById.get(id)?.name ?? id;
  const owner = (id: string): { name: string; team: string } => ({
    name: ds.accountById.get(id)?.owner ?? 'the account owner',
    team: ds.accountById.get(id)?.team ?? 'the owning team',
  });
  const pairName = (p: PairDelta): string => `${serviceName(p.serviceId)} in ${accountName(p.accountId)}`;

  const subject =
    filters.serviceId !== 'all'
      ? `${serviceName(filters.serviceId)}${filters.accountId !== 'all' ? ` in ${accountName(filters.accountId)}` : ''} spend`
      : filters.accountId !== 'all'
        ? `${accountName(filters.accountId)} spend`
        : filters.providerId !== 'all'
          ? `${ds.providerById.get(filters.providerId)?.name ?? filters.providerId} spend`
          : 'Total cloud spend';
  const periodPhrase = range.preset === 'custom' ? formatDateRange(range.from, range.to) : PERIOD_PHRASES[range.preset];
  const total = kpis.totalSpend.value;
  const prev = kpis.previousSpend;

  const insights: CostInsight[] = [];

  // ---- 1. What changed versus the previous period, and who drove it ------------------------------
  if (prev.value !== null && prev.changeAbs !== null && prev.changePct !== null) {
    const pairs = getContributors(scoped, range);
    const ups = pairs.filter((p) => p.delta > 0).slice(0, 3);
    const downs = [...pairs].filter((p) => p.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 2);
    const flat = abs(prev.changePct) < 0.5;
    const top = ups[0];

    const parts: string[] = [
      `${subject} was ${usd(total)} over ${periodPhrase}, ${
        flat ? 'essentially flat compared with' : `${prev.changeAbs > 0 ? 'up' : 'down'} ${abs(prev.changePct).toFixed(1)}% (${usd(abs(prev.changeAbs))}) from`
      } ${usd(prev.value)} in the previous ${range.days} days.`,
    ];
    if (top) {
      const second = ups[1];
      parts.push(
        `The largest increase came from ${pairName(top)} (+${usd(top.delta)}${top.previous > 0 ? `, ${formatPercent((top.delta / top.previous) * 100, 0)}` : ', no spend in the previous period'})${second ? `, followed by ${pairName(second)} (+${usd(second.delta)})` : ''}.`,
      );
    } else {
      parts.push('No account or service increased compared with the previous period.');
    }
    const down = downs[0];
    if (down) parts.push(`Partly offsetting this, ${pairName(down)} fell by ${usd(abs(down.delta))}.`);

    const concentration = top ? increaseConcentration(ds, top.accountId, top.serviceId, range) : null;
    if (top && concentration !== null) {
      parts.push(
        concentration >= 55
          ? `For ${serviceName(top.serviceId)}, the three biggest days account for ${concentration.toFixed(0)}% of the increase, which points to discrete events rather than steady growth.`
          : `For ${serviceName(top.serviceId)}, the three biggest days account for only ${concentration.toFixed(0)}% of the increase, which points to a sustained change rather than one-off events.`,
      );
    }

    const o = top ? owner(top.accountId) : null;
    insights.push({
      id: 'insight-change',
      kind: 'change',
      priority: abs(prev.changePct) >= 10 ? 'high' : abs(prev.changePct) >= 3 ? 'medium' : 'low',
      title: flat ? 'Spend is flat versus the previous period' : `Spend ${prev.changeAbs > 0 ? 'increased' : 'decreased'} ${abs(prev.changePct).toFixed(1)}% versus the previous period`,
      summary: parts.join(' '),
      evidence: [
        { label: 'This period', value: usd(total) },
        { label: 'Previous period', value: usd(prev.value) },
        { label: 'Change', value: `${prev.changeAbs >= 0 ? '+' : '−'}${usd(abs(prev.changeAbs))} (${prev.changePct >= 0 ? '+' : '−'}${abs(prev.changePct).toFixed(1)}%)` },
        ...ups.map((p, i) => ({ label: i === 0 ? 'Top increase' : `Increase #${i + 1}`, value: `${pairName(p)}: +${usd(p.delta)}` })),
        ...downs.slice(0, 1).map((p) => ({ label: 'Top decrease', value: `${pairName(p)}: −${usd(abs(p.delta))}` })),
      ],
      investigateNext: top
        ? [
            `Filter the dashboard to ${pairName(top)} and compare its daily trend with the previous period.`,
            concentration !== null && concentration >= 55
              ? 'Look at the biggest days for that series and check for deployments, jobs or incidents on those dates.'
              : `Check what changed in ${accountName(top.accountId)} around the start of the period: new workloads, scaling settings or usage growth.`,
          ]
        : ['Confirm the decreases are intentional and not caused by stopped workloads.'],
      recommendedActions:
        top && o
          ? [
              `Confirm with ${o.name} (${o.team}) whether the increase in ${serviceName(top.serviceId)} is expected.`,
              `If it is expected, update the forecast and budget for ${accountName(top.accountId)}. If not, add a cost alert on ${serviceName(top.serviceId)}.`,
            ]
          : ['Keep monitoring; no action is needed for a decline unless it is unexpected.'],
      relatedAccountIds: top ? [top.accountId] : [],
      relatedServiceIds: top ? [top.serviceId] : [],
      relatedAnomalyIds: [],
    });
  }

  // ---- 2. Anomalies: the largest unresolved findings, explained from the data ---------------------
  const active = data.anomalies.filter((a) => isActive(a.status));
  const rankBySeverity = (a: DetectedAnomalyView, b: DetectedAnomalyView): number =>
    SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || abs(b.impactCost) - abs(a.impactCost);
  const increases = active.filter((a) => isIncrease(a.kind)).sort(rankBySeverity).slice(0, 3);
  const decreases = active.filter((a) => !isIncrease(a.kind)).sort(rankBySeverity).slice(0, 1);

  for (const a of [...increases, ...decreases]) {
    const o = owner(a.accountId);
    const x = explainAnomaly({
      anomaly: a,
      context: getAnomalyContext(ds, a, detected, config),
      config,
      providerName: ds.providerById.get(a.providerId)?.name ?? a.providerId,
      ownerName: o.name,
      teamName: o.team,
      category: ds.serviceById.get(a.serviceId)?.category ?? 'compute',
      serviceNameOf: serviceName,
    });
    insights.push({
      id: `insight-${a.id}`,
      kind: 'anomaly',
      priority: a.severity === 'critical' || a.severity === 'high' ? 'high' : a.severity === 'medium' ? 'medium' : 'low',
      title: x.headline,
      summary: [x.whatChanged, x.contribution, x.usageNote, x.concurrentNote].filter((t): t is string => t !== null).join(' '),
      evidence: x.evidence,
      investigateNext: x.investigateNext,
      recommendedActions: x.recommendedActions,
      relatedAccountIds: [a.accountId],
      relatedServiceIds: [a.serviceId],
      relatedAnomalyIds: [a.id],
    });
  }

  // ---- 3. Budget risk ------------------------------------------------------------------------------
  if (kpis.budget.applicable) {
    const risky = data.accounts
      .filter((a) => a.budgetStatus !== 'on-track')
      .sort((a, b) => b.projectedSpend - b.monthlyBudget - (a.projectedSpend - a.monthlyBudget));
    const over = risky.filter((a) => a.budgetStatus === 'over-budget');
    const topRisk = risky[0];
    const budget = kpis.budget;
    const lines = risky.slice(0, 3).map((a) =>
      a.budgetStatus === 'over-budget'
        ? `${a.name} is projected to finish at ${usd(a.projectedSpend)}, ${formatPercent(a.projectedPct, 0)} of its ${usd(a.monthlyBudget)} budget (${usd(a.projectedSpend - a.monthlyBudget)} over).`
        : `${a.name} is projected at ${formatPercent(a.projectedPct, 0)} of its ${usd(a.monthlyBudget)} budget, within 10% of the limit.`,
    );
    const o = topRisk ? owner(topRisk.accountId) : null;
    insights.push({
      id: 'insight-budget',
      kind: 'budget',
      priority: over.length > 0 ? 'high' : risky.length > 0 ? 'medium' : 'low',
      title:
        over.length > 0
          ? `${over.length} ${plural(over.length, 'account is', 'accounts are')} projected to exceed budget`
          : risky.length > 0
            ? `${risky.length} ${plural(risky.length, 'account is', 'accounts are')} close to budget`
            : 'All accounts are projected within budget',
      summary: [
        `At the current pace ${kpis.forecast.monthLabel} will finish around ${usd(budget.projectedSpend)}, ${formatPercent(budget.projectedPct, 0)} of the combined ${usd(budget.monthlyBudget)} monthly budget (forecast = month to date plus the trailing 7-day average for the ${kpis.forecast.daysRemaining} days left).`,
        ...(lines.length > 0 ? lines : [`All ${data.accounts.length} accounts in view are projected below 90% of budget.`]),
      ].join(' '),
      evidence: [
        { label: 'Month to date', value: usd(budget.mtdSpend) },
        { label: 'Projected month end', value: usd(budget.projectedSpend) },
        { label: 'Monthly budget', value: usd(budget.monthlyBudget) },
        ...risky.slice(0, 3).map((a) => ({ label: a.name, value: `${usd(a.projectedSpend)} of ${usd(a.monthlyBudget)} (${formatPercent(a.projectedPct, 0)})` })),
      ],
      investigateNext: topRisk
        ? [
            `Filter the dashboard to ${topRisk.name} and see which services drive its month-to-date spend.`,
            `Check whether the ${topRisk.name} budget still matches what the workload needs.`,
          ]
        : ['Nothing to investigate: every account is on track.'],
      recommendedActions: topRisk && o
        ? [
            `Review the ${topRisk.name} budget or its spend with ${o.name} (${o.team}).`,
            'Set budget alerts at 80% and 100% for accounts projected above 90%.',
          ]
        : ['Keep budget alerts at 80% and 100% so early drift is caught.'],
      relatedAccountIds: risky.slice(0, 3).map((a) => a.accountId),
      relatedServiceIds: [],
      relatedAnomalyIds: [],
    });
  }

  // ---- 4. Longer-term trend: fastest growers (trailing 90 days) and year over year ------------------
  {
    const end = ds.endDate;
    const cur = { from: addDays(end, -89), to: end };
    const old = { from: addDays(end, -179), to: addDays(end, -90) };
    const nowCost = sumByService(scoped, cur.from, cur.to, (r) => r.cost);
    const oldCost = sumByService(scoped, old.from, old.to, (r) => r.cost);
    const nowUsage = sumByService(scoped, cur.from, cur.to, (r) => r.usageQuantity);
    const oldUsage = sumByService(scoped, old.from, old.to, (r) => r.usageQuantity);

    const growers = [...nowCost]
      .flatMap(([id, c]) => {
        const p = oldCost.get(id) ?? 0;
        return p >= 3000 && c > p * 1.1 ? [{ id, now: c, before: p, pct: ((c - p) / p) * 100 }] : [];
      })
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 2);

    const year = Number(end.slice(0, 4));
    const ytd = sum(scoped, `${year}-01-01`, end);
    const lastYear = sum(scoped, `${year - 1}-01-01`, `${year - 1}-${end.slice(5)}`);
    const yoy = lastYear > 0 ? ((ytd - lastYear) / lastYear) * 100 : null;

    if (growers.length > 0 || yoy !== null) {
      const g = growers[0];
      const g2 = growers[1];
      const usageGrowth = g && (oldUsage.get(g.id) ?? 0) > 0 ? (((nowUsage.get(g.id) ?? 0) - (oldUsage.get(g.id) ?? 0)) / (oldUsage.get(g.id) ?? 1)) * 100 : null;
      const parts: string[] = [];
      if (g) {
        parts.push(
          `Over the last 90 days ${serviceName(g.id)} grew ${g.pct.toFixed(0)}% (+${usd(g.now - g.before)}) compared with the 90 days before, the fastest growth in this view${g2 ? `, followed by ${serviceName(g2.id)} (+${g2.pct.toFixed(0)}%)` : ''}.`,
        );
        if (usageGrowth !== null) parts.push(`Billed usage for ${serviceName(g.id)} changed by ${usageGrowth >= 0 ? '+' : '−'}${abs(usageGrowth).toFixed(0)}% over the same comparison.`);
      } else {
        parts.push('No service grew more than 10% over the last 90 days compared with the 90 days before.');
      }
      if (yoy !== null) {
        parts.push(`Year to date, spend of ${usd(ytd)} is ${abs(yoy).toFixed(0)}% ${yoy >= 0 ? 'above' : 'below'} the same period last year (${usd(lastYear)}).`);
      }
      insights.push({
        id: 'insight-trend',
        kind: 'trend',
        priority: g && g.pct >= 25 ? 'medium' : 'low',
        title: g ? `${serviceName(g.id)} is the fastest-growing service` : 'Year-over-year spend trend',
        summary: parts.join(' '),
        evidence: [
          ...growers.map((x) => ({ label: `${serviceName(x.id)}, last 90 days`, value: `${usd(x.now)} vs ${usd(x.before)} (+${x.pct.toFixed(0)}%)` })),
          ...(yoy !== null ? [{ label: 'Year to date vs last year', value: `${usd(ytd)} vs ${usd(lastYear)} (${yoy >= 0 ? '+' : '−'}${abs(yoy).toFixed(0)}%)` }] : []),
        ],
        investigateNext: g
          ? [`Check whether growth in ${serviceName(g.id)} reflects more usage or new workloads, and whether it is planned.`, 'Compare the growth with the forecast and budget set for the owning account.']
          : ['Review whether year-over-year growth matches business growth.'],
        recommendedActions: g
          ? [`Ask the owners of ${serviceName(g.id)} to confirm the growth is planned and reflected in the forecast.`, `If growth will continue, see the optimization opportunities below for commitment options.`]
          : ['No action needed unless growth is unexpected.'],
        relatedAccountIds: [],
        relatedServiceIds: growers.map((x) => x.id),
        relatedAnomalyIds: [],
      });
    }
  }

  // ---- 5. Concentration --------------------------------------------------------------------------------
  const services = data.breakdowns.service;
  if (services.length >= 3 && total > 0) {
    const top3 = services.slice(0, 3);
    const share = top3.reduce((acc, s) => acc + s.sharePct, 0);
    const topAccount = data.breakdowns.account[0];
    const monthlyTop = top3.reduce((acc, s) => acc + s.cost, 0) * (30 / range.days);
    insights.push({
      id: 'insight-concentration',
      kind: 'concentration',
      priority: (top3[0]?.sharePct ?? 0) >= 35 ? 'medium' : 'low',
      title: `Three services make up ${share.toFixed(0)}% of spend`,
      summary: `${top3.map((s) => `${s.label} (${formatPercent(s.sharePct, 0)})`).join(', ')} together make up ${formatPercent(share, 0)} of ${subject.toLowerCase()} in view.${topAccount && data.breakdowns.account.length > 1 ? ` ${topAccount.label} is the largest account at ${formatPercent(topAccount.sharePct, 0)}.` : ''} A 10% improvement on these three services alone would be worth about ${usd(monthlyTop * 0.1)} per month.`,
      evidence: top3.map((s) => ({ label: s.label, value: `${usd(s.cost)} (${formatPercent(s.sharePct, 0)})` })),
      investigateNext: [`Review how ${top3[0]?.label ?? 'the top service'} is provisioned and whether commitment discounts already apply.`],
      recommendedActions: ['Focus optimization reviews on the top services first, since each percent saved there matters most.'],
      relatedAccountIds: topAccount ? [topAccount.id] : [],
      relatedServiceIds: top3.map((s) => s.id),
      relatedAnomalyIds: [],
    });
  }

  // ---- 6. Optimization roll-up ---------------------------------------------------------------------------
  const opps = data.savings;
  if (opps.length > 0) {
    const low = opps.reduce((acc, o) => acc + o.rangeLow, 0);
    const high = opps.reduce((acc, o) => acc + o.rangeHigh, 0);
    const easy = opps.filter((o) => o.effort === 'low').sort((a, b) => b.estimatedMonthlySavings - a.estimatedMonthlySavings)[0];
    const biggest = opps[0];
    insights.push({
      id: 'insight-optimization',
      kind: 'optimization',
      priority: 'medium',
      title: `${opps.length} estimated savings ${plural(opps.length, 'opportunity', 'opportunities')} identified`,
      summary: `Based on spend in this view, estimated savings are ${usd(low)}–${usd(high)} per month (mid-point ${usd(kpis.savings.monthly)}, about ${formatPercent(kpis.savings.pctOfRunRate, 0)} of the monthly run-rate). These are estimates from stated assumptions, not guarantees.${biggest ? ` The largest is "${biggest.title}" at about ${usd(biggest.estimatedMonthlySavings)} per month.` : ''}${easy ? ` The easiest to start with is "${easy.title}" (low effort).` : ''}`,
      evidence: opps.slice(0, 4).map((o) => ({ label: o.title, value: `${usd(o.rangeLow)}–${usd(o.rangeHigh)} / month (estimate)` })),
      investigateNext: ['Read the assumptions on each opportunity and check them against your own utilization and commitment data.'],
      recommendedActions: easy ? [`Start with "${easy.title}": low effort and ${easy.confidence} confidence.`] : ['Pick the highest-confidence opportunity and validate it first.'],
      relatedAccountIds: biggest?.relatedAccountIds ?? [],
      relatedServiceIds: biggest?.relatedServiceIds ?? [],
      relatedAnomalyIds: [],
    });
  }

  insights.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || KIND_RANK[a.kind] - KIND_RANK[b.kind]);

  // ---- Executive summary -----------------------------------------------------------------------------------
  const headlineParts: string[] = [
    `${subject} was ${usd(total)} over ${periodPhrase}${
      prev.changePct === null ? '' : abs(prev.changePct) < 0.5 ? ', flat versus the previous period' : `, ${prev.changePct > 0 ? 'up' : 'down'} ${abs(prev.changePct).toFixed(1)}% versus the previous ${range.days} days`
    }.`,
  ];
  const topAnomaly = [...active].sort(rankBySeverity)[0];
  headlineParts.push(
    active.length === 0
      ? 'There are no unresolved anomalies in this period.'
      : `${active.length} unresolved ${plural(active.length, 'anomaly needs', 'anomalies need')} attention${topAnomaly ? `, the most severe being ${topAnomaly.serviceName} in ${topAnomaly.accountName}` : ''}.`,
  );
  if (kpis.budget.applicable) {
    const overCount = data.accounts.filter((a) => a.budgetStatus === 'over-budget').length;
    headlineParts.push(overCount > 0 ? `${overCount} ${plural(overCount, 'account is', 'accounts are')} projected to exceed budget this month.` : 'No account is projected to exceed its budget this month.');
  }
  if (opps.length > 0) {
    headlineParts.push(`Estimated savings opportunities total ${usd(opps.reduce((a, o) => a + o.rangeLow, 0))}–${usd(opps.reduce((a, o) => a + o.rangeHigh, 0))} per month.`);
  }

  return {
    headline: headlineParts.join(' '),
    insights,
    subject,
    periodPhrase,
    stats: { rowsAnalyzed: scoped.length, anomaliesConsidered: data.anomalies.length, opportunities: opps.length },
  };
}
