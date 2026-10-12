import type { User } from '@/types/domain';
import { SESSION_COOKIE } from './constants';

/** Client-only helpers. The cookie is a mock session marker, not a security boundary. */
export function isUser(value: unknown): value is User {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).name === 'string' &&
    typeof (value as Record<string, unknown>).email === 'string' &&
    typeof (value as Record<string, unknown>).role === 'string'
  );
}

export function startSession(user: User): void {
  const value = encodeURIComponent(JSON.stringify(user));
  document.cookie = `${SESSION_COOKIE}=${value}; path=/; max-age=${60 * 60 * 8}; samesite=lax`;
}

export function endSession(): void {
  document.cookie = `${SESSION_COOKIE}=; path=/; max-age=0; samesite=lax`;
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
