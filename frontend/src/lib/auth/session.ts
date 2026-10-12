import type { User } from '@/types/domain';
import { SESSION_COOKIE } from './constants';

/**
 * The session MARKER cookie. Not a credential, and not a security
 * boundary.
 *
 * It holds a name, an email and a role, so that two things can work
 * without reading a token:
 *
 *  * `middleware.ts` runs on the server and can only see cookies. It
 *    uses this to redirect a signed-out visitor to `/login` instead of
 *    flashing an empty dashboard.
 *  * the sidebar decides whether to render the admin group.
 *
 * NO TOKEN IS EVER PUT IN HERE. The tokens live in sessionStorage
 * (`lib/auth/tokens.ts`); this cookie is readable by JavaScript and is
 * sent on every same-origin request, so a token in it would be strictly
 * worse off than where it is.
 *
 * In live mode the contents are derived from the ID token's verified
 * claims -- but the cookie itself is unsigned and a user can edit it.
 * That changes nothing that matters: the API re-derives the role from
 * its own `users` table on every request and returns 403 regardless of
 * what the UI chose to render. Editing this buys an empty admin screen.
 */
export function isUser(value: unknown): value is User {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).name === 'string' &&
    typeof (value as Record<string, unknown>).email === 'string' &&
    typeof (value as Record<string, unknown>).role === 'string'
  );
}

/** `; secure` only over https, or the cookie is silently rejected on localhost. */
function secureAttr(): string {
  return typeof window !== 'undefined' && window.location.protocol === 'https:' ? '; secure' : '';
}

export function startSession(user: User): void {
  const value = encodeURIComponent(JSON.stringify(user));
  document.cookie = `${SESSION_COOKIE}=${value}; path=/; max-age=${60 * 60 * 8}; samesite=lax${secureAttr()}`;
}

export function endSession(): void {
  // The attributes must match the ones it was set with, or the browser
  // treats this as a different cookie and the original survives.
  document.cookie = `${SESSION_COOKIE}=; path=/; max-age=0; samesite=lax${secureAttr()}`;
}

export function readSession(): User | null {
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!match) return null;
  try {
    const raw: unknown = JSON.parse(decodeURIComponent(match.slice(SESSION_COOKIE.length + 1)));
    return isUser(raw) ? raw : null;
  } catch {
    return null;
  }
}
