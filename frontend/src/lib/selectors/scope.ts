import type { Dataset } from '@/lib/mock/dataset';
import type { DailyCost } from '@/types/domain';
import type { Filters } from '@/types/analytics';

export type ScopeFilters = Pick<Filters, 'providerId' | 'accountId' | 'serviceId'>;

export interface Scope {
  /** Cost rows matching provider / account / service (date range applied separately). */
  rows: DailyCost[];
  accountIds: Set<string>;
  serviceIds: Set<string>;
}

const cache = new WeakMap<Dataset, Map<string, Scope>>();

export function getScope(ds: Dataset, filters: ScopeFilters): Scope {
  let perDataset = cache.get(ds);
  if (!perDataset) {
    perDataset = new Map();
    cache.set(ds, perDataset);
  }
  const key = `${filters.providerId}|${filters.accountId}|${filters.serviceId}`;
  const hit = perDataset.get(key);
  if (hit) return hit;

  const rows = ds.costs.filter(
    (r) =>
      (filters.providerId === 'all' || r.providerId === filters.providerId) &&
      (filters.accountId === 'all' || r.accountId === filters.accountId) &&
      (filters.serviceId === 'all' || r.serviceId === filters.serviceId),
  );
  const scope: Scope = {
    rows,
    accountIds: new Set(rows.map((r) => r.accountId)),
    serviceIds: new Set(rows.map((r) => r.serviceId)),
  };
  perDataset.set(key, scope);
  return scope;
}

/** True when an entity (anomaly, cost row...) falls inside the provider/account/service filters. */
export function matchesScope(
  item: { providerId: string; accountId: string; serviceId: string },
  filters: ScopeFilters,
): boolean {
  return (
    (filters.providerId === 'all' || item.providerId === filters.providerId) &&
    (filters.accountId === 'all' || item.accountId === filters.accountId) &&
    (filters.serviceId === 'all' || item.serviceId === filters.serviceId)
  );
}
