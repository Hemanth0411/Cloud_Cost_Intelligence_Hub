/**
 * Cognito Managed Login: authorization-code flow with PKCE.
 *
 * The pool is passwordless email OTP, and that dictates the shape of
 * this file. Passwordless REQUIRES Managed Login (`managed_login_version
 * = 2`); the classic Hosted UI cannot do it, and the app client enables
 * only `ALLOW_USER_AUTH` (choice-based) and `ALLOW_REFRESH_TOKEN_AUTH`.
 * There is no SDK call this app can make to sign a user in -- the OTP
 * screen belongs to Cognito. So `/login` hands off, and the only thing
 * that comes back is a code.
 *
 * PKCE even though the client has no secret: a public client cannot
 * authenticate itself to the token endpoint, so the code alone is the
 * bearer of the grant. S256 PKCE binds it to this browser, which is
 * what stops a code leaked from history or a referer being redeemed
 * elsewhere.
 *
 * The verifier lives in sessionStorage for exactly one round trip and
 * is deleted the moment it is used -- including on failure, so a stale
 * verifier cannot make the next attempt fail in a way that looks like a
 * Cognito problem.
 */
import { COGNITO_CLIENT_ID, COGNITO_DOMAIN_URL } from '@/lib/config';
import { toTokenSet, type TokenSet } from './tokens';

const VERIFIER_KEY = 'costhub:pkce-verifier';
const STATE_KEY = 'costhub:oauth-state';
const NEXT_KEY = 'costhub:post-login-path';
const SIGNED_OUT_KEY = 'costhub:signed-out';

/** Must exactly match one of `callback_urls` in terraform/cognito.tf. */
function redirectUri(): string {
  return `${window.location.origin}/auth/callback`;
}

function logoutUri(): string {
  return `${window.location.origin}/login`;
}

function session(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

// ---- PKCE --------------------------------------------------------------

function randomString(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64Url(buf);
}

function base64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

// ---- sign in -----------------------------------------------------------

/**
 * Sends the browser to Managed Login. Never returns.
 *
 * `next` is remembered in sessionStorage rather than round-tripped
 * through `state`, because `state` comes back in the URL and the path
 * the user wanted is nobody else's business. `state` carries only an
 * opaque nonce, which is all it is for.
 */
export async function beginSignIn(next: string): Promise<void> {
  const verifier = randomString();
  const state = randomString(16);
  const s = session();
  if (s) {
    s.setItem(VERIFIER_KEY, verifier);
    s.setItem(STATE_KEY, state);
    s.setItem(NEXT_KEY, next);
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: COGNITO_CLIENT_ID,
    redirect_uri: redirectUri(),
    // `email openid profile` -- exactly `allowed_oauth_scopes` on the
    // app client. Asking for a scope the client does not allow fails the
    // authorize request outright.
    scope: 'email openid profile',
    state,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: 'S256',
  });

  window.location.assign(`${COGNITO_DOMAIN_URL}/oauth2/authorize?${params.toString()}`);
}

/** Where to land after the code is exchanged. Same-site relative paths only. */
export function takePostLoginPath(): string {
  const s = session();
  const value = s?.getItem(NEXT_KEY) ?? null;
  s?.removeItem(NEXT_KEY);
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/dashboard';
}

// ---- the sign-out marker ----------------------------------------------

/**
 * Set just before redirecting to Cognito's /logout.
 *
 * Without it, signing out lands on `/login`, which immediately starts a
 * new sign-in -- so "sign out" presents as "show me the OTP screen
 * again" and there is no way to simply leave.
 */
export function markSignedOut(): void {
  try {
    session()?.setItem(SIGNED_OUT_KEY, '1');
  } catch {
    /* ignore */
  }
}

/** Reads and clears the marker, so it only suppresses one auto-sign-in. */
export function takeSignedOut(): boolean {
  const s = session();
  const value = s?.getItem(SIGNED_OUT_KEY) ?? null;
  s?.removeItem(SIGNED_OUT_KEY);
  return value === '1';
}

export class AuthError extends Error {}

// ---- the token endpoint ------------------------------------------------

interface TokenResponse {
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(`${COGNITO_DOMAIN_URL}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  let parsed: TokenResponse = {};
  try {
    parsed = (await response.json()) as TokenResponse;
  } catch {
    /* fall through to the status-based message below */
  }
  if (!response.ok) {
    throw new AuthError(
      parsed.error_description ?? parsed.error ?? `token endpoint returned ${response.status}`,
    );
  }
  return parsed;
}

/**
 * Exchange the authorization code for tokens.
 *
 * The verifier and state are consumed unconditionally -- an exchange
 * that fails must not leave them behind for the retry, or the retry
 * fails for a different and more confusing reason.
 */
export async function exchangeCode(code: string, state: string | null): Promise<TokenSet> {
  const s = session();
  const verifier = s?.getItem(VERIFIER_KEY) ?? null;
  const expectedState = s?.getItem(STATE_KEY) ?? null;
  s?.removeItem(VERIFIER_KEY);
  s?.removeItem(STATE_KEY);

  if (!verifier) {
    throw new AuthError(
      'This sign-in link has already been used, or was opened in a different tab. Start again.',
    );
  }
  // FAIL CLOSED, not open. `expectedState && ...` skipped the check
  // entirely when the stored value was missing -- including the case
  // where Cognito returned no `state` at all. A guard that disappears
  // when its input is absent is not a guard. (PKCE is the real defence
  // here, since an attacker's code is bound to their own challenge, but
  // a check worth writing is worth failing closed.)
  if (!expectedState || state !== expectedState) {
    throw new AuthError('Sign-in state did not match. Start again.');
  }

  const result = await postToken(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: COGNITO_CLIENT_ID,
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }),
  );

  if (!result.id_token) throw new AuthError('Cognito returned no ID token.');
  return toTokenSet(result.id_token, result.refresh_token ?? null, result.expires_in ?? 3600);
}

/**
 * Trade a refresh token for a fresh ID token.
 *
 * Cognito does NOT reissue the refresh token here, so the old one is
 * carried forward. `refresh_token_validity` is 2 days on this client,
 * which is the real ceiling on a session.
 */
export async function refreshTokens(refreshToken: string): Promise<TokenSet> {
  const result = await postToken(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: COGNITO_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  );
  if (!result.id_token) throw new AuthError('Refresh returned no ID token.');
  return toTokenSet(result.id_token, refreshToken, result.expires_in ?? 3600);
}

/**
 * Cognito's logout URL.
 *
 * Clearing local tokens is not signing out: Cognito keeps its own
 * session cookie, so the next authorize request would come straight
 * back with a new code and no OTP prompt. This is what ends it.
 * `logout_uri` must be listed in `logout_urls`.
 */
export function signOutUrl(): string {
  const params = new URLSearchParams({
    client_id: COGNITO_CLIENT_ID,
    logout_uri: logoutUri(),
  });
  return `${COGNITO_DOMAIN_URL}/logout?${params.toString()}`;
}
