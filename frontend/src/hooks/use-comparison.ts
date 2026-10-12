'use client';

import { useCallback } from 'react';
import { useAsyncData, type AsyncState } from '@/hooks/use-async-data';
import { loadComparison } from '@/lib/services/cost-service';
import type { BaselineKind, ComparisonResult, Filters } from '@/types/analytics';

export type ComparisonState = AsyncState<ComparisonResult>;

export function useComparison(filters: Filters, baseline: BaselineKind): ComparisonState {
  const key = JSON.stringify([filters, baseline]);
  const load = useCallback(() => loadComparison(filters, baseline), [filters, baseline]);
  return useAsyncData(key, load);
}
