import { getFilterOptions } from '@/lib/services/cost-service';
import type { DateRangePreset } from '@/types/analytics';

interface DashboardLinkOptions {
  providerId?: string;
  accountId?: string;
  serviceId?: string;
  range?: DateRangePreset;
}

/** Builds a dashboard URL pre-filtered to an account and/or service (filters live in the URL). */
export function dashboardLink({ providerId: onlyProvider, accountId, serviceId, range }: DashboardLinkOptions): string {
  const { accounts, services, serviceIdsByAccount } = getFilterOptions();
  const account = accountId ? accounts.find((a) => a.id === accountId) : undefined;
  const service = serviceId ? services.find((s) => s.id === serviceId) : undefined;
  // `serviceIdsByAccount` is null when the source cannot say which
  // services an account uses. Unknown means KEEP the service filter:
  // dropping it would silently widen the link to the whole account,
  // and the API answers an account+service pair that has no rows with
  // an honest empty result anyway.
  const serviceFits =
    service !== undefined &&
    (!account ||
      serviceIdsByAccount === null ||
      (serviceIdsByAccount[account.id] ?? []).includes(service.id));

  const params = new URLSearchParams();
  if (range && range !== '30d' && range !== 'custom') params.set('range', range);
  const providerId = account?.providerId ?? (serviceFits ? service?.providerId : undefined) ?? onlyProvider;
  if (providerId) params.set('provider', providerId);
  if (account) params.set('account', account.id);
  if (service && serviceFits) params.set('service', service.id);
  const qs = params.toString();
  return qs ? `/dashboard?${qs}` : '/dashboard';
}
