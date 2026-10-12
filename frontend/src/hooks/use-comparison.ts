'use client';

import { useMemo } from 'react';
import { readComparison } from '@/lib/services/cost-service';
import type { BaselineKind, ComparisonResult, Filters } from '@/types/analytics';

export type ComparisonState = { status: 'loading' } | { status: 'ready'; data: ComparisonResult; isRefreshing: boolean };

export function useComparison(filters: Filters, baseline: BaselineKind): ComparisonState {
  const data = useMemo(() => readComparison(filters, baseline), [filters, baseline]);
  return { status: 'ready', data, isRefreshing: false };
}
