'use client';

import { useMemo } from 'react';
import { readDashboardData } from '@/lib/services/cost-service';
import type { DashboardData, Filters, StatusOverrides } from '@/types/analytics';
import type { AnomalyConfig } from '@/types/domain';

export type DashboardState =
  | { status: 'loading' }
  | { status: 'ready'; data: DashboardData; isRefreshing: boolean };

/** Local mock data, so the page can render on the same turn as the sidebar click. */
export function useDashboardData(filters: Filters, statusOverrides: StatusOverrides, config: AnomalyConfig): DashboardState {
  const data = useMemo(
    () => readDashboardData(filters, statusOverrides, config),
    [filters, statusOverrides, config],
  );
  return { status: 'ready', data, isRefreshing: false };
}
