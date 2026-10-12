import { z } from 'zod';
import type { AnomalyConfig } from '@/types/domain';

const num = (min: number, max: number) => z.number().finite().min(min).max(max);

/** Validates persisted or user-edited detection settings. Ranges here match the settings form. */
export const anomalyConfigSchema = z
  .object({
    baselineDays: num(14, 56),
    minBaselineSamples: num(3, 20),
    spikeSigma: num(1, 10),
    spikeMinPct: num(5, 500),
    dropSigma: num(1, 10),
    dropMinPct: num(5, 95),
    minDailyDelta: num(0, 5000),
    sustainedWindowDays: num(5, 14),
    sustainedIncreasePct: num(5, 300),
    sustainedDecreasePct: num(5, 95),
    sustainedMinDailyDelta: num(0, 5000),
    severity: z.object({
      mediumPct: num(1, 1000),
      highPct: num(1, 1000),
      criticalPct: num(1, 1000),
      mediumImpact: num(0, 100000),
      highImpact: num(0, 100000),
      criticalImpact: num(0, 100000),
    }),
  })
  .refine((c) => c.severity.mediumPct < c.severity.highPct && c.severity.highPct < c.severity.criticalPct, {
    message: 'Severity % thresholds must increase: medium < high < critical',
    path: ['severity'],
  })
  .refine((c) => c.severity.mediumImpact < c.severity.highImpact && c.severity.highImpact < c.severity.criticalImpact, {
    message: 'Severity $ thresholds must increase: medium < high < critical',
    path: ['severity'],
  });

export function parseAnomalyConfig(raw: unknown): AnomalyConfig | null {
  const parsed = anomalyConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
