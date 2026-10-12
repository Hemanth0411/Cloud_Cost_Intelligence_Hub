/**
 * Signing in and out, for both modes.
 *
 * Same contract as the other services in this folder: the UI calls
 * these and never knows which mode it is in. Mock mode keeps the
 * simulated in-browser login; live mode runs the Cognito
 * authorization-code exchange.
 *
 * THE ROLE COMES FROM THE SERVER, not from the token. A Cognito ID
 * token carries identity (`email`, `email_verified`) but knows nothing
 * about this application's `users` table, where the role actually
 * lives. So the last step of a live sign-in is `GET /meta/me`, which is
 * the server stating who it thinks the caller is -- and it is also the
 * first real authenticated request, so a token that the API will not
 * accept fails here, at sign-in, instead of on the dashboard.
 */
import { get } from '@/lib/api/client';
import { exchangeCode, markSignedOut, signOutUrl, takePostLoginPath } from '@/lib/auth/cognito';
import { endSession, startSession } from '@/lib/auth/session';
import { clearTokens, writeTokens } from '@/lib/auth/tokens';
import { USE_MOCK } from '@/lib/config';
import type { User } from '@/types/domain';

interface MeResponse {
  email: string;
  role: string;
  isSuperadmin: boolean;
}

/** `GET /meta/me` -- the caller as the server sees them. */
export function fetchMe(): Promise<MeResponse> {
  return get<MeResponse>('/meta/me');
}

/**
 * A display name from an email address, since Cognito holds none.
 *
 * `hemanth.reddy@chryselys.com` -> `Hemanth Reddy`. Cosmetic only; the
 * email is shown next to it everywhere it matters.
 */
function displayNameFor(email: string): string {
  const local = email.split('@')[0] ?? email;
  const words = local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1));
  return words.length > 0 ? words.join(' ') : email;
}

/**
 * Finish a live sign-in: exchange the code, confirm with the API, set
 * the session marker. Returns where to send the browser next.
 */
export async function completeSignIn(code: string, state: string | null): Promise<string> {
  const tokens = await exchangeCode(code, state);
  writeTokens(tokens);

  let user: User;
  try {
    const me = await fetchMe();
    user = { name: displayNameFor(me.email), email: me.email, role: me.role };
  } catch (error) {
    // The token is valid to Cognito but the API refused it. The usual
    // cause is a user who exists in the pool and not in the `users`
    // table ("user not provisioned", 403) -- an invite that wrote only
    // one of its two halves. Do NOT keep the tokens: a session the API
    // rejects is not a session, and keeping it produces an app that
    // looks signed in and shows nothing.
    clearTokens();
    endSession();
    throw error;
  }

  startSession(user);
  return takePostLoginPath();
}

/**
 * Sign out.
 *
 * Clearing local state is NOT signing out in live mode: Cognito keeps
 * its own session cookie, so the next authorize request returns a code
 * immediately with no OTP prompt and the user is straight back in. The
 * redirect to Cognito's `/logout` is what actually ends it, and it
 * comes back to `/login`.
 *
 * The `signedOut` flag is set first, and the login screen reads it to
 * decide NOT to bounce straight into a new sign-in. It cannot be a
 * query parameter: Cognito matches `logout_uri` exactly against
 * `logout_urls`, so `/login?signedout=1` is simply rejected. The flag
 * is in sessionStorage, which survives the redirect because it is the
 * same origin and the same tab.
 */
export function signOut(): void {
  clearTokens();
  endSession();
  markSignedOut();
  window.location.assign(USE_MOCK ? '/login' : signOutUrl());
}
