import { addDays, addMonths, endOfMonth, eachDay, mondayOf, startOfMonth, yearOf } from '@/lib/dates';
import type { Granularity, TrendPoint } from '@/types/analytics';
import type { DailyCost } from '@/types/domain';
import type { DataBounds } from './range';

export interface BucketDef {
  start: string;
  end: string;
}

export const WEEK_BUCKETS = 26;
export const MONTH_BUCKETS = 12;

export const dailyBuckets = (from: string, to: string): BucketDef[] =>
  eachDay(from, to).map((d) => ({ start: d, end: d }));

/** Fixed look-back windows for the coarser granularities (independent of the date-range filter). */
export function bucketDefs(granularity: Exclude<Granularity, 'day'>, bounds: DataBounds): BucketDef[] {
  if (granularity === 'week') {
    const firstStart = addDays(mondayOf(bounds.end), -7 * (WEEK_BUCKETS - 1));
    return Array.from({ length: WEEK_BUCKETS }, (_, i) => {
      const start = addDays(firstStart, 7 * i);
      return { start, end: addDays(start, 6) };
    });
  }
  if (granularity === 'month') {
    const firstStart = addMonths(startOfMonth(bounds.end), -(MONTH_BUCKETS - 1));
    return Array.from({ length: MONTH_BUCKETS }, (_, i) => {
      const start = addMonths(firstStart, i);
      return { start, end: endOfMonth(start) };
    });
  }
  const firstYear = yearOf(bounds.start);
  const lastYear = yearOf(bounds.end);
  return Array.from({ length: lastYear - firstYear + 1 }, (_, i) => {
    const year = firstYear + i;
    return { start: `${year}-01-01`, end: `${year}-12-31` };
  });
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Sums cost rows into the given buckets, split by provider. */
export function buildSeries(rows: readonly DailyCost[], defs: readonly BucketDef[], bounds: DataBounds): TrendPoint[] {
  const points: TrendPoint[] = defs.map((d) => ({
    start: d.start,
    end: d.end,
    aws: 0,
    azure: 0,
    gcp: 0,
    total: 0,
    partial: d.end > bounds.end || d.start < bounds.start,
  }));

  const indexByDate = new Map<string, number>();
  defs.forEach((d, i) => {
    const last = d.end < bounds.end ? d.end : bounds.end;
    for (const day of eachDay(d.start, last)) indexByDate.set(day, i);
  });

  for (const row of rows) {
    const i = indexByDate.get(row.date);
    const point = i === undefined ? undefined : points[i];
    if (!point) continue;
    point[row.providerId] += row.cost;
    point.total += row.cost;
  }

  return points.map((p) => ({ ...p, aws: round2(p.aws), azure: round2(p.azure), gcp: round2(p.gcp), total: round2(p.total) }));
}
