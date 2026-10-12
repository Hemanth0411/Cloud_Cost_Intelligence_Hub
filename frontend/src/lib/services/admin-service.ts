/**
 * Data-access facade for the admin screens.
 *
 * Same contract as cost-service: UI code only talks to this module,
 * never to the mock data directly, so swapping in the real API means
 * replacing these function bodies and nothing else.
 *
 * The real endpoints these map to already exist:
 *
 *   readUsers       -> GET    /admin/users
 *   inviteUser      -> POST   /admin/users
 *   readGrants      -> GET    /admin/grants
 *   grantAccess     -> POST   /admin/grants
 *   revokeGrant     -> DELETE /admin/grants/{id}
 *   readAuditLog    -> GET    /admin/audit
 *
 * All of them are superadmin-only and the API enforces that regardless
 * of what the UI renders -- these screens are a convenience, not the
 * access control.
 *
 * Mutations return the updated collection rather than mutating in place,
 * so callers hold immutable state and React re-renders predictably. In
 * the mock they operate on a module-level copy that resets on reload;
 * against the real API they will be awaited, which is why the signatures
 * are already shaped for it.
 */
import { mockAuditLog, mockGrants, mockUsers } from '@/lib/mock/admin';
import type { AuditEntry, Grant, ManagedUser, Role } from '@/types/domain';

/**
 * Session-local overlay on the mock data.
 *
 * Invites and grants made during a demo have to persist across a
 * navigation or the flow reads as broken -- click "grant", go to the
 * dashboard, come back, and it is gone. Module scope survives client-side
 * navigation and resets on a hard reload, which is the right lifetime for
 * a demo and costs nothing.
 */
let users: ManagedUser[] | null = null;
let grants: Grant[] | null = null;
let audit: AuditEntry[] | null = null;

function ensure(): void {
  users ??= [...mockUsers()];
  grants ??= [...mockGrants()];
  audit ??= [...mockAuditLog()];
}

function record(entry: Omit<AuditEntry, 'id' | 'at'>): void {
  ensure();
  audit = [
    { ...entry, id: `a-${Date.now()}`, at: new Date().toISOString() },
    ...(audit as AuditEntry[]),
  ];
}

// ------------------------------------------------------------- reads

export function readUsers(): ManagedUser[] {
  ensure();
  return users as ManagedUser[];
}

export function readGrants(): Grant[] {
  ensure();
  return grants as Grant[];
}

export function readAuditLog(): AuditEntry[] {
  ensure();
  return audit as AuditEntry[];
}

/** Live grants for one user: not revoked, and not past validUntil. */
export function activeGrantsFor(userId: string, now = new Date()): Grant[] {
  return readGrants().filter(
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
export function visibleAccountCount(user: ManagedUser, totalAccounts: number): number {
  if (user.role === 'superadmin') return totalAccounts;
  return new Set(activeGrantsFor(user.id).map((g) => g.accountId)).size;
}

// ------------------------------------------------------------ writes

export interface InviteInput {
  email: string;
  displayName?: string;
  role: Role;
}

export function inviteUser(input: InviteInput, actor: string): ManagedUser[] {
  ensure();
  const email = input.email.trim().toLowerCase();
  const existing = (users as ManagedUser[]).find((u) => u.email === email);
  if (existing) return users as ManagedUser[];

  const user: ManagedUser = {
    id: `u-${String(Date.now()).slice(-6)}`,
    email,
    displayName: input.displayName?.trim() || null,
    role: input.role,
    status: 'invited',
    invitedAt: new Date().toISOString(),
    lastSeenAt: null,
  };
  users = [...(users as ManagedUser[]), user];
  record({
    actor,
    action: 'user.invite',
    entityType: 'user',
    entityId: user.id,
    before: null,
    after: { email: user.email, role: user.role, status: user.status },
  });
  return users;
}

export function setUserStatus(userId: string, status: ManagedUser['status'], actor: string): ManagedUser[] {
  ensure();
  const before = (users as ManagedUser[]).find((u) => u.id === userId);
  if (!before || before.status === status) return users as ManagedUser[];

  users = (users as ManagedUser[]).map((u) => (u.id === userId ? { ...u, status } : u));
  record({
    actor,
    action: 'user.disable',
    entityType: 'user',
    entityId: userId,
    before: { status: before.status },
    after: { status },
  });
  return users;
}

export interface GrantInput {
  userId: string;
  providerId: string;
  accountId: string;
  accountName: string;
  /** null = every service in the account. */
  serviceName: string | null;
  validUntil: string | null;
  reason: string | null;
}

export function grantAccess(input: GrantInput, actor: string): Grant[] {
  ensure();
  const user = readUsers().find((u) => u.id === input.userId);
  if (!user) return grants as Grant[];

  const grant: Grant = {
    id: `g-${String(Date.now()).slice(-6)}`,
    userId: user.id,
    userEmail: user.email,
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
  grants = [...(grants as Grant[]), grant];
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
  return grants;
}

/**
 * Revoke by stamping revokedAt -- never by removing the row.
 *
 * The history of who could see what, and when, is the point of the audit
 * trail; deleting the grant would erase it. Revoking twice is a no-op,
 * matching the backend.
 */
export function revokeGrant(grantId: string, actor: string, reason?: string): Grant[] {
  ensure();
  const target = (grants as Grant[]).find((g) => g.id === grantId);
  if (!target || target.revokedAt) return grants as Grant[];

  const revokedAt = new Date().toISOString();
  grants = (grants as Grant[]).map((g) =>
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
  return grants;
}
