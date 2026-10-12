import { hashString } from '@/lib/mock/seed';
import type { AccountConnection, MockAccount, MockProvider } from '@/types/domain';

const iso = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`;

/**
 * Starting connection state for each account, derived from its provider's health. Syncs are staggered by a
 * deterministic number of minutes so the "last synchronization" column looks real.
 */
export function baseConnection(account: MockAccount, provider: MockProvider): AccountConnection {
  const minutesBehind = hashString(account.id) % 40;
  return {
    status: provider.status,
    lastSyncedAt: iso(Date.parse(provider.lastSyncedAt) - minutesBehind * 60_000),
    changedAt: null,
  };
}
