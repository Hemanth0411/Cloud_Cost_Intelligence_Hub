/**
 * Filter options, live.
 *
 * WHAT THE API CAN AND CANNOT SAY HERE:
 *
 *  * ACCOUNTS come from `GET /meta/accounts`, already scoped by the
 *    caller's grants, which is the point: a restricted user's dropdown
 *    contains only their accounts.
 *  * PROVIDERS are not an endpoint. They are the distinct `provider`
 *    values of the accounts the caller can see, which is the honest
 *    definition -- a provider with no visible account is not a
 *    provider this user has.
 *  * SERVICES come from a breakdown over the whole history window.
 *    There is no `/meta/services` without an account, and the one that
 *    exists returns names for a single account at a time.
 *  * WHICH SERVICES EACH ACCOUNT USES would be one breakdown per
 *    account. It is `null`, and the screens that used it (the
 *    "Accounts" count on /services, the service-fits-account check in
 *    `dashboardLink`) must handle not knowing rather than show 0.
 *
 * THE DATE BOUNDS ARE NOT A GUESS. `dataEnd` is yesterday UTC, because
 * cost data lags 8-24h and today is always partial -- the same rule
 * `envelope.is_partial` applies server-side. `dataStart` is a query
 * horizon, not a claim that data exists that far back; the dashboard
 * narrows it to the first day that actually returned rows once it has
 * them.
 */
import { addDays, toISO } from '@/lib/dates';
import { fetchAccounts, fetchBreakdown, type MetaAccount } from '@/lib/api/cost-api';
import type { Account, Provider, ProviderId, Service } from '@/types/domain';

/** How far back any "whole history" query reaches. */
const HISTORY_YEARS = 3;

const PROVIDER_NAMES: Record<ProviderId, string> = {
  aws: 'Amazon Web Services',
  azure: 'Microsoft Azure',
  gcp: 'Google Cloud',
};

const KNOWN: readonly ProviderId[] = ['aws', 'azure', 'gcp'];

export const isProviderId = (value: string): value is ProviderId =>
  (KNOWN as readonly string[]).includes(value);

/**
 * Yesterday, UTC.
 *
 * Not "today": `fact_cost_daily` is written by an ingest that lags,
 * and a range ending today reads as a cliff-edge drop on the last
 * bar. The server flags the window `partial_period` for exactly this
 * reason; stopping at yesterday keeps the charts honest without
 * needing the flag.
 */
export function liveDataEnd(now: Date = new Date()): string {
  return toISO(new Date(now.getTime() - 86_400_000));
}

export function liveHistoryStart(end: string): string {
  return addDays(end, -365 * HISTORY_YEARS);
}

export interface LiveOptions {
  providers: Provider[];
  accounts: Account[];
  services: Service[];
  dataStart: string;
  dataEnd: string;
  /** Rows whose provider is not one of the three the UI can colour. */
  unknownProviders: string[];
}

function toAccount(row: MetaAccount): Account | null {
  if (!isProviderId(row.provider)) return null;
  return {
    id: row.accountId,
    providerId: row.provider,
    name: row.accountName ?? row.accountId,
    // In live mode the account id IS the cloud-native identifier, so
    // this is the same value rather than an invented one.
    externalId: row.accountId,
    environment: null,
    team: null,
    owner: null,
    region: null,
    monthlyBudget: null,
  };
}

/**
 * Everything the filter bar needs.
 *
 * The service list is fetched per provider so each name carries the
 * provider it belongs to. One combined call would return bare service
 * names, and `BreakdownItem.providerId` would then have to be guessed
 * -- "EC2" is unambiguous, "Storage" is not.
 */
export async function loadLiveOptions(): Promise<LiveOptions> {
  const end = liveDataEnd();
  const start = liveHistoryStart(end);
  const { data: rows } = await fetchAccounts();

  // A provider the UI has no colour, name or short label for cannot
  // be rendered, so its accounts are dropped from the options -- but
  // SILENTLY dropping them is how spend goes missing without anyone
  // noticing, so it is said out loud. Unreachable today: the ingest
  // adapters write only 'aws' and 'azure'.
  const unknownProviders = [...new Set(rows.map((r) => r.provider).filter((p) => !isProviderId(p)))];
  if (unknownProviders.length > 0 && typeof console !== 'undefined') {
    console.warn(
      `[costhub] ignoring account(s) from unsupported provider(s): ${unknownProviders.join(', ')}. ` +
        'Their spend will not appear in the provider breakdown.',
    );
  }
  const accounts = rows.flatMap((r) => {
    const account = toAccount(r);
    return account ? [account] : [];
  });

  const providerIds = [...new Set(accounts.map((a) => a.providerId))];
  const providers: Provider[] = providerIds.map((id) => ({
    id,
    name: PROVIDER_NAMES[id],
    // Connection health is a simulation; nothing measures it.
    status: null,
    lastSyncedAt: null,
  }));

  const perProvider = await Promise.all(
    providerIds.map(async (provider) => {
      const envelope = await fetchBreakdown({ start, end, dimension: 'service', provider });
      return envelope.data.map((row): Service => ({
        id: row.key,
        providerId: provider,
        name: row.key,
        category: null,
      }));
    }),
  );

  // DEDUPE ON THE NAME, NOT ON PROVIDER + NAME.
  //
  // The id has to be the bare service name because that is the only
  // thing `?service=` can be filtered by, and `filters.serviceId` is
  // one string. So if two providers both bill a service called
  // "Storage" there can only be one entry, and selecting it narrows
  // to both -- which is what filtering by that name means. The first
  // provider wins the colour swatch; nothing else depends on it.
  const seen = new Set<string>();
  const services: Service[] = [];
  for (const service of perProvider.flat()) {
    if (seen.has(service.id)) continue;
    seen.add(service.id);
    services.push(service);
  }
  services.sort((a, b) => a.name.localeCompare(b.name));

  return { providers, accounts, services, dataStart: start, dataEnd: end, unknownProviders };
}
