'use client';

import { useMemo } from 'react';
import { readAnomalyData, type AnomalyPageData } from '@/lib/services/cost-service';
import type { Filters, StatusOverrides } from '@/types/analytics';
import type { AnomalyConfig } from '@/types/domain';

export type AnomalyDataState =
  | { status: 'loading' }
  | { status: 'ready'; data: AnomalyPageData; isRefreshing: boolean };

/** Loads anomalies for the current filters and detection thresholds. */
export function useAnomalyData(filters: Filters, overrides: StatusOverrides, config: AnomalyConfig): AnomalyDataState {
  const data = useMemo(() => readAnomalyData(filters, config, overrides), [filters, overrides, config]);
  return { status: 'ready', data, isRefreshing: false };
}
