import type { User } from '@/types/domain';
import { DEMO_CREDENTIALS } from './constants';
import { validatePassword } from './validation';

/**
 * Simulated account storage. There is no backend, and by design NO PASSWORD (or anything derived from
 * one) is ever stored: registering saves only a profile (name, email, role) and a reset token is a
 * random string with an expiry. The built-in demo account is checked against its public, documented
 * credentials; registered demo accounts only need a password that satisfies the policy.
 */

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const DEMO_ADMIN: User = { name: 'Alex Morgan', email: DEMO_CREDENTIALS.email, role: 'FinOps Admin' };

export const USERS_KEY = 'cloudlens:demo-users';
export const TOKENS_KEY = 'cloudlens:reset-tokens';
export const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_USERS = 25;
const MAX_TOKENS = 10;

export interface DemoUser extends User {
  createdAt: string;
}

export interface ResetToken {
  token: string;
  email: string;
  expiresAt: number;
  used: boolean;
}

/** localStorage when available (browser), otherwise null. */
export function browserStore(): KeyValueStore | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function readJson(store: KeyValueStore, key: string): unknown {
  try {
    const raw = store.getItem(key);
    return raw === null ? [] : (JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

export function listUsers(store: KeyValueStore): DemoUser[] {
  const raw = readJson(store, USERS_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((u): DemoUser[] =>
    isRecord(u) && typeof u.name === 'string' && typeof u.email === 'string' && typeof u.role === 'string' && typeof u.createdAt === 'string'
      ? [{ name: u.name, email: u.email, role: u.role, createdAt: u.createdAt }]
      : [],
  );
}

const sameEmail = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The built-in demo user or a registered one. */
export function findUser(store: KeyValueStore, email: string): User | null {
  if (sameEmail(email, DEMO_ADMIN.email)) return DEMO_ADMIN;
  const hit = listUsers(store).find((u) => sameEmail(u.email, email));
  return hit ? { name: hit.name, email: hit.email, role: hit.role } : null;
}

export type RegisterResult = { ok: true; user: User } | { ok: false; error: string };

export function registerUser(store: KeyValueStore, input: { name: string; email: string; role: string }, now: number): RegisterResult {
  if (findUser(store, input.email)) return { ok: false, error: 'An account with this email already exists. Try signing in.' };
  const users = listUsers(store);
  if (users.length >= MAX_USERS) return { ok: false, error: 'This demo is limited to 25 registered accounts. Clear demo data in Settings.' };
  const user: DemoUser = { name: input.name.trim(), email: input.email.trim().toLowerCase(), role: input.role, createdAt: new Date(now).toISOString() };
  try {
    store.setItem(USERS_KEY, JSON.stringify([...users, user]));
  } catch {
    return { ok: false, error: 'Could not save the demo account (browser storage is unavailable).' };
  }
  return { ok: true, user: { name: user.name, email: user.email, role: user.role } };
}

export type SignInResult = { ok: true; user: User } | { ok: false; error: string };

/**
 * Demo sign-in. The built-in admin must match the documented credentials exactly. A registered demo
 * account accepts any password that meets the policy, because no password is stored to compare against.
 */
export function signIn(store: KeyValueStore, email: string, password: string): SignInResult {
  const generic = { ok: false, error: 'Incorrect email or password.' } as const;
  if (sameEmail(email, DEMO_ADMIN.email)) return password === DEMO_CREDENTIALS.password ? { ok: true, user: DEMO_ADMIN } : generic;
  const user = findUser(store, email);
  if (!user || validatePassword(password) !== null) return generic;
  return { ok: true, user };
}

// ---- Simulated password reset ------------------------------------------------------------------------
export function randomToken(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function readTokens(store: KeyValueStore): ResetToken[] {
  const raw = readJson(store, TOKENS_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((t): ResetToken[] =>
    isRecord(t) && typeof t.token === 'string' && typeof t.email === 'string' && typeof t.expiresAt === 'number' && typeof t.used === 'boolean'
      ? [{ token: t.token, email: t.email, expiresAt: t.expiresAt, used: t.used }]
      : [],
  );
}

function writeTokens(store: KeyValueStore, tokens: ResetToken[]): void {
  try {
    store.setItem(TOKENS_KEY, JSON.stringify(tokens.slice(-MAX_TOKENS)));
  } catch {
    /* storage unavailable: the simulated flow degrades gracefully */
  }
}

/**
 * Starts a simulated reset: returns a token for a known email (replacing earlier tokens for it),
 * or null when the email is not registered. Callers show the same neutral message either way.
 */
export function createResetToken(store: KeyValueStore, email: string, now: number, random: () => string = randomToken): ResetToken | null {
  const user = findUser(store, email);
  if (!user) return null;
  const token: ResetToken = { token: random(), email: user.email, expiresAt: now + RESET_TOKEN_TTL_MS, used: false };
  writeTokens(store, [...readTokens(store).filter((t) => !sameEmail(t.email, user.email)), token]);
  return token;
}

export type TokenCheck = { status: 'valid'; email: string } | { status: 'invalid' | 'expired' | 'used' };

export function checkResetToken(store: KeyValueStore, token: string, now: number): TokenCheck {
  const hit = readTokens(store).find((t) => t.token === token);
  if (!hit) return { status: 'invalid' };
  if (hit.used) return { status: 'used' };
  if (now > hit.expiresAt) return { status: 'expired' };
  return { status: 'valid', email: hit.email };
}

/** Marks the token used (single use). No password is saved anywhere. */
export function consumeResetToken(store: KeyValueStore, token: string, now: number): TokenCheck {
  const check = checkResetToken(store, token, now);
  if (check.status !== 'valid') return check;
  writeTokens(store, readTokens(store).map((t) => (t.token === token ? { ...t, used: true } : t)));
  return check;
}

/** A store that holds nothing, for environments where localStorage is unavailable. */
export function emptyStore(): KeyValueStore {
  const memory = new Map<string, string>();
  return {
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => {
      memory.set(k, v);
    },
    removeItem: (k) => {
      memory.delete(k);
    },
  };
}
