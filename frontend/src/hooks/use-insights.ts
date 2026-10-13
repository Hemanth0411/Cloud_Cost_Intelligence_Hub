'use client';

import { useCallback } from 'react';
import { useAsyncData, type AsyncState } from '@/hooks/use-async-data';
import { fetchInsights, type InsightsResponse } from '@/lib/api/insights-api';
import type { CostScope } from '@/lib/api/cost-api';

export interface InsightsQuery extends CostScope {
  start?: string;
  end?: string;
}

export interface InsightsState {
  /** The cards and their figures. Never waits on a model. */
  figures: AsyncState<InsightsResponse>;
  /**
   * The same cards with sentences chosen. Arrives later, and may not
   * arrive at all -- in which case `figures` is still the whole truth.
   */
  narrated: AsyncState<InsightsResponse>;
}

/**
 * Load the insights in two steps: figures first, sentences second.
 *
 * TWO REQUESTS ON PURPOSE. The first passes `narrate=false`, which makes
 * no model call, so the numbers appear as fast as any other screen. The
 * second asks for the sentences and can take a second or two, or fail,
 * or be cut off -- none of which may leave the page without its figures.
 * One request would tie the two together, and "the model is slow" would
 * read on screen as "the cost data is missing".
 *
 * `attempt` is part of the key so "Try again" really does ask again.
 */
export function useInsights(query: InsightsQuery, attempt: number): InsightsState {
  const key = JSON.stringify([query, attempt]);
  const loadFigures = useCallback(() => fetchInsights({ ...query, narrate: false }), [query]);
  const loadNarrated = useCallback(() => fetchInsights({ ...query, narrate: true }), [query]);
  return {
    figures: useAsyncData(`${key}|figures`, loadFigures),
    narrated: useAsyncData(`${key}|narrated`, loadNarrated),
  };
}
