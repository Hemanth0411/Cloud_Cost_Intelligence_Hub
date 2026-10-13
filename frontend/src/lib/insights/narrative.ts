import { formatCompactCurrency, formatCurrency, formatDate, formatPercent } from '@/lib/format';
import type { AnomalyContext } from '@/lib/selectors/anomaly-context';
import { isIncrease, KIND_LABELS } from '@/lib/selectors/detect-anomalies';
import type { DetectedAnomalyView } from '@/types/analytics';
import type { AnomalyConfig, Evidence, ServiceCategory } from '@/types/domain';

/**
 * Deterministic "AI-style" explanations. Every sentence is a template filled with numbers computed from
 * the dataset. Nothing here asserts a root cause the data cannot show: possible areas to check are
 * phrased as things to check.
 */

export interface AnomalyNarrativeInput {
  anomaly: DetectedAnomalyView;
  context: AnomalyContext;
  config: AnomalyConfig;
  providerName: string;
  ownerName: string;
  teamName: string;
  category: ServiceCategory;
  serviceNameOf: (serviceId: string) => string;
}

export interface AnomalyExplanation {
  headline: string;
  whatChanged: string;
  contribution: string | null;
  concurrentNote: string | null;
  investigateNext: string[];
  recommendedActions: string[];
  evidence: Evidence[];
}

const usd = formatCurrency;
const signed = (v: number): string => `${v >= 0 ? '+' : '−'}${formatCurrency(Math.abs(v))}`;
const signedPct = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(0)}%`;

const CHECKS_INCREASE: Record<ServiceCategory, string[]> = {
  compute: [
    'Instance or node counts and autoscaling activity for this service around the detection date.',
    'Deployments, load tests or batch jobs that started around then.',
    'A cost breakdown by region, tag or resource group in the billing console to isolate what grew.',
  ],
  storage: [
    'Recent bulk uploads, replication or backup jobs writing to this storage.',
    'Lifecycle and retention rules that may have changed.',
    'Request and data-retrieval charges, not only stored volume.',
  ],
  database: [
    'Provisioned capacity or IOPS changes, and any resizing around the detection date.',
    'Long-running queries or new workloads hitting the database.',
    'Backup retention and replica settings.',
  ],
  network: [
    'Top data-transfer sources and destinations, especially cross-region and internet egress.',
    'New integrations or data-sync jobs that began around the detection date.',
    'CDN cache hit ratio, if a CDN fronts this traffic.',
  ],
  analytics: [
    'Query or job history for unusually large scans or newly scheduled jobs.',
    'Changes to table partitioning or data volume feeding the warehouse.',
    'Who or what submitted the most expensive jobs that day.',
  ],
  'ai-ml': [
    'Running training jobs, notebooks and endpoints around the detection date.',
    'Request or token volume from clients, if this is an inference service.',
    'Whether any resources were left running after an experiment finished.',
  ],
};

const CHECKS_DECREASE: string[] = [
  'Whether the decrease is intentional: decommissioning, rightsizing or a scheduled shutdown.',
  'Whether the workload stopped unexpectedly. A drop can signal an outage or a failed job, not savings.',
  'Whether usage or billing data for these days is complete, since late-arriving data can look like a drop.',
];

export function explainAnomaly(input: AnomalyNarrativeInput): AnomalyExplanation {
  const { anomaly: a, context: ctx, config, providerName, ownerName, teamName, category, serviceNameOf } = input;
  const increase = isIncrease(a.kind);
  const sustained = a.windowDays > 1;
  const dir = increase ? 'above' : 'below';
  const pct = Math.abs(a.changePct).toFixed(0);
  const diffAbs = Math.abs(a.differenceCost);
  const where = `${a.serviceName} in ${a.accountName} (${providerName})`;

  const whatChanged = sustained
    ? `Over the ${a.windowDays} days to ${formatDate(a.date, 'long')}, ${where} typically cost ${usd(a.observedCost)} per day, ${pct}% ${dir} the ${usd(a.expectedCost)} per day seen in the prior ${config.baselineDays} days. If it stays at this level that is about ${formatCompactCurrency(diffAbs * 30)} ${increase ? 'more' : 'less'} per month.`
    : `On ${formatDate(a.date, 'long')}, ${where} cost ${usd(a.observedCost)}, ${pct}% ${dir} the ${usd(a.expectedCost)} it normally costs on a comparable day, which is ${usd(diffAbs)} ${increase ? 'more' : 'less'}.`;

  const acc = ctx.account;
  let contribution: string | null = null;
  if (acc.expected > 0 && Math.abs(acc.difference) >= 50) {
    contribution =
      acc.contributionPct !== null
        ? `${a.accountName} cost ${usd(acc.observed)} ${sustained ? 'per day over the same window' : 'that day'} versus about ${usd(acc.expected)} typically (${signed(acc.difference)}). ${a.serviceName} accounts for ${acc.contributionPct.toFixed(0)}% of that change.`
        : `${a.accountName} as a whole moved by ${signed(acc.difference)} versus typical, so other services in the account moved the opposite way and partly masked this change.`;
  }

  let concurrentNote: string | null = null;
  if (ctx.concurrent.length > 0) {
    const names = ctx.concurrent.slice(0, 3).map((c) => `${serviceNameOf(c.serviceId)} ${KIND_LABELS[c.kind].toLowerCase()} on ${formatDate(c.date, 'short')}`);
    concurrentNote = `${ctx.concurrent.length} other anomal${ctx.concurrent.length === 1 ? 'y' : 'ies'} fired in ${a.accountName} within two days: ${names.join(', ')}. Check whether they share a cause.`;
  }

  const investigateNext = increase ? [...CHECKS_INCREASE[category]] : [...CHECKS_DECREASE];
  const alertLevel = usd(a.expectedCost * 1.3);
  const recommendedActions = increase
    ? [
        `Ask ${ownerName} (${teamName}) whether this was planned work or an unexpected change.`,
        sustained
          ? `If the new level is intended, update the ${a.accountName} budget and forecast. If not, review changes made around ${formatDate(ctx.windowStart, 'short')}.`
          : 'If the cost has already returned to normal, mark the anomaly resolved and record what you found.',
        `Add a daily cost alert for ${a.serviceName} in ${a.accountName} at about ${alertLevel} (30% above expected).`,
      ]
    : [
        `Ask ${ownerName} (${teamName}) whether decommissioning, rightsizing or a planned shutdown explains it.`,
        'If the workload should still be running, confirm it is healthy and that billing data is complete.',
        'If the decrease is permanent, lower the expected baseline in budgets and forecasts so it is not read as an overrun later.',
      ];

  const evidence: Evidence[] = [
    { label: sustained ? 'Observed (daily median)' : 'Observed cost', value: usd(a.observedCost) },
    { label: 'Expected cost', value: usd(a.expectedCost) },
    { label: 'Difference', value: `${signed(a.differenceCost)} per day` },
    { label: 'Change', value: signedPct(a.changePct) },
    { label: 'Detection window', value: `${a.windowDays} day${a.windowDays === 1 ? '' : 's'}` },
  ];
  if (acc.contributionPct !== null) evidence.push({ label: `Share of ${a.accountName} change`, value: formatPercent(acc.contributionPct, 0) });

  return {
    headline: `${a.serviceName} ${KIND_LABELS[a.kind].toLowerCase()} in ${a.accountName}`,
    whatChanged,
    contribution,
    concurrentNote,
    investigateNext,
    recommendedActions,
    evidence,
  };
}
