'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useToast } from '@/components/ui/toast';
import { useSession } from '@/hooks/use-session';
import {
  activeGrantsFor,
  grantAccess,
  inviteUser,
  readAuditLog,
  readGrants,
  readUsers,
  revokeGrant,
  setUserStatus,
  type GrantInput,
  type InviteInput,
} from '@/lib/services/admin-service';
import type { AuditEntry, Grant, ManagedUser } from '@/types/domain';

interface AdminContextValue {
  users: ManagedUser[];
  grants: Grant[];
  audit: AuditEntry[];
  grantsFor: (userId: string) => Grant[];
  invite: (input: InviteInput) => void;
  grant: (input: GrantInput) => void;
  revoke: (grantId: string, reason?: string) => void;
  disable: (userId: string) => void;
  enable: (userId: string) => void;
}

const Ctx = createContext<AdminContextValue | null>(null);

/**
 * Users, grants and the audit log for the admin screens.
 *
 * Every mutation goes through admin-service and then re-reads the whole
 * collection into state. That looks wasteful and is deliberate: it is
 * the same shape the real API will have (mutate, then refetch), so
 * swapping the service for HTTP calls does not change this file. Local
 * optimistic merging would have to be unpicked later.
 *
 * Mounted inside the (app) layout only. There is no guard here, because
 * hiding the screens is not the access control -- the API rejects a
 * non-superadmin regardless.
 */
export function AdminProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const { user } = useSession();
  const actor = user?.email ?? 'unknown';

  const [users, setUsers] = useState<ManagedUser[]>(() => readUsers());
  const [grants, setGrants] = useState<Grant[]>(() => readGrants());
  const [audit, setAudit] = useState<AuditEntry[]>(() => readAuditLog());

  const refresh = useCallback(() => {
    setUsers([...readUsers()]);
    setGrants([...readGrants()]);
    setAudit([...readAuditLog()]);
  }, []);

  const invite = useCallback(
    (input: InviteInput) => {
      const before = readUsers().length;
      inviteUser(input, actor);
      refresh();
      const added = readUsers().length > before;
      // Worth saying out loud: an invite grants nothing. This is the
      // single most misread part of the model.
      toast(
        added
          ? {
              tone: 'success',
              title: `Invited ${input.email}`,
              description: 'They can sign in, but will see no cost data until you grant them an account.',
            }
          : { tone: 'info', title: `${input.email} was already invited` },
      );
    },
    [actor, refresh, toast],
  );

  const grant = useCallback(
    (input: GrantInput) => {
      grantAccess(input, actor);
      refresh();
      const scope = input.serviceName ? `${input.accountName} / ${input.serviceName}` : input.accountName;
      toast({ tone: 'success', title: `Access granted to ${scope}`, description: 'Effective immediately — nothing is cached.' });
    },
    [actor, refresh, toast],
  );

  const revoke = useCallback(
    (grantId: string, reason?: string) => {
      revokeGrant(grantId, actor, reason);
      refresh();
      toast({ tone: 'warning', title: 'Grant revoked', description: 'The grant is kept with a revoked timestamp, so the history survives.' });
    },
    [actor, refresh, toast],
  );

  const disable = useCallback(
    (userId: string) => {
      setUserStatus(userId, 'disabled', actor);
      refresh();
      toast({ tone: 'warning', title: 'User disabled', description: 'Their grants are untouched and apply again if you re-enable them.' });
    },
    [actor, refresh, toast],
  );

  const enable = useCallback(
    (userId: string) => {
      setUserStatus(userId, 'active', actor);
      refresh();
      toast({ tone: 'success', title: 'User enabled' });
    },
    [actor, refresh, toast],
  );

  const grantsFor = useCallback((userId: string) => activeGrantsFor(userId), []);

  const value = useMemo(
    () => ({ users, grants, audit, grantsFor, invite, grant, revoke, disable, enable }),
    [users, grants, audit, grantsFor, invite, grant, revoke, disable, enable],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAdmin(): AdminContextValue {
  const value = useContext(Ctx);
  if (!value) throw new Error('useAdmin must be used inside AdminProvider');
  return value;
}
