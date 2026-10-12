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
import { refreshTokens } from '@/lib/auth/cognito';
import { clearTokens, isStale, readTokens, writeTokens } from '@/lib/auth/tokens';
import { API_BASE_URL } from '@/lib/config';
import { camelKeys } from './case';

export class ApiError extends Error {
  readonly status: number;
  /** The server named who the caller is and refused. Render an empty state. */
  readonly forbidden: boolean;
  /** No usable token. The caller has already been sent to re-authenticate. */
  readonly unauthorized: boolean;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.forbidden = status === 403;
    this.unauthorized = status === 401;
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
    .catch(() => {
      // The refresh token is spent or revoked: this session is over.
      // Clearing it here is what stops the next request retrying
      // forever with the same dead token.
      clearTokens();
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
 */
function reauthenticate(): void {
  if (reauthenticating || typeof window === 'undefined') return;
  reauthenticating = true;
  clearTokens();
  const here = `${window.location.pathname}${window.location.search}`;
  const next = here.startsWith('/login') ? '' : `?next=${encodeURIComponent(here)}`;
  window.location.assign(`/login${next}`);
}

// ---- requests ----------------------------------------------------------

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  /** Appended as a query string; null and undefined values are dropped. */
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  /** Keys whose values must not be key-renamed (free-form JSON). */
  opaque?: readonly string[];
  signal?: AbortSignal;
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
      signal: options.signal,
      // No cookies: authorization is the bearer token, and sending
      // credentials would tighten the CORS requirements for nothing.
      credentials: 'omit',
    });
  } catch {
    // fetch rejects for network failure AND for a blocked CORS
    // preflight, and the browser deliberately hides which. Saying both
    // is more useful than guessing one.
    throw new NetworkError(
      `Could not reach the API at ${API_BASE_URL}. It may be unreachable, or this origin may not be in its CORS allow list.`,
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
 * The read envelope: `{data, as_of, metric, currency, partial_period,
 * row_count}`, camelised. `metric` and `asOf` are not decoration -- a
 * cost figure with neither is unlabelled, and `billed_cost` and
 * `effective_cost` differ.
 */
export interface Envelope<T> {
  data: T[];
  asOf: string | null;
  metric: string | null;
  currency: string;
  partialPeriod: boolean;
  rowCount: number;
}

export async function getEnvelope<T>(
  path: string,
  options: RequestOptions = {},
): Promise<Envelope<T>> {
  const raw = await request<Partial<Envelope<T>>>(path, { ...options, method: 'GET' });
  return {
    data: raw.data ?? [],
    asOf: raw.asOf ?? null,
    metric: raw.metric ?? null,
    currency: raw.currency ?? 'USD',
    partialPeriod: raw.partialPeriod ?? false,
    rowCount: raw.rowCount ?? (raw.data?.length ?? 0),
  };
}

/** Just the rows, for endpoints whose envelope fields nothing reads. */
export async function getRows<T>(path: string, options: RequestOptions = {}): Promise<T[]> {
  return (await getEnvelope<T>(path, options)).data;
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
