'use client';

import { useAdmin } from '@/components/admin/admin-context';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { demotionRefusal } from '@/lib/services/admin-service';
import type { ManagedUser } from '@/types/domain';

/**
 * Confirm granting or revoking superadmin.
 *
 * WHY THIS IS A DIALOG AND NOT A TOGGLE. Superadmin is not a preference:
 * it replaces the SQL grant predicate with TRUE, so the holder reads
 * every account's spend regardless of what anyone granted them. That is
 * the single most consequential change available on this screen, and the
 * asymmetry is worth stating in both directions — promoting hands over
 * all of the cost data, demoting can strip an administrator the product
 * cannot function without.
 *
 * Only the demotion direction can be refused, which is why there is one
 * dialog and not two: promoting can never reduce the number of
 * superadmins, so it has no rule to break.
 */
export function UserRoleDialog({
  user,
  onClose,
}: {
  /** The user whose role is being changed, or null when closed. */
  user: ManagedUser | null;
  onClose: () => void;
}) {
  const { users, actorEmail, setRole } = useAdmin();
  if (!user) return null;

  const promoting = user.role !== 'superadmin';
  const refusal = promoting ? null : demotionRefusal(user, actorEmail, users);
  const name = user.displayName ?? user.email;

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={
        refusal
          ? `Cannot demote ${name}`
          : promoting
            ? `Make ${name} a superadmin?`
            : `Remove ${name}'s superadmin role?`
      }
      description={
        refusal
          ? 'This one is blocked on purpose.'
          : promoting
            ? 'They will see every account, including ones nobody granted them.'
            : 'They keep their account and their grants.'
      }
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {refusal ? 'Close' : 'Cancel'}
          </Button>
          {!refusal && (
            <Button
              variant={promoting ? 'default' : 'destructive'}
              size="sm"
              onClick={() => {
                setRole(user, promoting ? 'superadmin' : 'user');
                onClose();
              }}
            >
              {promoting ? 'Grant superadmin' : 'Revoke superadmin'}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3 text-xs">
        {refusal !== null ? (
          <p className="rounded-md border bg-muted/30 px-3 py-2.5 text-muted-foreground">
            {refusal} The product refuses any change that would leave nobody able to manage users
            and accounts — the only way back from that is a command-line command on the machine
            holding the deployment credentials.
          </p>
        ) : promoting ? (
          <>
            <p>
              <code className="font-mono">{user.email}</code> will read the cost of every
              connected account, present and future, without holding a grant for any of them.
              Grants stop applying to them entirely.
            </p>
            <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2.5">
              <p className="font-medium">It is visible, not silent</p>
              <p className="text-muted-foreground">
                Every query a superadmin runs that bypasses the grant predicate writes an audit
                entry recording what they opened. The promotion itself is audited too.
              </p>
            </div>
            <p className="text-muted-foreground">
              They also gain these admin screens: inviting and removing users, changing roles, and
              registering cloud accounts.
            </p>
          </>
        ) : (
          <>
            <p>
              <code className="font-mono">{user.email}</code> will see only the accounts they hold
              a grant for, and will lose these admin screens. Their account, their status and
              their grants are untouched.
            </p>
            <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2.5">
              <p className="font-medium">Check their grants first</p>
              <p className="text-muted-foreground">
                A superadmin has had no need of grants, so they may well hold none. If so, their
                dashboard goes empty the moment this lands — which is the designed behaviour for a
                user with no access, and looks exactly like a fault. Granting them an account
                before demoting avoids it.
              </p>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
