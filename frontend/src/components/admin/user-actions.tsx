'use client';

import { useAdmin } from '@/components/admin/admin-context';
import { Button } from '@/components/ui/button';
import { demotionRefusal, removalRefusal } from '@/lib/services/admin-service';
import type { ManagedUser } from '@/types/domain';

/**
 * The per-row controls on the users table.
 *
 * Lifted out of users-view so the table markup stays readable, and
 * because the two destructive controls need the same question answered
 * for both of them: would this be refused, and if so why?
 *
 * A REFUSED CONTROL IS SHOWN DISABLED, NOT HIDDEN. Hiding "Remove" on
 * your own row makes the screen look inconsistent and teaches nothing;
 * a disabled button with the reason on hover says the rule exists and
 * what it is. The dialogs repeat the reason at full length, for anyone
 * who clicks through a keyboard focus rather than hovering.
 *
 * The buttons are labelled with the DIRECTION rather than the state --
 * "Make superadmin" / "Revoke superadmin", not a toggle -- because a
 * toggle on a privilege change reads as reversible housekeeping and this
 * is neither.
 */
export function UserActions({
  user,
  onGrant,
  onChangeRole,
  onRemove,
}: {
  user: ManagedUser;
  onGrant: () => void;
  onChangeRole: () => void;
  onRemove: () => void;
}) {
  const { users, actorEmail, can, disable, enable } = useAdmin();

  const cannotRemove = removalRefusal(user, actorEmail, users);
  const cannotDemote = demotionRefusal(user, actorEmail, users);
  const promoting = user.role !== 'superadmin';
  const roleBlocked = promoting ? null : cannotDemote;

  return (
    <div className="flex flex-wrap justify-end gap-1">
      <Button variant="outline" size="sm" onClick={onGrant}>
        Grant
      </Button>

      <Button
        variant="ghost"
        size="sm"
        onClick={onChangeRole}
        disabled={roleBlocked !== null}
        title={roleBlocked ?? undefined}
      >
        {promoting ? 'Make superadmin' : 'Revoke superadmin'}
      </Button>

      {/* No endpoint enables or disables a user, so in live mode the
          control is absent rather than present and broken. Separate from
          Remove on purpose: disable is a pause, removal is a soft delete
          that also disables their sign-in. See CAPABILITIES. */}
      {can.canSetUserStatus &&
        (user.status === 'disabled' ? (
          <Button variant="ghost" size="sm" onClick={() => enable(user.id)}>
            Enable
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => disable(user.id)}>
            Disable
          </Button>
        ))}

      <Button
        variant="ghost"
        size="sm"
        onClick={onRemove}
        disabled={cannotRemove !== null}
        title={cannotRemove ?? undefined}
        className="text-destructive hover:text-destructive"
      >
        Remove
      </Button>
    </div>
  );
}
