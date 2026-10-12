export const SESSION_COOKIE = 'cloudlens_session';

/**
 * Built-in demo account, used ONLY in mock mode
 * (`NEXT_PUBLIC_USE_MOCK` not "false"). These are intentionally public:
 * in mock mode there is no backend and authentication is simulated end
 * to end. In live mode `/login` hands off to Cognito Managed Login and
 * nothing here is read.
 */
export const DEMO_CREDENTIALS = {
  email: 'admin@cloudlens.demo',
  password: 'CloudLens!2026',
} as const;

/**
 * Pages reachable without a session.
 *
 * `/auth/callback` has to be here: it is where Cognito delivers the
 * authorization code, and at that moment the browser has no session
 * yet. Guarding it would bounce every sign-in back to `/login`, which
 * is a loop that completes successfully forever and never signs anyone
 * in.
 */
export const PUBLIC_PATHS = [
  '/login',
  '/auth/callback',
  '/register',
  '/forgot-password',
  '/reset-password',
] as const;

/**
 * Public pages a signed-in user is redirected away from (the reset page
 * stays reachable).
 *
 * `/auth/callback` is deliberately NOT here. Re-authenticating while a
 * stale session cookie is still set is normal -- that is exactly what a
 * token refresh failure leads to -- and bouncing the callback would
 * discard the new code in favour of the dead session.
 */
export const GUEST_ONLY_PATHS = ['/login', '/register', '/forgot-password'] as const;
