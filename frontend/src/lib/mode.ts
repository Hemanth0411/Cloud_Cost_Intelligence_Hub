/**
 * Mock or live, decided at RUNTIME.
 *
 * WHY THIS EXISTS AT ALL: `NEXT_PUBLIC_USE_MOCK` is inlined into the
 * bundle by the compiler, so changing it means a rebuild and, on
 * Amplify, a redeploy. That is the wrong cost for a decision someone
 * wants to make mid-demo. A `localStorage` override costs nothing and
 * is per-browser, so flipping it affects the person flipping it and
 * nobody else.
 *
 * THE WHOLE MECHANISM IS THREE THINGS, deliberately:
 *
 *   1. `isMock()` -- the override if one is set, otherwise the build
 *      default. Every data-access module calls this and nothing else.
 *   2. a switch on /settings that writes the override.
 *   3. `location.reload()` after writing it.
 *
 * The reload is what keeps the rest simple. Without it, every cached
 * query, every context holding fetched rows and every module-level
 * memo would have to learn to invalidate itself, and the two modes
 * would have to be able to interleave. With it, a mode lasts exactly
 * one document lifetime and no code anywhere needs to handle a change.
 * There is no context, no provider, no per-call flag.
 *
 * SERVER RENDERING: `localStorage` does not exist there, so `isMock()`
 * returns the build default during prerender. A component whose OUTPUT
 * depends on the mode must therefore not decide it during the first
 * render, or the server HTML and the hydrated tree disagree.
 *
 * Inside the app shell that is handled structurally: `<AppDataGate>`
 * renders a spinner on the server AND on the first client render, so
 * nothing mode-dependent under it ever takes part in hydration. The
 * components OUTSIDE the gate -- the sign-in chrome and the data
 * badge -- use `useMode()`, which resolves in an effect.
 */
import { liveModeBlockers, USE_MOCK } from '@/lib/config';

/** Deliberately kept by "Reset browser state": see settings-view.tsx. */
export const MOCK_OVERRIDE_KEY = 'cloudlens:use-mock';

/**
 * `?mock=1` / `?mock=0` -- the way back in when the app will not load.
 *
 * Switching to live without a Cognito session is a one-way door
 * otherwise: the API answers 401, the client hands the browser to
 * /login, and /login in live mode immediately redirects to Cognito.
 * If Cognito is unreachable -- which is the exact situation the
 * toggle exists for, a demo with no connectivity -- every route
 * bounces and the switch on /settings is behind the bounce. The only
 * recovery was devtools.
 *
 * The parameter is WRITTEN to the override as it is read, so one
 * visit to `/login?mock=1` is permanent and the URL does not have to
 * be carried around afterwards.
 */
const URL_PARAM = 'mock';

/** Where the current answer came from, for the settings screen to say. */
export type ModeSource = 'override' | 'build' | 'forced';

function readOverride(): boolean | null {
  if (typeof window === 'undefined') return null;

  const fromUrl = readUrlOverride();
  if (fromUrl !== null) {
    writeOverride(fromUrl);
    return fromUrl;
  }

  try {
    const raw = window.localStorage.getItem(MOCK_OVERRIDE_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    // Private mode, blocked storage: fall back to the build default.
  }
  return null;
}

function readUrlOverride(): boolean | null {
  try {
    const raw = new URLSearchParams(window.location.search).get(URL_PARAM);
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
  } catch {
    // Malformed URL: no override.
  }
  return null;
}

function writeOverride(value: boolean | null): void {
  try {
    if (value === null) window.localStorage.removeItem(MOCK_OVERRIDE_KEY);
    else window.localStorage.setItem(MOCK_OVERRIDE_KEY, value ? 'true' : 'false');
  } catch {
    // Nothing useful to do; the caller re-reads and reports.
  }
}

/**
 * Is the app running on mock data right now?
 *
 * An override to LIVE is refused when the build has no API URL, client
 * id or Cognito domain, because a live mode that cannot reach anything
 * is worse than the mock it replaced -- the same reasoning as
 * `USE_MOCK` itself. An override to MOCK is always honoured; mock
 * needs nothing.
 */
export function isMock(): boolean {
  const override = readOverride();
  if (override === null) return USE_MOCK;
  if (override === false && liveModeBlockers().length > 0) {
    // SAY SO WHEN LIVE MODE IS REFUSED -- the same rule config.ts
    // applies to the build-time flag. Silently handing back mock
    // after someone asked for live is the single most confusing
    // thing this function can do, and on-screen notice only reaches
    // whoever is looking at /settings.
    warnOnce(
      `[costhub] live mode was requested but mock data is still in use: ` +
        `${liveModeBlockers().join(', ')} not set in this build.`,
    );
    return true;
  }
  return override;
}

let warned = false;
function warnOnce(message: string): void {
  if (warned || typeof console === 'undefined') return;
  warned = true;
  console.warn(message);
}

export function modeSource(): ModeSource {
  const override = readOverride();
  if (override === null) return 'build';
  if (override === false && liveModeBlockers().length > 0) return 'forced';
  return 'override';
}

/** Why an override to live was refused; empty when it was not. */
export function liveBlockedBy(): string[] {
  return liveModeBlockers();
}

/**
 * `null` removes the override and hands the decision back to the build.
 *
 * Returns whether the write stuck. In a private window or with site
 * data blocked it does not, and the caller must say so rather than
 * reloading into an unchanged app and leaving the user to conclude
 * the switch is broken.
 */
export function setMockOverride(value: boolean | null): boolean {
  if (typeof window === 'undefined') return false;
  writeOverride(value);
  try {
    const raw = window.localStorage.getItem(MOCK_OVERRIDE_KEY);
    return value === null ? raw === null : raw === (value ? 'true' : 'false');
  } catch {
    return false;
  }
}

/** The build-time default, for screens that explain where the value came from. */
export const BUILD_DEFAULT_IS_MOCK = USE_MOCK;
