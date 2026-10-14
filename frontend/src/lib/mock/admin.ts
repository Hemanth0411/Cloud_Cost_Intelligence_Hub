/**
 * Mock users, grants and audit entries.
 *
 * Built the same way as the cost dataset: a fixed seed through the
 * mulberry32 PRNG in seed.ts, so every render -- server and client --
 * produces byte-identical data. Anything random per-call would hydrate
 * differently on the client and React would throw the tree away.
 *
 * The grants are deliberately NOT uniform. One user sees a single
 * account, one sees a single service inside an account, one has an
 * expiring grant and one has a revoked one, because the point of the
 * admin screens is to show that access is narrow and auditable rather
 * than to show a tidy table.
 */
import { getFilterOptions } from '@/lib/services/cost-service';
import { createRng, hashString } from './seed';
import type { AuditEntry, Grant, ManagedUser } from '@/types/domain';

const SEED = 0x51a7e;
const DAY = 24 * 60 * 60 * 1000;

/** Fixed clock so timestamps are stable across renders. */
const NOW = Date.parse('2026-10-12T09:00:00Z');

function iso(daysAgo: number, hourOffset = 0): string {
  return new Date(NOW - daysAgo * DAY + hourOffset * 3600_000).toISOString();
}

const USERS: ManagedUser[] = [
  // THE SIGNED-IN DEMO ADMIN, and they have to be here.
  //
  // In live mode a superadmin reading this screen sees their own row,
  // because `GET /admin/users` returns every user. The mock list left
  // the demo account out, so the one person looking at the table was
  // the one person missing from it -- and the rules that refuse to let
  // you remove or demote YOURSELF were unreachable in a demo, since no
  // row matched the session. Their email is DEMO_CREDENTIALS.email.
  {
    id: 'u-0000',
    email: 'admin@costhub.demo',
    displayName: 'You (demo admin)',
    role: 'superadmin',
    status: 'active',
    invitedAt: iso(30),
    lastSeenAt: iso(0),
  },
  {
    id: 'u-0001',
    email: 'hemanth.reddy@chryselys.com',
    displayName: 'Hemanth Reddy',
    role: 'superadmin',
    status: 'active',
    invitedAt: iso(21),
    lastSeenAt: iso(0, -2),
  },
  {
    id: 'u-0002',
    email: 'finance.lead@chryselys.com',
    displayName: 'Finance Lead',
    role: 'user',
    status: 'active',
    invitedAt: iso(14),
    lastSeenAt: iso(1),
  },
  {
    id: 'u-0003',
    email: 'platform.eng@chryselys.com',
    displayName: 'Platform Engineer',
    role: 'user',
    status: 'active',
    invitedAt: iso(9),
    lastSeenAt: iso(3),
  },
  {
    id: 'u-0004',
    email: 'new.joiner@chryselys.com',
    displayName: null,
    role: 'user',
    status: 'invited',
    invitedAt: iso(1),
    lastSeenAt: null,
  },
  {
    id: 'u-0005',
    email: 'former.contractor@chryselys.com',
    displayName: 'Former Contractor',
    role: 'user',
    status: 'disabled',
    invitedAt: iso(60),
    lastSeenAt: iso(18),
  },
];

export function mockUsers(): ManagedUser[] {
  return USERS;
}

export function mockGrants(): Grant[] {
  const accounts = getFilterOptions().accounts;
  if (accounts.length === 0) return [];

  const rng = createRng(SEED);
  const pick = (i: number) => accounts[Math.floor(rng() * accounts.length) % accounts.length] ?? accounts[i % accounts.length];

  const finance = pick(0);
  const platform = pick(1);
  const expiring = pick(2);
  const revoked = pick(3);

  return [
    {
      id: 'g-0001',
      userId: 'u-0002',
      userEmail: 'finance.lead@chryselys.com',
      providerId: finance.providerId,
      accountId: finance.id,
      accountName: finance.name,
      serviceName: null,
      grantedBy: 'hemanth.reddy@chryselys.com',
      grantedAt: iso(14),
      validUntil: null,
      revokedAt: null,
      reason: 'Monthly cost reporting',
    },
    {
      id: 'g-0002',
      userId: 'u-0003',
      userEmail: 'platform.eng@chryselys.com',
      providerId: platform.providerId,
      accountId: platform.id,
      accountName: platform.name,
      // Narrowed to one service: the clearest demonstration that a grant
      // is not all-or-nothing.
      serviceName: 'Amazon Elastic Compute Cloud',
      grantedBy: 'hemanth.reddy@chryselys.com',
      grantedAt: iso(9),
      validUntil: null,
      revokedAt: null,
      reason: 'Owns the compute footprint',
    },
    {
      id: 'g-0003',
      userId: 'u-0003',
      userEmail: 'platform.eng@chryselys.com',
      providerId: expiring.providerId,
      accountId: expiring.id,
      accountName: expiring.name,
      serviceName: null,
      grantedBy: 'hemanth.reddy@chryselys.com',
      grantedAt: iso(4),
      // Expires in three days -- the UI should say so before it lapses,
      // because a silently expiring grant is how someone stops getting
      // alerts without noticing.
      validUntil: iso(-3),
      revokedAt: null,
      reason: 'Temporary migration review',
    },
    {
      id: 'g-0004',
      userId: 'u-0005',
      userEmail: 'former.contractor@chryselys.com',
      providerId: revoked.providerId,
      accountId: revoked.id,
      accountName: revoked.name,
      serviceName: null,
      grantedBy: 'hemanth.reddy@chryselys.com',
      grantedAt: iso(60),
      validUntil: null,
      revokedAt: iso(18),
      reason: 'Contract ended',
    },
  ];
}

export function mockAuditLog(): AuditEntry[] {
  const grants = mockGrants();
  const entries: AuditEntry[] = [];

  // One entry per grant, in the same transaction as the grant itself --
  // which is the backend's actual guarantee, so the mock should not show
  // a grant without its audit row.
  grants.forEach((g, i) => {
    entries.push({
      id: `a-${String(100 + i * 2)}`,
      at: g.grantedAt,
      actor: g.grantedBy,
      action: 'grant.create',
      entityType: 'access_grant',
      entityId: g.id,
      before: null,
      after: {
        user_email: g.userEmail,
        account_id: g.accountId,
        service_name: g.serviceName,
        valid_until: g.validUntil,
      },
    });
    if (g.revokedAt) {
      entries.push({
        id: `a-${String(101 + i * 2)}`,
        at: g.revokedAt,
        actor: g.grantedBy,
        action: 'grant.revoke',
        entityType: 'access_grant',
        entityId: g.id,
        before: { account_id: g.accountId, service_name: g.serviceName },
        after: { revoked_at: g.revokedAt, reason: g.reason },
      });
    }
  });

  mockUsers().forEach((u, i) => {
    entries.push({
      id: `a-${String(200 + i)}`,
      at: u.invitedAt,
      actor: 'hemanth.reddy@chryselys.com',
      action: 'user.invite',
      entityType: 'user',
      entityId: u.id,
      before: null,
      after: { email: u.email, status: u.status },
    });
    if (u.status === 'disabled') {
      entries.push({
        id: `a-${String(300 + i)}`,
        at: iso(18),
        actor: 'hemanth.reddy@chryselys.com',
        action: 'user.disable',
        entityType: 'user',
        entityId: u.id,
        before: { status: 'active' },
        after: { status: 'disabled' },
      });
    }
  });

  // A superadmin bypass, because an unlogged bypass is indistinguishable
  // from a leak and the audit screen should prove it gets recorded.
  entries.push({
    id: 'a-400',
    at: iso(0, -3),
    actor: 'hemanth.reddy@chryselys.com',
    action: 'access.superadmin_bypass',
    entityType: 'fact_cost_daily',
    entityId: 'u-0001',
    before: null,
    after: { role: 'superadmin', scope: 'aws|*|*|last 30 days', window: '1h' },
  });

  return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : hashString(a.id) - hashString(b.id)));
}
