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
  changeUserRole,
  grantAccess,
  inviteUser,
  loadAdmin,
  removeUser,
  revokeGrant,
  setUserStatus,
  type AdminAccount,
  type GrantInput,
  type InviteInput,
} from '@/lib/services/admin-service';
import type { AuditEntry, Grant, ManagedUser, Role, UserStatus } from '@/types/domain';

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
  /**
   * Resolves when the invite has landed, rejects if it did not.
   *
   * It returns a promise -- unlike every other mutation here -- because
   * the invite dialog has something to say AFTERWARDS that a toast
   * cannot carry: no email was sent, and here is the URL to pass on. It
   * has to know the write succeeded before it says that.
   */
  invite: (input: InviteInput) => Promise<void>;
  grant: (input: GrantInput) => void;
  revoke: (grant: Grant) => void;
  /** Soft delete, and disable their Cognito login. */
  remove: (user: ManagedUser) => void;
  setRole: (user: ManagedUser, role: Role) => void;
  disable: (userId: string) => void;
  enable: (userId: string) => void;
  /** The signed-in admin, for the "not yourself" rules. */
  actorEmail: string;
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

  /**
   * NOT through `run`, and that is the only reason this one differs.
   *
   * `run` turns a rejection into a toast and resolves anyway, which is
   * right for a fire-and-forget button and wrong here: the dialog shows
   * a confirmation saying no email was sent and handing over the app
   * URL, and it must not show that unless the write actually landed. So
   * the promise is returned with its rejection intact and the dialog
   * reports the failure itself. The reload and the toast still happen.
   *
   * The toast says one thing unconditionally, because an invite grants
   * nothing either way and that is the single most misread part of the
   * model. It used to try to say "already invited" by comparing a count
   * captured before the write against `data.users.length` after it --
   * but both came from the same render's closure, so they were always
   * equal and the branch was dead. The API cannot answer the question
   * anyway: POST /admin/users is an upsert and returns 201 with the same
   * body whether the row was new or not.
   */
  const invite = useCallback(
    (input: InviteInput) =>
      inviteUser(input, actor).then(() => {
        reload();
        toast({
          tone: 'success',
          title: `Invited ${input.email}`,
          description:
            'They can sign in, but will see no cost data until you grant them an account.',
        });
      }),
    [actor, reload, toast],
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
    (grant: Grant) => {
      // Takes the whole grant, not just its id, so the confirmation can
      // NAME the account. "Grant revoked" on a user with four of them
      // did not say which one had just gone.
      const scope = grant.serviceName
        ? `${grant.accountName} / ${grant.serviceName}`
        : grant.accountName;
      run(
        () => revokeGrant(grant.id, actor, 'Revoked from the users screen'),
        () =>
          toast({
            tone: 'warning',
            title: `Access to ${scope} revoked`,
            description:
              'That one account only — their other grants are untouched. The grant row is kept with a revoked timestamp, so the history survives.',
          }),
      );
    },
    [actor, run, toast],
  );

  /**
   * Remove a user, and say which halves actually happened.
   *
   * `loginDisabled: false` is not a failure of the removal -- they are
   * out of the product either way, because every endpoint refuses a
   * soft-deleted row. It means the Cognito user is still enabled, which
   * is worth telling the operator about rather than folding into a
   * cheerful "removed". Hence two different toasts off one response.
   */
  const remove = useCallback(
    (user: ManagedUser) => {
      removeUser(user.id, actor)
        .then((outcome) => {
          reload();
          toast(
            outcome.loginDisabled
              ? {
                  tone: 'warning',
                  title: `${user.email} removed`,
                  description:
                    'Their sign-in is disabled and the API refuses them. Their grants and the audit trail are kept, and inviting them again brings the account back.',
                }
              : {
                  tone: 'warning',
                  title: `${user.email} removed, but their login was not disabled`,
                  description: `The API already refuses them, so they have no access. Their Cognito user is still enabled though (${outcome.loginDetail}) — worth disabling by hand.`,
                },
          );
        })
        .catch((cause: unknown) => {
          toast({
            tone: 'warning',
            title: 'Nobody was removed',
            description: describe(cause).message,
          });
        });
    },
    [actor, reload, toast],
  );

  const setRole = useCallback(
    (user: ManagedUser, role: Role) => {
      const promoting = role === 'superadmin';
      run(
        () => changeUserRole(user.id, role, actor),
        () =>
          toast({
            tone: promoting ? 'warning' : 'success',
            title: promoting
              ? `${user.email} is now a superadmin`
              : `${user.email} is no longer a superadmin`,
            description: promoting
              ? 'They see every account and bypass grants. Every bypass is written to the audit log.'
              : 'They now see only the accounts they hold a grant for. Their grants were not changed.',
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
      remove,
      setRole,
      disable,
      enable,
      actorEmail: actor,
      can: CAPABILITIES,
    }),
    [
      data,
      loading,
      error,
      reload,
      grantsFor,
      invite,
      grant,
      revoke,
      remove,
      setRole,
      disable,
      enable,
      actor,
    ],
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
