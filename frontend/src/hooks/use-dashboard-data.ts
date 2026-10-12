'use client';

import { useCallback } from 'react';
import { useAsyncData, type AsyncState } from '@/hooks/use-async-data';
import { loadDashboardData } from '@/lib/services/cost-service';
import type { DashboardData, Filters, StatusOverrides } from '@/types/analytics';
import type { AnomalyConfig } from '@/types/domain';

export type DashboardState = AsyncState<DashboardData>;

/**
 * The dashboard's data, for whichever mode is running.
 *
 * It used to be a `useMemo` over the in-memory mock, which is why
 * every view has a `status === 'loading'` branch that could never be
 * reached. Live mode makes five or more requests here, so the branch
 * is now the first thing anyone sees.
 */
export function useDashboardData(
  filters: Filters,
  statusOverrides: StatusOverrides,
  config: AnomalyConfig,
): DashboardState {
  const key = JSON.stringify([filters, statusOverrides, config]);
  const load = useCallback(
    () => loadDashboardData(filters, statusOverrides, config),
    [filters, statusOverrides, config],
  );
  return useAsyncData(key, load);
}
