'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { buildInsightBundle, type InsightBundle } from '@/lib/services/cost-service';
import type { Filters, StatusOverrides } from '@/types/analytics';
import type { AnomalyConfig, CostInsight } from '@/types/domain';

/** The stages shown while the (simulated) analysis runs. The real work is a synchronous rule pass. */
export const ANALYSIS_STEPS = [
  'Scanning cost records',
  'Comparing against the previous period',
  'Running anomaly rules',
  'Estimating savings opportunities',
  'Writing plain-English explanations',
] as const;

export interface RefreshDiff {
  added: number;
  updated: number;
  removed: number;
}

export interface InsightReportState {
  status: 'analyzing' | 'ready';
  /** Stages completed so far while analyzing. */
  step: number;
  bundle: InsightBundle | null;
  generatedAt: Date | null;
  /** Increments when the summary text should animate (first load and manual refresh). */
  animationId: number;
  /** What changed since the previous analysis. Set after a manual refresh. */
  lastDiff: RefreshDiff | null;
}

export function diffInsights(previous: readonly CostInsight[], next: readonly CostInsight[]): RefreshDiff {
  const before = new Map(previous.map((i) => [i.id, `${i.title}|${i.summary}`]));
  const after = new Map(next.map((i) => [i.id, `${i.title}|${i.summary}`]));
  let added = 0;
  let updated = 0;
  for (const [id, text] of after) {
    const old = before.get(id);
    if (old === undefined) added += 1;
    else if (old !== text) updated += 1;
  }
  let removed = 0;
  for (const id of before.keys()) if (!after.has(id)) removed += 1;
  return { added, updated, removed };
}

type Mode = 'initial' | 'manual' | 'quick' | 'silent';

/**
 * Generates the insight report for the current filters. Re-runs when filters or thresholds change,
 * when anomaly statuses change (instantly), or when the user presses refresh (full animated pass).
 */
export function useInsightReport(filters: Filters, overrides: StatusOverrides, config: AnomalyConfig) {
  const [state, setState] = useState<InsightReportState>(() => {
    const bundle = buildInsightBundle(filters, overrides, config);
    return {
      status: 'ready',
      step: ANALYSIS_STEPS.length,
      bundle,
      generatedAt: new Date(),
      animationId: 1,
      lastDiff: null,
    };
  });
  const [nonce, setNonce] = useState(0);
  const [failure, setFailure] = useState<Error | null>(null);
  const previous = useRef<InsightBundle | null>(null);
  const seen = useRef<{ filters: Filters | null; config: AnomalyConfig | null; nonce: number; loaded: boolean }>({
    filters,
    config,
    nonce: 0,
    loaded: true,
  });

  useEffect(() => {
    let cancelled = false;
    const timers: number[] = [];
    const s = seen.current;
    const manual = nonce !== s.nonce;
    const contextChanged = s.filters !== filters || s.config !== config;
    s.nonce = nonce;
    s.filters = filters;
    s.config = config;
    const mode: Mode = !s.loaded ? 'initial' : manual ? 'manual' : contextChanged ? 'quick' : 'silent';

    const finish = (): void => {
      if (cancelled) return;
      let bundle: InsightBundle;
      try {
        bundle = buildInsightBundle(filters, overrides, config);
      } catch (error) {
        setFailure(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const diff = mode === 'manual' ? diffInsights(previous.current?.report.insights ?? [], bundle.report.insights) : null;
      previous.current = bundle;
      s.loaded = true;
      setState((prev) => ({
        status: 'ready',
        step: ANALYSIS_STEPS.length,
        bundle,
        generatedAt: mode === 'silent' && prev.generatedAt ? prev.generatedAt : new Date(),
        animationId: prev.animationId + (mode === 'initial' || mode === 'manual' ? 1 : 0),
        lastDiff: mode === 'manual' ? diff : mode === 'silent' ? prev.lastDiff : null,
      }));
    };

    if (mode !== 'manual') {
      finish();
      return () => {
        cancelled = true;
      };
    }

    const stepCount = mode === 'quick' ? 2 : ANALYSIS_STEPS.length;
    const stepMs = mode === 'manual' ? 420 : mode === 'initial' ? 170 : 110;
    setState((prev) => ({ ...prev, status: 'analyzing', step: 0 }));
    for (let i = 1; i <= stepCount; i += 1) {
      timers.push(window.setTimeout(() => !cancelled && setState((prev) => ({ ...prev, step: i })), i * stepMs));
    }
    timers.push(window.setTimeout(finish, stepCount * stepMs + 80));

    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [filters, overrides, config, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  if (failure) throw failure;
  return { state, refresh };
}
