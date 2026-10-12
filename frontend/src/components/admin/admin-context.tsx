'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useToast } from '@/components/ui/toast';
import { useSession } from '@/hooks/use-session';
import { ApiError, NetworkError } from '@/lib/api/client';
import {
  activeGrantsFor,
  CAPABILITIES,
  grantAccess,
  inviteUser,
  loadAdmin,
  revokeGrant,
  setUserStatus,
  type AdminAccount,
  type GrantInput,
  type InviteInput,
} from '@/lib/services/admin-service';
import type { AuditEntry, Grant, ManagedUser, UserStatus } from '@/types/domain';

interface AdminContextValue {
  users: ManagedUser[];
  grants: Grant[];
  audit: AuditEntry[];
  /** Accounts a grant can be written against (real account ids in live mode). */
  accounts: AdminAccount[];
  /** True until the first load settles. */
  loading: boolean;
  /**
   * Why the admin data could not be read. `forbidden` is a designed
   * outcome, not a fault: the API refuses /admin/* to anyone who is not
   * a superadmin.
   */
  error: { message: string; forbidden: boolean } | null;
  reload: () => void;
  grantsFor: (userId: string) => Grant[];
  invite: (input: InviteInput) => void;
  grant: (input: GrantInput) => void;
  revoke: (grantId: string, reason?: string) => void;
  disable: (userId: string) => void;
  enable: (userId: string) => void;
  /** What this mode supports; the UI offers only what is here. */
  can: typeof CAPABILITIES;
}

const Ctx = createContext<AdminContextValue | null>(null);

const EMPTY: {
  users: ManagedUser[];
  grants: Grant[];
  audit: AuditEntry[];
  accounts: AdminAccount[];
} = { users: [], grants: [], audit: [], accounts: [] };

/**
 * Users, grants and the audit log for the admin screens.
 *
 * Every mutation goes through admin-service and then re-reads the whole
 * collection. That looks wasteful and is deliberate: the API is the
 * source of truth for what a grant became (its id, its `valid_from`,
 * whether an upsert collapsed it into an existing row), and optimistic
 * local merging would invent those and then disagree. Mutate, then
 * refetch.
 *
 * Mounted by `app/(app)/admin/layout.tsx`, so it only loads on the
 * screens that read it. A non-superadmin who reaches /admin/* gets a
 * 403 from the API, which is the correct answer and is held in `error`
 * as an empty state rather than thrown.
 *
 * There is no guard here. Hiding the screens is not the access control;
 * the API rejects a non-superadmin regardless of what renders.
 */
export function AdminProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const { user } = useSession();
  const actor = user?.email ?? 'unknown';

  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AdminContextValue['error']>(null);

  const reload = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    loadAdmin()
      .then((snapshot) => {
        if (cancelled) return;
        setData(snapshot);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // A 403 is the API stating the caller is not a superadmin. It
        // must not clear what is already on screen for someone who IS
        // one, so the collections are only emptied on the first load.
        setData(EMPTY);
        setError(describe(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => reload(), [reload]);

  /**
   * One place that turns a thrown error into something a user can read.
   *
   * Mutations report through a toast rather than the page-level `error`,
   * because the page is still showing valid data -- it was the write
   * that failed, and blanking the table would lose the context needed to
   * retry.
   */
  const run = useCallback(
    (action: () => Promise<void>, onDone: () => void) => {
      action()
        .then(() => {
          onDone();
          reload();
        })
        .catch((cause: unknown) => {
          const described = describe(cause);
          toast({ tone: 'warning', title: 'That did not go through', description: described.message });
        });
    },
    [reload, toast],
  );

  const invite = useCallback(
    (input: InviteInput) => {
      const before = data.users.length;
      run(
        () => inviteUser(input, actor),
        () => {
          // Worth saying out loud: an invite grants nothing. This is the
          // single most misread part of the model. Whether the user was
          // new is decided by the reload, so the count is compared
          // against what was on screen.
          toast({
            tone: 'success',
            title: `Invited ${input.email}`,
            description:
              before === data.users.length
                ? 'They can sign in, but will see no cost data until you grant them an account.'
                : 'Invite sent.',
          });
        },
      );
    },
    [actor, data.users.length, run, toast],
  );

  const grant = useCallback(
    (input: GrantInput) => {
      const scope = input.serviceName ? `${input.accountName} / ${input.serviceName}` : input.accountName;
      run(
        () => grantAccess(input, actor),
        () =>
          toast({
            tone: 'success',
            title: `Access granted to ${scope}`,
            description: 'Effective immediately — nothing is cached.',
          }),
      );
    },
    [actor, run, toast],
  );

  const revoke = useCallback(
    (grantId: string, reason?: string) => {
      run(
        () => revokeGrant(grantId, actor, reason),
        () =>
          toast({
            tone: 'warning',
            title: 'Grant revoked',
            description: 'The grant is kept with a revoked timestamp, so the history survives.',
          }),
      );
    },
    [actor, run, toast],
  );

  const setStatus = useCallback(
    (userId: string, status: UserStatus, title: string, description?: string) => {
      run(
        () => setUserStatus(userId, status, actor),
        () => toast({ tone: status === 'disabled' ? 'warning' : 'success', title, description }),
      );
    },
    [actor, run, toast],
  );

  const disable = useCallback(
    (userId: string) =>
      setStatus(
        userId,
        'disabled',
        'User disabled',
        'Their grants are untouched and apply again if you re-enable them.',
      ),
    [setStatus],
  );

  const enable = useCallback(
    (userId: string) => setStatus(userId, 'active', 'User enabled'),
    [setStatus],
  );

  const grantsFor = useCallback(
    (userId: string) => activeGrantsFor(data.grants, userId),
    [data.grants],
  );

  const value = useMemo(
    () => ({
      users: data.users,
      grants: data.grants,
      audit: data.audit,
      accounts: data.accounts,
      loading,
      error,
      reload,
      grantsFor,
      invite,
      grant,
      revoke,
      disable,
      enable,
      can: CAPABILITIES,
    }),
    [data, loading, error, reload, grantsFor, invite, grant, revoke, disable, enable],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Turns anything thrown into a message, without leaking internals. */
function describe(cause: unknown): { message: string; forbidden: boolean } {
  if (cause instanceof ApiError) {
    return {
      message: cause.forbidden
        ? 'These screens are superadmin-only, and the API says this account is not one.'
        : cause.message,
      forbidden: cause.forbidden,
    };
  }
  if (cause instanceof NetworkError) return { message: cause.message, forbidden: false };
  return {
    message: cause instanceof Error ? cause.message : 'Something went wrong.',
    forbidden: false,
  };
}

export function useAdmin(): AdminContextValue {
  const value = useContext(Ctx);
  if (!value) throw new Error('useAdmin must be used inside AdminProvider');
  return value;
}
