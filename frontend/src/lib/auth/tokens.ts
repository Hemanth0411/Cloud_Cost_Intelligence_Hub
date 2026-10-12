/**
 * Where the Cognito tokens live.
 *
 * sessionStorage, not localStorage and not a cookie, and the reasoning
 * is worth stating because every option here is a trade:
 *
 *  * It CANNOT be an httpOnly cookie. The browser has to put the token
 *    in an `Authorization` header on a cross-origin request to the
 *    Lambda Function URL, so client JavaScript must be able to read it.
 *    An httpOnly cookie would require proxying every call through a
 *    Next route handler, which is a different architecture, not a
 *    hardening of this one.
 *  * sessionStorage over localStorage: identical exposure to XSS, but a
 *    strictly shorter life. It is scoped to the tab, is not shared with
 *    other tabs or windows, and is gone when the tab closes. The cost
 *    is that opening the app in a new tab re-authenticates -- which,
 *    with an existing Cognito session, is a silent round trip.
 *  * Never in the URL, and never logged. The authorization code is
 *    stripped from the address bar by the callback screen as soon as it
 *    has been exchanged.
 *
 * The ID token is the one sent to the API, not the access token. That
 * is forced by the server: `api/deps.py` requires an `email` claim and
 * `email_verified === true`, and verifies `aud` against the app client
 * id. A Cognito access token carries neither `email` nor `aud`, so it
 * is rejected -- correctly, since it cannot identify the caller.
 */

const STORAGE_KEY = 'costhub:tokens';

/** Refresh this far before expiry, so an in-flight request cannot race it. */
const SKEW_MS = 120_000;

export interface TokenSet {
  idToken: string;
  /** Absent after a refresh: Cognito does not reissue it. */
  refreshToken: string | null;
  /** Epoch ms on the LOCAL clock. See `toTokenSet`. */
  expiresAt: number;
}

// The access token is deliberately NOT stored. It cannot be used
// against this API (see the header), nothing else reads it, and an
// unused bearer credential sitting in web storage is a liability that
// costs nothing to drop.

function store(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * How long the token is good for, in seconds, from its own claims.
 *
 * Read WITHOUT verifying the signature, which is fine because the only
 * thing this decides is when to refresh. Every authorization decision
 * is made by the API against the signature.
 */
function lifetimeOf(token: string): number | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const raw: unknown = JSON.parse(json);
    if (typeof raw !== 'object' || raw === null) return null;
    const claims = raw as Record<string, unknown>;
    const { exp, iat } = claims;
    if (typeof exp !== 'number' || typeof iat !== 'number' || exp <= iat) return null;
    return exp - iat;
  } catch {
    return null;
  }
}

/**
 * Builds a TokenSet from a Cognito token response.
 *
 * `expiresAt` is LOCAL time plus the token's own lifetime -- deliberately
 * not the `exp` claim converted to ms.
 *
 * Using `exp` directly compares an issuer timestamp against
 * `Date.now()`, which makes the two-minute refresh skew the entire
 * tolerance for client clock error. A browser five minutes slow would
 * consider a just-expired token fresh, send it, and take a hard 401
 * roughly once an hour. Anchoring to `exp - iat` uses the server for the
 * only thing it is authoritative about -- the duration -- and the local
 * clock for the only thing it is reliable about: elapsed time since a
 * moment this code witnessed.
 */
export function toTokenSet(
  idToken: string,
  refreshToken: string | null,
  expiresInSeconds: number,
): TokenSet {
  const lifetime = lifetimeOf(idToken) ?? expiresInSeconds;
  return { idToken, refreshToken, expiresAt: Date.now() + lifetime * 1000 };
}

export function readTokens(): TokenSet | null {
  const s = store();
  if (!s) return null;
  try {
    const raw: unknown = JSON.parse(s.getItem(STORAGE_KEY) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return null;
    const t = raw as Record<string, unknown>;
    if (typeof t.idToken !== 'string' || typeof t.expiresAt !== 'number') return null;
    return {
      idToken: t.idToken,
      refreshToken: typeof t.refreshToken === 'string' ? t.refreshToken : null,
      expiresAt: t.expiresAt,
    };
  } catch {
    return null;
  }
}

export function writeTokens(tokens: TokenSet): void {
  const s = store();
  if (!s) return;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(tokens));
  } catch {
    /* storage full or blocked: the session simply does not persist */
  }
}

export function clearTokens(): void {
  const s = store();
  if (!s) return;
  try {
    s.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** True when the ID token is expired, or close enough that it will be mid-flight. */
export function isStale(tokens: TokenSet, now = Date.now()): boolean {
  return tokens.expiresAt - SKEW_MS <= now;
}
