import { DEFAULT_ANOMALY_CONFIG, detectAnomalies } from '@/lib/selectors/detect-anomalies';
import type { DailyCost, DetectedAnomaly, MockAccount, MockProvider, MockService, ProviderId } from '@/types/domain';
import { ACCOUNTS, PROVIDERS, SERVICES } from './catalog';
import { DATASET_END_DATE, DATASET_START_DATE, generateDailyCosts } from './generate-costs';

export interface Dataset {
  providers: MockProvider[];
  accounts: MockAccount[];
  services: MockService[];
  costs: DailyCost[];
  anomalies: DetectedAnomaly[];
  startDate: string;
  endDate: string;
  providerById: Map<ProviderId, MockProvider>;
  accountById: Map<string, MockAccount>;
  serviceById: Map<string, MockService>;
  /** Services each account actually has spend in. */
  serviceIdsByAccount: Map<string, string[]>;
  /** Daily rows per (account, service), oldest first. Key: `${accountId}|${serviceId}`. */
  seriesByKey: Map<string, DailyCost[]>;
}

let cached: Dataset | null = null;

/** Builds the dataset once; the same instance powers every view. */
export function getDataset(): Dataset {
  if (cached) return cached;
  const costs = generateDailyCosts(ACCOUNTS, SERVICES);
  const anomalies = detectAnomalies(costs, DATASET_END_DATE, DEFAULT_ANOMALY_CONFIG);
  const byAccount = new Map<string, Set<string>>();
  const seriesByKey = new Map<string, DailyCost[]>();
  for (const row of costs) {
    const key = `${row.accountId}|${row.serviceId}`;
    const list = seriesByKey.get(key);
    if (list) list.push(row);
    else seriesByKey.set(key, [row]);
    const set = byAccount.get(row.accountId);
    if (set) set.add(row.serviceId);
    else byAccount.set(row.accountId, new Set([row.serviceId]));
  }
  cached = {
    providers: PROVIDERS,
    accounts: ACCOUNTS,
    services: SERVICES,
    costs,
    anomalies,
    startDate: DATASET_START_DATE,
    endDate: DATASET_END_DATE,
    providerById: new Map(PROVIDERS.map((p) => [p.id, p])),
    accountById: new Map(ACCOUNTS.map((a) => [a.id, a])),
    serviceById: new Map(SERVICES.map((s) => [s.id, s])),
    serviceIdsByAccount: new Map([...byAccount].map(([id, set]) => [id, [...set]])),
    seriesByKey,
  };
  return cached;
}
