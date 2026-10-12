/**
 * Dependency-free ISO date helpers. All dates are `yyyy-MM-dd` strings in UTC,
 * which also sort and compare correctly as plain strings.
 */
const DAY_MS = 86_400_000;

export const toDate = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
export const toISO = (date: Date): string => date.toISOString().slice(0, 10);

export const addDays = (iso: string, days: number): string =>
  toISO(new Date(toDate(iso).getTime() + days * DAY_MS));

/** Whole days from `b` to `a` (a - b). */
export const diffDays = (a: string, b: string): number =>
  Math.round((toDate(a).getTime() - toDate(b).getTime()) / DAY_MS);

export const startOfMonth = (iso: string): string => `${iso.slice(0, 7)}-01`;

export const dayOfMonth = (iso: string): number => Number(iso.slice(8, 10));

export const daysInMonth = (iso: string): number => {
  const d = toDate(iso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
};

export const dayOfWeek = (iso: string): number => toDate(iso).getUTCDay();

export const startOfPreviousMonth = (iso: string): string =>
  startOfMonth(addDays(startOfMonth(iso), -1));

export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export const yearOf = (iso: string): number => Number(iso.slice(0, 4));

/** First day of the month `n` months after the month containing `iso`. */
export function addMonths(iso: string, n: number): string {
  const d = toDate(iso);
  return toISO(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)));
}

export const endOfMonth = (iso: string): string => addDays(addMonths(iso, 1), -1);

/** Monday of the week containing `iso` (weeks run Monday-Sunday). */
export const mondayOf = (iso: string): string => addDays(iso, -((dayOfWeek(iso) + 6) % 7));

/** Same calendar day `delta` years away (29 Feb falls back to 28 Feb). */
export function shiftYears(iso: string, delta: number): string {
  const year = Number(iso.slice(0, 4)) + delta;
  const month = iso.slice(5, 7);
  const day = iso.slice(8, 10);
  if (month === '02' && day === '29') {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    if (!leap) return `${year}-02-28`;
  }
  return `${year}-${month}-${day}`;
}
