import { dayOfWeek, diffDays } from '@/lib/dates';
import { hashString } from '@/lib/mock/seed';
import type {
  Anomaly,
  AnomalyConfig,
  AnomalyKind,
  AnomalyStatus,
  DailyCost,
  Severity,
  SeverityThresholds,
} from '@/types/domain';

/**
 * Deterministic, rule-based anomaly engine. Four rules run on every (account, service) series:
 *
 *  1. spike               a day far above what that kind of day (weekday / weekend) normally costs
 *  2. drop                a day far below normal (unexpected decrease)
 *  3. sustained-increase  the recent-window median is well above the prior baseline (level shift up)
 *  4. sustained-decrease  the recent-window median is well below the prior baseline (level shift down)
 *
 * Baselines use medians (robust to earlier incidents) and compare like with like, so a dev account's
 * normal weekend dip is never reported as a decrease. Every threshold lives in `AnomalyConfig`.
 */

export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = {
  baselineDays: 28,
  minBaselineSamples: 6,
  spikeSigma: 4,
  spikeMinPct: 40,
  dropSigma: 4,
  dropMinPct: 35,
  minDailyDelta: 75,
  sustainedWindowDays: 7,
  sustainedIncreasePct: 25,
  sustainedDecreasePct: 25,
  sustainedMinDailyDelta: 120,
  severity: {
    mediumPct: 60,
    highPct: 120,
    criticalPct: 220,
    mediumImpact: 600,
    highImpact: 1500,
    criticalImpact: 3500,
  },
};

export type AnomalyPresetId = 'conservative' | 'balanced' | 'sensitive';

export const ANOMALY_PRESETS: Record<AnomalyPresetId, AnomalyConfig> = {
  conservative: {
    ...DEFAULT_ANOMALY_CONFIG,
    spikeSigma: 5,
    spikeMinPct: 60,
    dropSigma: 5,
    dropMinPct: 50,
    minDailyDelta: 150,
    sustainedIncreasePct: 40,
    sustainedDecreasePct: 40,
    sustainedMinDailyDelta: 250,
  },
  balanced: DEFAULT_ANOMALY_CONFIG,
  sensitive: {
    ...DEFAULT_ANOMALY_CONFIG,
    spikeSigma: 3,
    spikeMinPct: 25,
    dropSigma: 3,
    dropMinPct: 25,
    minDailyDelta: 40,
    sustainedIncreasePct: 15,
    sustainedDecreasePct: 15,
    sustainedMinDailyDelta: 60,
  },
};

export const PRESET_LABELS: Record<AnomalyPresetId, string> = {
  conservative: 'Conservative',
  balanced: 'Balanced',
  sensitive: 'Sensitive',
};

export function matchPreset(config: AnomalyConfig): AnomalyPresetId | 'custom' {
  const key = JSON.stringify(config);
  const hit = (Object.keys(ANOMALY_PRESETS) as AnomalyPresetId[]).find((id) => JSON.stringify(ANOMALY_PRESETS[id]) === key);
  return hit ?? 'custom';
}

export const KIND_LABELS: Record<AnomalyKind, string> = {
  spike: 'Spike',
  'sustained-increase': 'Sustained increase',
  drop: 'Unexpected drop',
  'sustained-decrease': 'Sustained decrease',
};

export const isIncrease = (kind: AnomalyKind): boolean => kind === 'spike' || kind === 'sustained-increase';

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? upper) + upper) / 2 : upper;
}

export function severityFor(changePct: number, impact: number, t: SeverityThresholds): Severity {
  const pct = Math.abs(changePct);
  const dollars = Math.abs(impact);
  if (pct >= t.criticalPct || dollars >= t.criticalImpact) return 'critical';
  if (pct >= t.highPct || dollars >= t.highImpact) return 'high';
  if (pct >= t.mediumPct || dollars >= t.mediumImpact) return 'medium';
  return 'low';
}

/** Deterministic starting workflow state, derived from the anomaly id and its age. */
function initialStatus(id: string, ageDays: number): AnomalyStatus {
  const h = hashString(id) % 6;
  if (ageDays <= 3) return 'open';
  if (ageDays <= 12) return h < 2 ? 'acknowledged' : h < 4 ? 'investigating' : 'open';
  return h === 0 ? 'dismissed' : 'resolved';
}

/** Three weeks: long enough for like-for-like (weekend) comparisons to catch up with a new level. */
const QUIET_DAYS = 21;

const round2 = (v: number): number => Math.round(v * 100) / 100;
const round1 = (v: number): number => Math.round(v * 10) / 10;

type Draft = Omit<Anomaly, 'status'>;

function draft(
  row: DailyCost,
  kind: AnomalyKind,
  observed: number,
  expected: number,
  windowDays: number,
  cfg: AnomalyConfig,
): Draft {
  const difference = observed - expected;
  const changePct = (difference / expected) * 100;
  const impact = difference * windowDays;
  return {
    id: `anom-${kind}-${row.accountId}-${row.serviceId}-${row.date}`,
    kind,
    date: row.date,
    providerId: row.providerId,
    accountId: row.accountId,
    serviceId: row.serviceId,
    observedCost: round2(observed),
    expectedCost: round2(expected),
    differenceCost: round2(difference),
    changePct: round1(changePct),
    windowDays,
    impactCost: round2(impact),
    severity: severityFor(changePct, impact, cfg.severity),
  };
}

function detectSeries(rows: readonly DailyCost[], cfg: AnomalyConfig): Draft[] {
  const n = rows.length;
  const costs = rows.map((r) => r.cost);
  const weekend = rows.map((r) => {
    const d = dayOfWeek(r.date);
    return d === 0 || d === 6;
  });
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) prefix[i + 1] = (prefix[i] ?? 0) + (costs[i] ?? 0);

  const B = cfg.baselineDays;
  const W = cfg.sustainedWindowDays;
  const found: Array<{ item: Draft; index: number }> = [];
  let increaseUntil = -1;
  let decreaseUntil = -1;
  // After a level shift is confirmed, comparable days keep looking "different" for a few weeks,
  // so single-day flags in the same direction are held back to avoid reporting one event twice.
  let quietUpUntil = -1;
  let quietDownUntil = -1;

  for (let i = B; i < n; i += 1) {
    const row = rows[i];
    const cost = costs[i];
    if (!row || cost === undefined) continue;

    // --- Rules 1 & 2: single-day spike / drop against like-for-like days -------------------------
    const samples: number[] = [];
    for (let j = i - 1; j >= i - B; j -= 1) if (weekend[j] === weekend[i]) samples.push(costs[j] ?? 0);

    if (samples.length >= cfg.minBaselineSamples) {
      const med = median(samples);
      const diff = cost - med;
      const pct = (diff / med) * 100;
      // Most recent comparable days: if they are already elevated/depressed this is a level shift, not a one-off.
      const recentContext = median(samples.slice(0, 3));

      if (i >= quietUpUntil && pct >= cfg.spikeMinPct && diff >= cfg.minDailyDelta && recentContext < med * (1 + cfg.spikeMinPct / 200)) {
        const mad = median(samples.map((v) => Math.abs(v - med)));
        const sigma = Math.max(mad * 1.4826, med * 0.04);
        if (cost > med + cfg.spikeSigma * sigma) found.push({ item: draft(row, 'spike', cost, med, 1, cfg), index: i });
      } else if (i >= quietDownUntil && -pct >= cfg.dropMinPct && -diff >= cfg.minDailyDelta && recentContext > med * (1 - cfg.dropMinPct / 200)) {
        const mad = median(samples.map((v) => Math.abs(v - med)));
        const sigma = Math.max(mad * 1.4826, med * 0.04);
        if (cost < med - cfg.dropSigma * sigma) found.push({ item: draft(row, 'drop', cost, med, 1, cfg), index: i });
      }
    }

    // --- Rules 3 & 4: sustained level shift (recent-window median vs prior baseline) -------------
    if (i >= B + W) {
      const recentMean = ((prefix[i + 1] ?? 0) - (prefix[i + 1 - W] ?? 0)) / W;
      const baseMean = ((prefix[i + 1 - W] ?? 0) - (prefix[i + 1 - W - B] ?? 0)) / B;
      const ratio = baseMean > 0 ? recentMean / baseMean : 1;
      const maybeUp = ratio >= 1 + (cfg.sustainedIncreasePct / 100) * 0.4 && i >= increaseUntil;
      const maybeDown = ratio <= 1 - (cfg.sustainedDecreasePct / 100) * 0.4 && i >= decreaseUntil;

      if (maybeUp || maybeDown) {
        const recent = median(costs.slice(i - W + 1, i + 1));
        const base = median(costs.slice(i - W - B + 1, i - W + 1));
        const diff = recent - base;
        const pct = (diff / base) * 100;

        if (maybeUp && pct >= cfg.sustainedIncreasePct && diff >= cfg.sustainedMinDailyDelta) {
          // The first elevated days of this shift may already have fired as spikes; fold them into this finding.
          for (let k = found.length - 1; k >= 0; k -= 1) {
            const f = found[k];
            if (f && f.item.kind === 'spike' && f.index > i - W) found.splice(k, 1);
          }
          found.push({ item: draft(row, 'sustained-increase', recent, base, W, cfg), index: i });
          increaseUntil = i + B;
          quietUpUntil = i + QUIET_DAYS;
        } else if (maybeDown && -pct >= cfg.sustainedDecreasePct && -diff >= cfg.sustainedMinDailyDelta) {
          for (let k = found.length - 1; k >= 0; k -= 1) {
            const f = found[k];
            if (f && f.item.kind === 'drop' && f.index > i - W) found.splice(k, 1);
          }
          found.push({ item: draft(row, 'sustained-decrease', recent, base, W, cfg), index: i });
          decreaseUntil = i + B;
          quietDownUntil = i + QUIET_DAYS;
        }
      }
    }
  }
  return found.map((f) => f.item);
}

export function detectAnomalies(
  costs: readonly DailyCost[],
  endDate: string,
  config: AnomalyConfig = DEFAULT_ANOMALY_CONFIG,
): Anomaly[] {
  const series = new Map<string, DailyCost[]>();
  for (const row of costs) {
    const key = `${row.accountId}|${row.serviceId}`;
    const list = series.get(key);
    if (list) list.push(row);
    else series.set(key, [row]);
  }

  const drafts: Draft[] = [];
  for (const rows of series.values()) {
    const ordered = rows.every((r, i) => i === 0 || (rows[i - 1]?.date ?? '') <= r.date)
      ? rows
      : [...rows].sort((a, b) => (a.date < b.date ? -1 : 1));
    drafts.push(...detectSeries(ordered, config));
  }

  drafts.sort((a, b) => (a.date === b.date ? Math.abs(b.impactCost) - Math.abs(a.impactCost) : a.date < b.date ? 1 : -1));
  return drafts.map((d) => ({ ...d, status: initialStatus(d.id, diffDays(endDate, d.date)) }));
}
