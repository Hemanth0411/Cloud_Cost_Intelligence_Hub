const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const usdCompact = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});

export const formatCurrency = (value: number): string => usd.format(value);
export const formatCompactCurrency = (value: number): string => usdCompact.format(value);

export function formatPercent(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

export function formatSignedPercent(value: number, digits = 1): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(digits)}%`;
}

type DateStyle = 'short' | 'medium' | 'long';

const dateFormats: Record<DateStyle, Intl.DateTimeFormat> = {
  short: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
  medium: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }),
  long: new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }),
};

/**
 * Formats a `yyyy-MM-dd` string. Always UTC so server and client
 * render identically.
 *
 * AN UNPARSEABLE VALUE RETURNS A DASH RATHER THAN THROWING.
 * `Intl.DateTimeFormat.format(Invalid Date)` raises `RangeError`,
 * which in a React tree is not a bad cell -- it is the whole route
 * replaced by the error boundary. The coercion layer in
 * `lib/api/cost-api.ts` defaults missing date columns to `''` so the
 * types stay honest, and those columns are NOT NULL today; this is
 * the guard that keeps a schema change from taking a page down.
 */
export function formatDate(iso: string, style: DateStyle = 'medium'): string {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return '—';
  return dateFormats[style].format(date);
}

export function formatDateRange(from: string, to: string): string {
  return `${formatDate(from, 'short')} – ${formatDate(to, 'medium')}`;
}

export function formatSignedCompactCurrency(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${usdCompact.format(Math.abs(value))}`;
}

const monthLong = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const monthShort = new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });

type BucketGranularity = 'day' | 'week' | 'month' | 'year';

/** Short axis label for a time bucket. */
export function formatBucketLabel(start: string, granularity: BucketGranularity): string {
  switch (granularity) {
    case 'year':
      return start.slice(0, 4);
    case 'month':
      return monthShort.format(new Date(`${start}T00:00:00Z`));
    default:
      return formatDate(start, 'short');
  }
}

/** Full description of a time bucket, used in tooltips. */
export function formatBucketRange(start: string, end: string, granularity: BucketGranularity): string {
  switch (granularity) {
    case 'year':
      return start.slice(0, 4);
    case 'month':
      return monthLong.format(new Date(`${start}T00:00:00Z`));
    case 'week':
      return `Week of ${formatDate(start, 'short')} – ${formatDate(end, 'medium')}`;
    default:
      return formatDate(start, 'long');
  }
}

const dateTime = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
});

/** e.g. "Oct 12, 2026, 04:00 UTC". Always UTC so output is identical everywhere. */
export function formatDateTime(iso: string): string {
  return `${dateTime.format(new Date(iso))} UTC`;
}

/** "just now", "12 min ago", "3 h ago", "2 d ago", otherwise a short date. Negative gaps read as "just now". */
export function formatRelative(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;
  return formatDate(iso.slice(0, 10), 'medium');
}
