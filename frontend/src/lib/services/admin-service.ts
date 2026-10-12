/**
 * Data-access facade for the admin screens.
 *
 * Same contract as cost-service: UI code only talks to this module,
 * never to the mock data or to `fetch` directly. Which mode it runs in
 * is decided once per page load, by `isMock()`, and nothing above
 * this line can tell.
 *
 * The endpoints, live:
 *
 *   loadAdmin       -> GET    /admin/users
 *                      GET    /admin/grants
 *                      GET    /admin/audit
 *                      GET    /meta/accounts
 *   readServices    -> GET    /meta/services?provider&account_id
 *   inviteUser      -> POST   /admin/users
 *   grantAccess     -> POST   /admin/grants
 *   revokeGrant     -> DELETE /admin/grants/{id}
 *
 * All of them are superadmin-only and the API enforces that regardless
 * of what the UI renders -- these screens are a convenience, not the
 * access control.
 *
 * WHY ONE `loadAdmin` RATHER THAN FOUR READS: a grant row from the API
 * carries an email and an account id, and the screens show a user name
 * and an account name. Stitching needs all four collections in hand at
 * once, so fetching them separately would only move the join into the
 * React tree, where a partially-arrived set renders rows with blank
 * names. They are requested in parallel and assembled here.
 *
 * TWO CAPABILITIES ARE MOCK-ONLY, and the flags below say so rather
 * than the buttons silently failing:
 *
 *  * `canSetUserStatus` -- there is no endpoint to enable or disable a
 *    user. The `users.status` column and its CHECK constraint exist;
 *    nothing in `api/routes/admin.py` writes them.
 *  * `canSetUserRole` -- `POST /admin/users` takes `email` and
 *    `display_name` only. A role picker on the invite dialog would be a
 *    control that changes nothing, which is worse than its absence.
 */
import { del, get, getRows, post } from '@/lib/api/client';
import { isMock } from '@/lib/mode';
import { mockAuditLog, mockGrants, mockUsers } from '@/lib/mock/admin';
import { getFilterOptions } from '@/lib/services/cost-service';
import type { AuditEntry, Grant, ManagedUser, Role, UserStatus } from '@/types/domain';

/** An account a grant can be written against. */
export interface AdminAccount {
  providerId: string;
  /** The cloud-native id -- what `access_grants.account_id` stores. */
  accountId: string;
  name: string;
}

export interface AdminSnapshot {
  users: ManagedUser[];
  grants: Grant[];
  audit: AuditEntry[];
  accounts: AdminAccount[];
}

/** What this mode can actually do, so the UI offers only that. */
export const CAPABILITIES = {
  canSetUserStatus: isMock(),
  canSetUserRole: isMock(),
} as const;

// ----------------------------------------------------- pure selectors

/** Live grants for one user: not revoked, and not past validUntil. */
export function activeGrantsFor(
  grants: readonly Grant[],
  userId: string,
  now = new Date(),
): Grant[] {
  return grants.filter(
    (g) => g.userId === userId && !g.revokedAt && (!g.validUntil || new Date(g.validUntil) > now),
  );
}

/**
 * What the dashboard would show this user.
 *
 * The honest summary of a grant list: a superadmin sees everything, and
 * everyone else sees exactly the accounts they were given. Zero accounts
 * is a legitimate state, not an error -- it is what a newly invited user
 * sees until someone grants them something.
 */
export function visibleAccountCount(
  user: ManagedUser,
  grants: readonly Grant[],
  totalAccounts: number,
): number {
  if (user.role === 'superadmin') return totalAccounts;
  return new Set(activeGrantsFor(grants, user.id).map((g) => g.accountId)).size;
}

// ----------------------------------------------------------- the wire

interface ApiUser {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
}

interface ApiGrant {
  id: string;
  email: string;
  provider: string;
  accountId: string;
  serviceName: string | null;
  validUntil: string | null;
  revokedAt: string | null;
  reason: string | null;
  createdBy: string;
  createdAt: string;
  // `valid_from` and `is_active` also come back and are not read.
  //
  // `is_active` is the backend's own liveness verdict and it matches the
  // security predicate exactly, so using it would be better than
  // `activeGrantsFor` re-deriving the rule here. It is not mapped
  // because the mock path has no such field, and one of the two modes
  // silently computing liveness differently is worse than both
  // computing it the same imperfect way. Worth revisiting with the
  // cost screens, when `valid_from` can also start being set.
}

interface ApiAuditEntry {
  /** `audit_log.id` is a bigserial, so this arrives as a NUMBER. */
  id: number | string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  at: string;
}

interface ApiAccount {
  provider: string;
  accountId: string;
  accountName: string | null;
}

/** The two values the column constraints allow; anything else is 'user'. */
const asRole = (value: string): Role => (value === 'superadmin' ? 'superadmin' : 'user');

const STATUSES: readonly UserStatus[] = ['invited', 'active', 'disabled'];
const asStatus = (value: string): UserStatus =>
  (STATUSES as readonly string[]).includes(value) ? (value as UserStatus) : 'invited';

/**
 * `before` and `after` are free-form snapshots of whatever was written,
 * so their KEYS are data. Renaming `valid_until` to `validUntil` inside
 * one would be editing the record the audit log exists to preserve.
 */
const AUDIT_OPAQUE = ['before', 'after'] as const;

async function fetchSnapshot(): Promise<AdminSnapshot> {
  const [users, grants, audit, accounts] = await Promise.all([
    getRows<ApiUser>('/admin/users'),
    getRows<ApiGrant>('/admin/grants'),
    getRows<ApiAuditEntry>('/admin/audit', { query: { limit: 200 }, opaque: AUDIT_OPAQUE }),
    get<{ data: ApiAccount[] }>('/meta/accounts').then((r) => r.data ?? []),
  ]);

  const accountNames = new Map(
    accounts.map((a) => [`${a.provider}|${a.accountId}`, a.accountName ?? a.accountId]),
  );
  const userIdByEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));

  return {
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      role: asRole(u.role),
      status: asStatus(u.status),
      // `created_at` is when the row was written, which for this system
      // is when the invite was sent -- there is no separate invited_at.
      invitedAt: u.createdAt,
      lastSeenAt: u.lastLoginAt,
    })),
    grants: grants.map((g) => ({
      id: g.id,
      // Resolved from the users list: grant rows key off email, and the
      // screens group by user id. An empty string means a grant whose
      // user has been soft-deleted, which groups under no row rather
      // than crashing the view.
      userId: userIdByEmail.get(g.email.toLowerCase()) ?? '',
      userEmail: g.email,
      providerId: g.provider,
      accountId: g.accountId,
      accountName: accountNames.get(`${g.provider}|${g.accountId}`) ?? g.accountId,
      serviceName: g.serviceName,
      grantedBy: g.createdBy,
      grantedAt: g.createdAt,
      validUntil: g.validUntil,
      revokedAt: g.revokedAt,
      reason: g.reason,
    })),
    audit: audit.map((e) => ({
      id: String(e.id),
      at: e.at,
      actor: e.actor,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      before: e.before,
      after: e.after,
    })),
    accounts: accounts.map((a) => ({
      providerId: a.provider,
      accountId: a.accountId,
      name: a.accountName ?? a.accountId,
    })),
  };
}

// ------------------------------------------------------- the mock mode

/**
 * Session-local overlay on the mock data.
 *
 * Invites and grants made during a demo have to persist across a
 * navigation or the flow reads as broken -- click "grant", go to the
 * dashboard, come back, and it is gone. Module scope survives
 * client-side navigation and resets on a hard reload, which is the
 * right lifetime for a demo and costs nothing.
 */
let mockState: { users: ManagedUser[]; grants: Grant[]; audit: AuditEntry[] } | null = null;

function mock(): { users: ManagedUser[]; grants: Grant[]; audit: AuditEntry[] } {
  mockState ??= { users: [...mockUsers()], grants: [...mockGrants()], audit: [...mockAuditLog()] };
  return mockState;
}

function mockAccounts(): AdminAccount[] {
  return getFilterOptions().accounts.map((a) => ({
    providerId: a.providerId,
    accountId: a.id,
    name: a.name,
  }));
}

function record(entry: Omit<AuditEntry, 'id' | 'at'>): void {
  const state = mock();
  state.audit = [{ ...entry, id: `a-${Date.now()}`, at: new Date().toISOString() }, ...state.audit];
}

// ------------------------------------------------------------- reads

/** Everything the admin screens show, stitched and ready to render. */
export async function loadAdmin(): Promise<AdminSnapshot> {
  if (!isMock()) return fetchSnapshot();
  const state = mock();
  return {
    users: [...state.users],
    grants: [...state.grants],
    audit: [...state.audit],
    accounts: mockAccounts(),
  };
}

/**
 * Service names present in one account, for the grant dialog.
 *
 * Scoped to the account rather than to the provider on purpose:
 * offering every AWS service in the estate would let you grant a
 * service that account does not run, which is a grant that silently
 * matches nothing.
 */
export async function readServices(providerId: string, accountId: string): Promise<string[]> {
  if (!isMock()) {
    // Note the shape: /meta/services returns a list of plain STRINGS,
    // not objects, so there is nothing to camelise.
    const response = await get<{ data: string[] }>('/meta/services', {
      query: { provider: providerId, account_id: accountId },
    });
    return response.data ?? [];
  }
  const options = getFilterOptions();
  // Mock mode always knows this map; the null case belongs to live
  // mode, which took the branch above.
  const ids = new Set(options.serviceIdsByAccount?.[accountId] ?? []);
  return options.services.filter((s) => ids.has(s.id)).map((s) => s.name);
}

// ------------------------------------------------------------ writes

export interface InviteInput {
  email: string;
  displayName?: string;
  /** Mock mode only -- the API has no role parameter. See CAPABILITIES. */
  role?: Role;
}

export async function inviteUser(input: InviteInput, actor: string): Promise<void> {
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName?.trim() || null;

  if (!isMock()) {
    await post('/admin/users', { email, display_name: displayName });
    return;
  }

  const state = mock();
  if (state.users.some((u) => u.email === email)) return;
  const user: ManagedUser = {
    id: `u-${String(Date.now()).slice(-6)}`,
    email,
    displayName,
    role: input.role ?? 'user',
    status: 'invited',
    invitedAt: new Date().toISOString(),
    lastSeenAt: null,
  };
  state.users = [...state.users, user];
  record({
    actor,
    action: 'user.invite',
    entityType: 'user',
    entityId: user.id,
    before: null,
    after: { email: user.email, role: user.role, status: user.status },
  });
}

export interface GrantInput {
  userId: string;
  /** What the API keys a grant by. `userId` is for the mock overlay. */
  userEmail: string;
  providerId: string;
  accountId: string;
  accountName: string;
  /** null = every service in the account. */
  serviceName: string | null;
  validUntil: string | null;
  reason: string | null;
}

export async function grantAccess(input: GrantInput, actor: string): Promise<void> {
  if (!isMock()) {
    await post('/admin/grants', {
      email: input.userEmail,
      provider: input.providerId,
      account_id: input.accountId,
      service_name: input.serviceName,
      valid_until: input.validUntil,
      reason: input.reason,
    });
    return;
  }

  const state = mock();
  const grant: Grant = {
    id: `g-${String(Date.now()).slice(-6)}`,
    userId: input.userId,
    userEmail: input.userEmail,
    providerId: input.providerId,
    accountId: input.accountId,
    accountName: input.accountName,
    serviceName: input.serviceName,
    grantedBy: actor,
    grantedAt: new Date().toISOString(),
    validUntil: input.validUntil,
    revokedAt: null,
    reason: input.reason,
  };
  state.grants = [...state.grants, grant];
  record({
    actor,
    action: 'grant.create',
    entityType: 'access_grant',
    entityId: grant.id,
    before: null,
    after: {
      user_email: grant.userEmail,
      account_id: grant.accountId,
      service_name: grant.serviceName,
      valid_until: grant.validUntil,
    },
  });
}

/**
 * Revoke by stamping revokedAt -- never by removing the row.
 *
 * The history of who could see what, and when, is the point of the
 * audit trail; deleting the grant would erase it. Revoking twice is a
 * no-op, matching the backend.
 */
export async function revokeGrant(grantId: string, actor: string, reason?: string): Promise<void> {
  if (!isMock()) {
    await del(`/admin/grants/${encodeURIComponent(grantId)}`, {
      query: { reason: reason ?? null },
    });
    return;
  }

  const state = mock();
  const target = state.grants.find((g) => g.id === grantId);
  if (!target || target.revokedAt) return;

  const revokedAt = new Date().toISOString();
  state.grants = state.grants.map((g) =>
    g.id === grantId ? { ...g, revokedAt, reason: reason ?? g.reason } : g,
  );
  record({
    actor,
    action: 'grant.revoke',
    entityType: 'access_grant',
    entityId: grantId,
    before: { account_id: target.accountId, service_name: target.serviceName },
    after: { revoked_at: revokedAt, reason: reason ?? target.reason },
  });
}

/**
 * Enable or disable a user. MOCK ONLY -- see `CAPABILITIES`.
 *
 * Throws rather than quietly doing nothing if it is ever called in live
 * mode, so the gap shows up as a visible failure and not as a button
 * that appears to work.
 */
export async function setUserStatus(
  userId: string,
  status: UserStatus,
  actor: string,
): Promise<void> {
  if (!isMock()) {
    throw new Error('The API has no endpoint for enabling or disabling a user.');
  }
  const state = mock();
  const before = state.users.find((u) => u.id === userId);
  if (!before || before.status === status) return;

  state.users = state.users.map((u) => (u.id === userId ? { ...u, status } : u));
  record({
    actor,
    action: 'user.disable',
    entityType: 'user',
    entityId: userId,
    before: { status: before.status },
    after: { status },
  });
}
