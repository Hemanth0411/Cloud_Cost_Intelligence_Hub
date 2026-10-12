import type { AnomalyConfig } from '@/types/domain';

/** Settings-form field specs and zod-free validation (so it can run anywhere, including tests). */
export interface ConfigField {
  key: Exclude<keyof AnomalyConfig, 'severity' | 'minBaselineSamples'>;
  label: string;
  help: string;
  unit: string;
  min: number;
  max: number;
  step: number;
}

export interface SeverityField {
  key: keyof AnomalyConfig['severity'];
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
}

export const SPIKE_DROP_FIELDS: readonly ConfigField[] = [
  { key: 'spikeMinPct', label: 'Spike: minimum increase', help: 'Flag a day this far above what a comparable day normally costs.', unit: '%', min: 5, max: 500, step: 5 },
  { key: 'spikeSigma', label: 'Spike: statistical strictness', help: 'Also require it to exceed normal by this many robust standard deviations.', unit: 'σ', min: 1, max: 10, step: 0.5 },
  { key: 'dropMinPct', label: 'Drop: minimum decrease', help: 'Flag a day this far below normal (possible outage, stopped job or missing data).', unit: '%', min: 5, max: 95, step: 5 },
  { key: 'dropSigma', label: 'Drop: statistical strictness', help: 'Robust standard deviations below normal.', unit: 'σ', min: 1, max: 10, step: 0.5 },
  { key: 'minDailyDelta', label: 'Ignore changes smaller than', help: 'Filters out noise on cheap services.', unit: '$ / day', min: 0, max: 5000, step: 10 },
  { key: 'baselineDays', label: 'Baseline length', help: 'Trailing days used to learn what is normal.', unit: 'days', min: 14, max: 56, step: 7 },
];

export const SUSTAINED_FIELDS: readonly ConfigField[] = [
  { key: 'sustainedWindowDays', label: 'Recent window', help: 'Days of recent cost compared with the baseline.', unit: 'days', min: 5, max: 14, step: 1 },
  { key: 'sustainedIncreasePct', label: 'Sustained increase', help: 'Flag when typical daily cost rises at least this much.', unit: '%', min: 5, max: 300, step: 5 },
  { key: 'sustainedDecreasePct', label: 'Sustained decrease', help: 'Flag when typical daily cost falls at least this much.', unit: '%', min: 5, max: 95, step: 5 },
  { key: 'sustainedMinDailyDelta', label: 'Ignore changes smaller than', help: 'Minimum change in typical daily cost.', unit: '$ / day', min: 0, max: 5000, step: 10 },
];

export const SEVERITY_FIELDS: readonly SeverityField[] = [
  { key: 'mediumPct', label: 'Medium at', unit: '% change', min: 1, max: 1000, step: 5 },
  { key: 'highPct', label: 'High at', unit: '% change', min: 1, max: 1000, step: 5 },
  { key: 'criticalPct', label: 'Critical at', unit: '% change', min: 1, max: 1000, step: 5 },
  { key: 'mediumImpact', label: 'Medium at', unit: '$ impact', min: 0, max: 100000, step: 100 },
  { key: 'highImpact', label: 'High at', unit: '$ impact', min: 0, max: 100000, step: 100 },
  { key: 'criticalImpact', label: 'Critical at', unit: '$ impact', min: 0, max: 100000, step: 100 },
];

/** Friendly error messages for the settings form. Empty array means the config is valid. */
export function validateConfig(config: AnomalyConfig): string[] {
  const errors: string[] = [];
  for (const f of [...SPIKE_DROP_FIELDS, ...SUSTAINED_FIELDS]) {
    const v = config[f.key];
    if (!Number.isFinite(v) || v < f.min || v > f.max) errors.push(`${f.label} must be between ${f.min} and ${f.max} ${f.unit}.`);
  }
  for (const f of SEVERITY_FIELDS) {
    const v = config.severity[f.key];
    if (!Number.isFinite(v) || v < f.min || v > f.max) errors.push(`Severity ${f.label.toLowerCase()} (${f.unit}) must be between ${f.min} and ${f.max}.`);
  }
  const s = config.severity;
  if (!(s.mediumPct < s.highPct && s.highPct < s.criticalPct)) errors.push('Severity % thresholds must increase: medium < high < critical.');
  if (!(s.mediumImpact < s.highImpact && s.highImpact < s.criticalImpact)) errors.push('Severity $ thresholds must increase: medium < high < critical.');
  return errors;
}
