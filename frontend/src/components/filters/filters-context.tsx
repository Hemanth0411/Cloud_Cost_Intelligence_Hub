'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { getFilterOptions } from '@/lib/services/cost-service';
import type { DateRangePreset, Filters } from '@/types/analytics';
import type { ProviderId } from '@/types/domain';

export const DEFAULT_FILTERS: Filters = {
  range: '30d',
  customFrom: null,
  customTo: null,
  providerId: 'all',
  accountId: 'all',
  serviceId: 'all',
};

const RANGES: readonly DateRangePreset[] = ['7d', '30d', '90d', 'mtd', 'ytd', '12m', 'custom'];
const PROVIDERS: readonly ProviderId[] = ['aws', 'azure', 'gcp'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isRange = (v: string | null): v is DateRangePreset => v !== null && (RANGES as readonly string[]).includes(v);
const isProvider = (v: string | null): v is ProviderId => v !== null && (PROVIDERS as readonly string[]).includes(v);

function validDate(value: string | null, min: string, max: string): string | null {
  if (!value || !ISO_DATE.test(value) || value < min || value > max) return null;
  return value;
}

/**
 * Keeps provider -> account -> service consistent: a more specific filter that
 * no longer fits its parent (e.g. an Azure service under AWS) resets to "all".
 */
function normalize(filters: Filters): Filters {
  const { accounts, services, serviceIdsByAccount, dataStart, dataEnd } = getFilterOptions();
  let { accountId, serviceId } = filters;
  const { providerId } = filters;

  if (accountId !== 'all') {
    const account = accounts.find((a) => a.id === accountId);
    if (!account || (providerId !== 'all' && account.providerId !== providerId)) accountId = 'all';
  }
  if (serviceId !== 'all') {
    const service = services.find((s) => s.id === serviceId);
    const fitsProvider = service !== undefined && (providerId === 'all' || service.providerId === providerId);
    // Unknown (null) means the source cannot say which services an
    // account uses. Treat that as "it fits": clearing the filter
    // because we could not verify it would silently widen a deep
    // link, and the API answers a pair with no rows honestly anyway.
    const fitsAccount =
      accountId === 'all' ||
      serviceIdsByAccount === null ||
      (serviceIdsByAccount[accountId] ?? []).includes(serviceId);
    if (!fitsProvider || !fitsAccount) serviceId = 'all';
  }

  let { range, customFrom, customTo } = filters;
  if (range === 'custom') {
    customFrom = validDate(customFrom, dataStart, dataEnd);
    customTo = validDate(customTo, dataStart, dataEnd);
    if (!customFrom || !customTo) {
      range = DEFAULT_FILTERS.range;
      customFrom = null;
      customTo = null;
    }
  } else {
    customFrom = null;
    customTo = null;
  }
  return { range, customFrom, customTo, providerId, accountId, serviceId };
}

function parseFilters(params: URLSearchParams): Filters {
  const rangeParam = params.get('range');
  const providerParam = params.get('provider');
  return normalize({
    range: isRange(rangeParam) ? rangeParam : DEFAULT_FILTERS.range,
    customFrom: params.get('from'),
    customTo: params.get('to'),
    providerId: isProvider(providerParam) ? providerParam : 'all',
    accountId: params.get('account') ?? 'all',
    serviceId: params.get('service') ?? 'all',
  });
}

function serialize(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.range !== DEFAULT_FILTERS.range) params.set('range', filters.range);
  if (filters.range === 'custom' && filters.customFrom && filters.customTo) {
    params.set('from', filters.customFrom);
    params.set('to', filters.customTo);
  }
  if (filters.providerId !== 'all') params.set('provider', filters.providerId);
  if (filters.accountId !== 'all') params.set('account', filters.accountId);
  if (filters.serviceId !== 'all') params.set('service', filters.serviceId);
  return params.toString();
}

interface FiltersContextValue {
  filters: Filters;
  setFilters: (patch: Partial<Filters>) => void;
  reset: () => void;
  isDefault: boolean;
}

const FiltersContext = createContext<FiltersContextValue | null>(null);

/** Filter state lives in the URL, so views are shareable and back/forward just works. */
export function FiltersProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const key = searchParams.toString();

  const filters = useMemo(() => parseFilters(new URLSearchParams(key)), [key]);

  const navigate = useCallback(
    (next: Filters) => {
      const qs = serialize(next);
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname],
  );

  const setFilters = useCallback(
    (patch: Partial<Filters>) => navigate(normalize({ ...filters, ...patch })),
    [filters, navigate],
  );

  const reset = useCallback(() => navigate(DEFAULT_FILTERS), [navigate]);

  const value = useMemo<FiltersContextValue>(
    () => ({ filters, setFilters, reset, isDefault: serialize(filters) === '' }),
    [filters, setFilters, reset],
  );

  return <FiltersContext.Provider value={value}>{children}</FiltersContext.Provider>;
}

export function useFilters(): FiltersContextValue {
  const ctx = useContext(FiltersContext);
  if (!ctx) throw new Error('useFilters must be used within <FiltersProvider>');
  return ctx;
}
