/**
 * The one place the browser talks to the API.
 *
 * Everything it does is a consequence of how the server behaves, so the
 * reasons are recorded next to each:
 *
 *  * `Authorization: Bearer <ID token>`. Not the access token -- see
 *    `lib/auth/tokens.ts`; the API needs the `email` and
 *    `email_verified` claims, which only the ID token carries.
 *  * Refresh BEFORE the request, not after a 401. The ID token lives 60
 *    minutes and a dashboard sits open for longer than that, so the
 *    expiry is routine rather than exceptional. Refreshing reactively
 *    would mean every page showing one failure per hour first.
 *  * A single shared refresh. Six panels mounting at once would
 *    otherwise fire six refreshes, and Cognito answers the losers with
 *    an error for a token that was perfectly good.
 *  * 401 and 403 are NOT the same thing and must not be handled the
 *    same way. 401 means the token is unusable -- re-authenticate. 403
 *    means the server understood exactly who the caller is and is
 *    refusing: no grants, not a superadmin, domain not permitted. That
 *    is a legitimate, designed state ("a user with no grants receives
 *    zero rows"), so it must surface as an empty state and never as a
 *    sign-in loop.
 */
import { AuthError, refreshTokens } from '@/lib/auth/cognito';
import { endSession } from '@/lib/auth/session';
import { clearTokens, isStale, readTokens, writeTokens } from '@/lib/auth/tokens';
import { API_BASE_URL } from '@/lib/config';
import { camelKeys } from './case';

export class ApiError extends Error {
  readonly status: number;
  /** The server named who the caller is and refused. Render an empty state. */
  readonly forbidden: boolean;

  // No `unauthorized` flag. A 401 is intercepted below and turned into a
  // re-authentication, so no caller is left in a position to inspect it;
  // `status` is there for anything that genuinely needs the number.
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.forbidden = status === 403;
  }
}

/** Thrown when the API cannot be reached at all (DNS, CORS, offline). */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

// ---- token handling ----------------------------------------------------

let inFlightRefresh: Promise<string | null> | null = null;

/**
 * A usable ID token, refreshed if it is about to expire.
 *
 * Returns null when there is nothing to work with, which the caller
 * turns into a 401 rather than sending an empty Authorization header --
 * a `Bearer ` with no token produces a confusing server-side parse
 * error instead of a clean "not signed in".
 */
async function bearerToken(): Promise<string | null> {
  const tokens = readTokens();
  if (!tokens) return null;
  if (!isStale(tokens)) return tokens.idToken;
  if (!tokens.refreshToken) return null;

  inFlightRefresh ??= refreshTokens(tokens.refreshToken)
    .then((fresh) => {
      writeTokens(fresh);
      return fresh.idToken;
    })
    .catch((cause: unknown) => {
      // ONLY a definite rejection ends the session.
      //
      // `AuthError` means the token endpoint answered and refused --
      // spent, revoked, or the wrong client. Anything else (offline, a
      // DNS blip, a blocked preflight on the Cognito domain) is a
      // transport failure, and clearing on that threw away a refresh
      // token still valid for up to two days: thirty seconds of flaky
      // wifi at minute 58 ended the session for no reason.
      //
      // Keeping the token on a transport failure cannot loop, because
      // the request that triggered it fails anyway and the next attempt
      // re-enters here rather than retrying with something dead.
      if (cause instanceof AuthError) clearTokens();
      return null;
    })
    .finally(() => {
      inFlightRefresh = null;
    });

  return inFlightRefresh;
}

/** Set once we have started navigating, so concurrent 401s do not stack up. */
let reauthenticating = false;

/**
 * Hand the browser back to sign-in, preserving where the user was.
 *
 * A full-page navigation, not a router push: the token store is gone,
 * so every mounted component is about to fail, and the cheapest correct
 * thing is to stop running this document.
 *
 * `endSession()` IS NOT OPTIONAL, and leaving it out made
 * re-authentication impossible. The tokens live in sessionStorage and
 * the marker cookie is separate, so clearing only the former leaves
 * middleware.ts believing there is a session. `/login` is in
 * GUEST_ONLY_PATHS, so it then redirects a "signed-in" visitor straight
 * to /dashboard:
 *
 *   $ curl -i '/login?next=%2Fadmin%2Fusers' -H 'Cookie: costhub_session=...'
 *   HTTP/1.1 307 Temporary Redirect
 *   location: /dashboard
 *
 * The user could not reach the sign-in page by any route, including
 * typing it, until the cookie aged out 8 hours later. Clearing both
 * makes the router's view agree with the token store's.
 *
 * And it must not fire on the pages that ARE signing in. A 401 from
 * `GET /meta/me` during the callback would otherwise navigate to
 * /login, which auto-starts a new sign-in, which Cognito answers with a
 * fresh code from its own still-live session -- an unbounded loop that
 * re-posts to the token endpoint every cycle and never paints the
 * error screen built to explain it. Returning early lets the 401
 * propagate to the caller, which is the only place that can say what
 * went wrong.
 */
function reauthenticate(): void {
  if (reauthenticating || typeof window === 'undefined') return;

  clearTokens();
  endSession();

  const here = `${window.location.pathname}${window.location.search}`;
  if (here.startsWith('/login') || here.startsWith('/auth/callback')) return;

  reauthenticating = true;
  window.location.assign(`/login?next=${encodeURIComponent(here)}`);
}

// ---- requests ----------------------------------------------------------

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  /** Appended as a query string; null and undefined values are dropped. */
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  /** Keys whose values must not be key-renamed (free-form JSON). */
  opaque?: readonly string[];
}

function url(path: string, query: RequestOptions['query']): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== null && value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return `${API_BASE_URL}${path}${qs ? `?${qs}` : ''}`;
}

/**
 * FastAPI puts its message in `detail`, which is either a string or a
 * list of validation errors. Anything else is reported by status, since
 * echoing an unknown body into the UI is how a stack trace reaches a
 * user.
 */
function messageFrom(status: number, payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const detail = (payload as Record<string, unknown>).detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail) && detail.length > 0) {
      const first = detail[0] as Record<string, unknown> | undefined;
      const msg = first && typeof first.msg === 'string' ? first.msg : null;
      if (msg) return msg;
    }
  }
  return `Request failed (${status}).`;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = await bearerToken();
  if (!token) {
    reauthenticate();
    throw new ApiError(401, 'Your session has expired. Sign in again.');
  }

  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(url(path, options.query), {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      // No cookies: authorization is the bearer token, and sending
      // credentials would tighten the CORS requirements for nothing.
      credentials: 'omit',
    });
  } catch {
    // fetch rejects for network failure, for a blocked CORS preflight,
    // AND for a response that carries no CORS headers -- which includes
    // every unhandled server-side 500, since the API installs no
    // exception handler and Starlette's error response is synthesised
    // outside the CORS middleware. The browser deliberately hides which
    // of the three happened, so naming all three is the honest message;
    // blaming CORS alone sent people to the wrong place.
    throw new NetworkError(
      `Could not reach the API at ${API_BASE_URL}. It may be unreachable, this origin may not be in its CORS allow list, or the request failed server-side.`,
    );
  }

  if (response.status === 204) return undefined as T;

  let payload: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    if (response.status === 401) {
      reauthenticate();
      throw new ApiError(401, 'Your session has expired. Sign in again.');
    }
    throw new ApiError(response.status, messageFrom(response.status, payload));
  }

  return camelKeys(payload, options.opaque) as T;
}

/**
 * Just the rows out of a `{data: [...]}` response.
 *
 * Reads also carry `as_of`, `metric`, `currency` and `partial_period`,
 * and those are NOT decoration for the cost screens: `billed_cost` and
 * `effective_cost` differ, and a figure labelled with neither (nor with
 * how stale it is) is the kind of number that gets disputed. No caller
 * needs them yet -- the admin endpoints return money-free rows -- so
 * there is deliberately no Envelope type here to go stale. Whoever
 * wires the cost screens should add one and surface those fields rather
 * than reach for this function.
 */
export async function getRows<T>(path: string, options: RequestOptions = {}): Promise<T[]> {
  const raw = await request<{ data?: T[] }>(path, { ...options, method: 'GET' });
  return raw.data ?? [];
}

export function get<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return request<T>(path, { ...options, method: 'GET' });
}

export function post<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  return request<T>(path, { ...options, method: 'POST', body });
}

export function del<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return request<T>(path, { ...options, method: 'DELETE' });
}
