'use client';

import { useCallback } from 'react';
import { useAsyncData, type AsyncState } from '@/hooks/use-async-data';
import { loadAnomalyData, type AnomalyPageData } from '@/lib/services/cost-service';
import type { Filters, StatusOverrides } from '@/types/analytics';
import type { AnomalyConfig } from '@/types/domain';

export type AnomalyDataState = AsyncState<AnomalyPageData>;

/**
 * Loads anomalies for the current filters. In live mode the detection thresholds only bucket severity.
 * Bump `refresh` to refetch with the same inputs, e.g. after a detection run.
 */
export function useAnomalyData(
  filters: Filters,
  overrides: StatusOverrides,
  config: AnomalyConfig,
  refresh = 0,
): AnomalyDataState {
  const key = JSON.stringify([filters, overrides, config, refresh]);
  const load = useCallback(() => loadAnomalyData(filters, config, overrides), [filters, config, overrides]);
  return useAsyncData(key, load);
}
