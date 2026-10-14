'use client';

import { useAdmin } from '@/components/admin/admin-context';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { removalRefusal } from '@/lib/services/admin-service';
import type { ManagedUser } from '@/types/domain';

/**
 * Confirm removing a user, and correct what "remove" implies.
 *
 * SAME PROBLEM AS THE CONNECTION DELETE DIALOG, and the same answer.
 * "Remove" reads as "erase this person", and it does not: the `users`
 * row survives with `deleted_at` stamped, their grants are left exactly
 * as they were, and every audit entry naming them still resolves. What
 * stops is access. Someone who reads it the other way will either not
 * press it when they should, or press it believing they have complied
 * with a deletion request they have not.
 *
 * AND IT IS REVERSIBLE, which is the other thing nobody would guess.
 * Inviting the same address again revives this very row -- including the
 * role it had and the grants attached to it -- and re-enables the
 * Cognito login. That is worth saying out loud here, because the
 * alternative reading ("I will have to set them up from scratch") is
 * what makes an admin hesitate over a reversible action.
 *
 * The refusals are re-checked here rather than only disabling the button
 * upstream, so the reason is visible at the point of decision. The
 * server checks them again under a row lock, which is the version that
 * is actually safe.
 */
export function UserRemoveDialog({
  user,
  onClose,
}: {
  user: ManagedUser | null;
  onClose: () => void;
}) {
  const { users, actorEmail, remove } = useAdmin();
  if (!user) return null;

  const refusal = removalRefusal(user, actorEmail, users);
  const name = user.displayName ?? user.email;

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={refusal ? `Cannot remove ${name}` : `Remove ${name}?`}
      description={
        refusal
          ? 'This one is blocked on purpose.'
          : 'This removes their access, not their history.'
      }
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {refusal ? 'Close' : 'Cancel'}
          </Button>
          {!refusal && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                remove(user);
                onClose();
              }}
            >
              Remove user
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
        ) : (
          <>
            <p>
              <code className="font-mono">{user.email}</code> loses access immediately. The API
              refuses them from the next request, even on a session they already have open, and
              their sign-in is disabled so Cognito stops sending them a code.
            </p>

            <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2.5">
              <p className="font-medium">What is kept</p>
              <p className="text-muted-foreground">
                Their user record, their grants, and every audit entry naming them. Nothing here
                erases a person&rsquo;s history, and there is no control on this screen that does.
                Keeping the grants is deliberate — &ldquo;what could they see before they
                left&rdquo; stays answerable.
              </p>
            </div>

            <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2.5">
              <p className="font-medium">It can be undone</p>
              <p className="text-muted-foreground">
                Inviting <code className="font-mono">{user.email}</code> again revives this same
                record, re-enables their login, and their previous grants apply again. Their role
                comes back too — so if they were a superadmin, they return as one.
              </p>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
