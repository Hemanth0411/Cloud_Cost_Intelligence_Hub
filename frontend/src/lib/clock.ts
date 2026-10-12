/**
 * The mock dataset ends on 11 Oct 2026 and the latest (simulated) sync is 12 Oct 2026, so the app
 * runs on a "demo clock" anchored there. Rendered text must use `demoInstant` (or `useDemoNow`)
 * so the server and the browser paint the same string. `demoNow` then advances in the browser
 * only, for events created during a demo (a sync, a simulated alert).
 */
export const DEMO_NOW_ISO = '2026-10-12T04:30:00Z';

const EPOCH = Date.parse(DEMO_NOW_ISO);
let sessionStart: number | null = null;

/** Anchor instant. Identical on the server and on the first client render. */
export function demoInstant(): Date {
  return new Date(EPOCH);
}

/**
 * Live demo clock. On the server this stays at the anchor, so a long-running
 * process cannot drift away from the HTML the browser hydrates.
 * In the browser the first call starts the clock; do not call it during render.
 */
export function demoNow(): Date {
  if (typeof window === 'undefined') return demoInstant();
  if (sessionStart === null) sessionStart = Date.now();
  return new Date(EPOCH + (Date.now() - sessionStart));
}
