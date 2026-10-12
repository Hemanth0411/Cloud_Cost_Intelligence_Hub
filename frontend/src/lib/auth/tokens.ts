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
  accessToken: string;
  /** Absent after a refresh: Cognito does not reissue it. */
  refreshToken: string | null;
  /** Epoch ms, from the ID token's `exp` claim. */
  expiresAt: number;
}

export interface IdClaims {
  email: string;
  emailVerified: boolean;
  /** Cognito's `cognito:username`, used only as a display fallback. */
  username: string | null;
  exp: number;
}

function store(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Decode a JWT payload WITHOUT verifying it.
 *
 * Only ever used for two things the client is allowed to guess at: when
 * to refresh, and what name to show. Every authorization decision is
 * made by the API against the signature. Treat anything this returns as
 * a display hint, never as proof of anything.
 */
export function decodeClaims(token: string): IdClaims | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const raw: unknown = JSON.parse(json);
    if (typeof raw !== 'object' || raw === null) return null;
    const claims = raw as Record<string, unknown>;
    const email = typeof claims.email === 'string' ? claims.email : null;
    if (!email) return null;
    const verified = claims.email_verified;
    const username = claims['cognito:username'];
    return {
      email: email.toLowerCase(),
      emailVerified: verified === true || String(verified).toLowerCase() === 'true',
      username: typeof username === 'string' ? username : null,
      exp: typeof claims.exp === 'number' ? claims.exp : 0,
    };
  } catch {
    return null;
  }
}

/** Builds a TokenSet from a Cognito token response. */
export function toTokenSet(
  idToken: string,
  accessToken: string,
  refreshToken: string | null,
  expiresInSeconds: number,
): TokenSet {
  // Prefer the token's own `exp` over the response's `expires_in`: the
  // former is what the API checks, and the two disagree by the request
  // latency.
  const claims = decodeClaims(idToken);
  const expiresAt =
    claims && claims.exp > 0 ? claims.exp * 1000 : Date.now() + expiresInSeconds * 1000;
  return { idToken, accessToken, refreshToken, expiresAt };
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
      accessToken: typeof t.accessToken === 'string' ? t.accessToken : '',
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
