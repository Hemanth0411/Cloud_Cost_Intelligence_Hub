export const SESSION_COOKIE = 'cloudlens_session';

/**
 * Built-in demo account. These are intentionally public: this prototype has no backend and
 * authentication is simulated end to end.
 */
export const DEMO_CREDENTIALS = {
  email: 'admin@cloudlens.demo',
  password: 'CloudLens!2026',
} as const;

/** Pages reachable without a session. */
export const PUBLIC_PATHS = ['/login', '/register', '/forgot-password', '/reset-password'] as const;

/** Public pages a signed-in user is redirected away from (the reset page stays reachable). */
export const GUEST_ONLY_PATHS = ['/login', '/register', '/forgot-password'] as const;
