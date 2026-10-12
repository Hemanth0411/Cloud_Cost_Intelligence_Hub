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
 * render, or the server HTML and the hydrated tree disagree. The two
 * places that care (the sidebar banner and the data gate) resolve it
 * in an effect instead -- see `useMode`.
 */
import { liveModeBlockers, USE_MOCK } from '@/lib/config';

/** Also cleared by "Reset demo data", which is why it carries the app prefix. */
export const MOCK_OVERRIDE_KEY = 'cloudlens:use-mock';

/** Where the current answer came from, for the settings screen to say. */
export type ModeSource = 'override' | 'build' | 'forced';

function readOverride(): boolean | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(MOCK_OVERRIDE_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    // Private mode, blocked storage: fall back to the build default.
  }
  return null;
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
  if (override === false && liveModeBlockers().length > 0) return true;
  return override;
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

/** `null` removes the override and hands the decision back to the build. */
export function setMockOverride(value: boolean | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (value === null) window.localStorage.removeItem(MOCK_OVERRIDE_KEY);
    else window.localStorage.setItem(MOCK_OVERRIDE_KEY, value ? 'true' : 'false');
  } catch {
    // Nothing useful to do: the caller reloads either way and the
    // build default applies.
  }
}

/** The build-time default, for screens that explain where the value came from. */
export const BUILD_DEFAULT_IS_MOCK = USE_MOCK;
