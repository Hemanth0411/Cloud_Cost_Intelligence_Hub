import { dayOfWeek, eachDay } from '@/lib/dates';
import type { DailyCost, MockAccount, MockService } from '@/types/domain';
import {
  ACCOUNT_GENERATION,
  CATEGORY_WEEKEND_SENSITIVITY,
  ENVIRONMENT_WEEKEND_FACTOR,
  SERVICE_PROFILE,
} from './catalog';
import { createRng, hashString, noise } from './seed';

/** Last day of data. Fixed so the dataset is identical on server and client. */
export const DATASET_END_DATE = '2026-10-11';
/** Starts on 1 Jan 2024 so yearly views cover 2024, 2025 and 2026 YTD. */
export const DATASET_START_DATE = '2024-01-01';

/** Scales the whole dataset so recent spend sits at a realistic enterprise level. */
const LEVEL = 1.22;

const SEED = 20261012;

/**
 * One-off incidents: a multiplier > 1 is a cost spike, < 1 is an unexpected decrease
 * (for example a stalled pipeline or missing usage). They give the detector real signal.
 *
 * Every entry sits at least 16 days inside the dataset, so both detectors have their
 * full baseline before it: the client rule engine needs `baselineDays` (28) of history
 * and the server MadDetector needs `min_history` (14) out of a `window` of 28.
 */
interface Incident {
  accountId: string;
  serviceId: string;
  daysAgo: number;
  durationDays: number;
  multiplier: number;
}

const INCIDENTS: Incident[] = [
  // Recent spikes (visible in the default 30-day view)
  { accountId: 'aws-ml-research', serviceId: 'aws-sagemaker', daysAgo: 2, durationDays: 1, multiplier: 3.4 },
  { accountId: 'aws-prod-core', serviceId: 'aws-ec2', daysAgo: 4, durationDays: 2, multiplier: 2.3 },
  { accountId: 'azure-ai-services', serviceId: 'azure-openai', daysAgo: 9, durationDays: 3, multiplier: 3.1 },
  { accountId: 'gcp-bigquery-warehouse', serviceId: 'gcp-bigquery', daysAgo: 15, durationDays: 1, multiplier: 4.2 },
  { accountId: 'aws-data-lake', serviceId: 'aws-s3', daysAgo: 22, durationDays: 2, multiplier: 2.7 },
  { accountId: 'azure-analytics-hub', serviceId: 'azure-synapse', daysAgo: 41, durationDays: 2, multiplier: 2.3 },
  // Runaway autoscaling in a GKE node pool, which bills as Compute Engine --
  // not as Kubernetes Engine, which only charges for the control plane.
  { accountId: 'gcp-customer-web', serviceId: 'gcp-gce', daysAgo: 63, durationDays: 3, multiplier: 2.1 },
  // A SPIKE THAT RETURNS. Month-end reporting pulls a full extract across
  // regions, three billing cycles running: the shape a FinOps team actually
  // chases, because each occurrence resolves itself and the cause does not.
  // The detector reports it three times, which is the point.
  { accountId: 'aws-prod-core', serviceId: 'aws-datatransfer', daysAgo: 7, durationDays: 1, multiplier: 3.6 },
  { accountId: 'aws-prod-core', serviceId: 'aws-datatransfer', daysAgo: 36, durationDays: 1, multiplier: 3.3 },
  { accountId: 'aws-prod-core', serviceId: 'aws-datatransfer', daysAgo: 66, durationDays: 1, multiplier: 3.1 },
  // Historical spikes
  { accountId: 'aws-prod-core', serviceId: 'aws-rds', daysAgo: 88, durationDays: 2, multiplier: 2.2 },
  { accountId: 'azure-enterprise-apps', serviceId: 'azure-vm', daysAgo: 118, durationDays: 3, multiplier: 2.0 },
  { accountId: 'gcp-ml-lab', serviceId: 'gcp-vertex', daysAgo: 150, durationDays: 2, multiplier: 3.5 },
  { accountId: 'aws-data-lake', serviceId: 'aws-redshift', daysAgo: 187, durationDays: 2, multiplier: 2.6 },
  { accountId: 'azure-ai-services', serviceId: 'azure-openai', daysAgo: 230, durationDays: 3, multiplier: 2.8 },
  { accountId: 'aws-prod-core', serviceId: 'aws-cloudfront', daysAgo: 275, durationDays: 2, multiplier: 3.0 },
  { accountId: 'gcp-bigquery-warehouse', serviceId: 'gcp-bigquery', daysAgo: 330, durationDays: 1, multiplier: 3.8 },
  { accountId: 'aws-ml-research', serviceId: 'aws-sagemaker', daysAgo: 392, durationDays: 3, multiplier: 3.0 },
  { accountId: 'azure-analytics-hub', serviceId: 'azure-synapse', daysAgo: 455, durationDays: 2, multiplier: 2.4 },
  { accountId: 'aws-prod-core', serviceId: 'aws-ec2', daysAgo: 520, durationDays: 3, multiplier: 2.1 },
  { accountId: 'gcp-customer-web', serviceId: 'gcp-gce', daysAgo: 610, durationDays: 2, multiplier: 2.3 },
  { accountId: 'azure-enterprise-apps', serviceId: 'azure-sql', daysAgo: 700, durationDays: 2, multiplier: 2.5 },
  { accountId: 'aws-data-lake', serviceId: 'aws-s3', daysAgo: 790, durationDays: 3, multiplier: 3.2 },
  { accountId: 'aws-prod-core', serviceId: 'aws-datatransfer', daysAgo: 880, durationDays: 2, multiplier: 3.4 },
  // Unexpected decreases
  { accountId: 'gcp-customer-web', serviceId: 'gcp-networking', daysAgo: 11, durationDays: 1, multiplier: 0.15 },
  { accountId: 'aws-data-lake', serviceId: 'aws-redshift', daysAgo: 26, durationDays: 2, multiplier: 0.1 },
  { accountId: 'azure-ai-services', serviceId: 'azure-cosmos', daysAgo: 95, durationDays: 1, multiplier: 0.2 },
  { accountId: 'aws-prod-core', serviceId: 'aws-lambda', daysAgo: 240, durationDays: 2, multiplier: 0.15 },
  { accountId: 'gcp-bigquery-warehouse', serviceId: 'gcp-vertex', daysAgo: 420, durationDays: 1, multiplier: 0.12 },
];

/**
 * Permanent step changes in a service's daily cost (ramping over a few days). Above 1 is a
 * sustained increase, below 1 a sustained decrease. The cost stays at the new level.
 *
 * Effect size and RAMP LENGTH both matter, not just direction:
 *
 *  - a shift has to clear the detector's dollar floor (`sustainedMinDailyDelta`,
 *    $120/day on the balanced preset), and
 *  - `rampDays` has to be short relative to `sustainedWindowDays` (7). A step
 *    spread over six days never gets the 7-day window fully above the 28-day
 *    baseline: a 32% rise ramped over 6 days peaks at a 21% window ratio and
 *    falls under `sustainedIncreasePct`. That is the detector working as
 *    designed -- a slow ramp is what the SERVER detector's `creep` rule is
 *    for -- but a slow ramp planted here is an event no screen ever shows.
 *
 * `scripts/verify-data.ts` asserts every entry here reaches a finding.
 */
interface LevelShift {
  accountId: string;
  serviceId: string;
  /** Days before the dataset end when the shift begins. */
  daysAgo: number;
  rampDays: number;
  multiplier: number;
}

const LEVEL_SHIFTS: LevelShift[] = [
  { accountId: 'aws-ml-research', serviceId: 'aws-s3', daysAgo: 16, rampDays: 2, multiplier: 1.7 },
  // Node pools added for a new model deployment: the step lands on Virtual
  // Machines, where AKS node hours are billed.
  { accountId: 'azure-ai-services', serviceId: 'azure-vm', daysAgo: 24, rampDays: 3, multiplier: 1.35 },
  { accountId: 'gcp-customer-web', serviceId: 'gcp-cloudsql', daysAgo: 38, rampDays: 4, multiplier: 1.45 },
  { accountId: 'aws-staging', serviceId: 'aws-ec2', daysAgo: 47, rampDays: 2, multiplier: 0.6 },
  { accountId: 'aws-prod-core', serviceId: 'aws-ec2', daysAgo: 120, rampDays: 2, multiplier: 1.32 },
  { accountId: 'azure-enterprise-apps', serviceId: 'azure-vm', daysAgo: 170, rampDays: 5, multiplier: 1.3 },
  // Deep enough to clear the detector's dollar floor: a lifecycle policy that
  // expires a stale dataset, and released reserved capacity in a dev lab.
  { accountId: 'gcp-bigquery-warehouse', serviceId: 'gcp-gcs', daysAgo: 220, rampDays: 4, multiplier: 0.45 },
  { accountId: 'aws-data-lake', serviceId: 'aws-redshift', daysAgo: 300, rampDays: 4, multiplier: 1.45 },
  { accountId: 'gcp-ml-lab', serviceId: 'gcp-gce', daysAgo: 480, rampDays: 3, multiplier: 0.5 },
  { accountId: 'azure-analytics-hub', serviceId: 'azure-sql', daysAgo: 560, rampDays: 4, multiplier: 1.4 },
];

/** Every planted event, for `scripts/verify-data.ts` to assert the detector finds it. */
export const PLANTED_INCIDENTS: readonly Incident[] = INCIDENTS;
export const PLANTED_LEVEL_SHIFTS: readonly LevelShift[] = LEVEL_SHIFTS;

const round2 = (value: number): number => Math.round(value * 100) / 100;

export function generateDailyCosts(accounts: MockAccount[], services: MockService[]): DailyCost[] {
  const serviceById = new Map(services.map((s) => [s.id, s]));
  const dates = eachDay(DATASET_START_DATE, DATASET_END_DATE);
  const lastIndex = dates.length - 1;
  const rows: DailyCost[] = [];

  for (const account of accounts) {
    const gen = ACCOUNT_GENERATION[account.id];
    if (!gen) continue;
    const environmentDip = ENVIRONMENT_WEEKEND_FACTOR[account.environment];

    for (const serviceId of gen.serviceIds) {
      const service = serviceById.get(serviceId);
      const profile = SERVICE_PROFILE[serviceId];
      if (!service || !profile) continue;

      // Only the elastic part of a category's bill falls at the weekend, so a
      // storage line stays flat while compute in the same account halves.
      const weekendFactor =
        1 - (1 - environmentDip) * CATEGORY_WEEKEND_SENSITIVITY[service.category];

      const incidents = INCIDENTS.filter((i) => i.accountId === account.id && i.serviceId === serviceId);
      const shifts = LEVEL_SHIFTS.filter((s) => s.accountId === account.id && s.serviceId === serviceId);

      // Each (account, service) series gets its own stable personality.
      const rng = createRng(SEED ^ hashString(`${account.id}:${serviceId}`));
      // Exponential growth anchored to today: older days were cheaper (7-24% yearly growth).
      const growthRate = 0.0002 + rng() * 0.0005;
      const seasonPhase = rng() * Math.PI * 2;
      const volatility = 0.035 + rng() * 0.04;
      const share = 0.75 + rng() * 0.5;
      const base = profile.baseDailyCost * gen.scale * share * LEVEL;

      dates.forEach((date, index) => {
        const age = lastIndex - index;
        const dow = dayOfWeek(date);
        const weekend = dow === 0 || dow === 6;

        let multiplier = 1;
        for (const inc of incidents) {
          if (age >= inc.daysAgo && age <= inc.daysAgo + inc.durationDays - 1) multiplier *= inc.multiplier;
        }
        for (const shift of shifts) {
          if (age > shift.daysAgo) continue;
          const progress = Math.min(1, (shift.daysAgo - age + 1) / shift.rampDays);
          multiplier *= 1 + (shift.multiplier - 1) * progress;
        }

        const cost =
          base *
          Math.exp(-growthRate * age) *
          (1 + 0.05 * Math.sin(index / 9 + seasonPhase)) *
          (weekend ? weekendFactor : 1) *
          (1 + volatility * noise(rng)) *
          multiplier;

        rows.push({
          date,
          providerId: account.providerId,
          accountId: account.id,
          serviceId,
          cost: round2(Math.max(cost, 0.5)),
        });
      });
    }
  }
  return rows;
}
