import { addDays, diffDays, startOfMonth } from '@/lib/dates';
import type { DateRangePreset, Filters, ResolvedRange } from '@/types/analytics';

export interface DataBounds {
  start: string;
  end: string;
}

const PRESET_DAYS = { '7d': 7, '30d': 30, '90d': 90, '12m': 365 } as const;

export const RANGE_LABELS: Record<DateRangePreset, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  mtd: 'Month to date',
  ytd: 'Year to date',
  '12m': 'Last 12 months',
  custom: 'Custom range',
};

const clamp = (iso: string, bounds: DataBounds): string =>
  iso < bounds.start ? bounds.start : iso > bounds.end ? bounds.end : iso;

/**
 * Resolves the filter's date range to concrete dates, plus the equal-length
 * period immediately before it (used for every "vs previous" comparison).
 */
export function resolveRange(
  filters: Pick<Filters, 'range' | 'customFrom' | 'customTo'>,
  bounds: DataBounds,
): ResolvedRange {
  let from: string;
  let to = bounds.end;

  switch (filters.range) {
    case 'mtd':
      from = startOfMonth(bounds.end);
      break;
    case 'ytd':
      from = `${bounds.end.slice(0, 4)}-01-01`;
      break;
    case 'custom': {
      const a = clamp(filters.customFrom ?? bounds.end, bounds);
      const b = clamp(filters.customTo ?? bounds.end, bounds);
      from = a <= b ? a : b;
      to = a <= b ? b : a;
      break;
    }
    default:
      from = addDays(bounds.end, -(PRESET_DAYS[filters.range] - 1));
  }

  const days = diffDays(to, from) + 1;
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  return { preset: filters.range, from, to, days, prevFrom, prevTo, hasPrevious: prevFrom >= bounds.start };
}
