'use client';

import { useEffect, useState } from 'react';
import { useAdmin } from '@/components/admin/admin-context';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { fieldA11y, FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { Role } from '@/types/domain';

/**
 * The allowed domain, enforced in three places for real.
 *
 * This check is the convenience copy: the Cognito pre-sign-up trigger
 * rejects a non-permitted domain, and the API re-checks the token claim.
 * Doing it here as well only saves a round trip and a worse error.
 */
const ALLOWED_DOMAIN = 'chryselys.com';

export function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { invite } = useAdmin();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (open) {
      setEmail('');
      setDisplayName('');
      setRole('user');
      setError(undefined);
    }
  }, [open]);

  function submit(): void {
    const value = email.trim().toLowerCase();
    if (!value.includes('@')) {
      setError('Enter an email address.');
      return;
    }
    if (!value.endsWith(`@${ALLOWED_DOMAIN}`)) {
      setError(`Only @${ALLOWED_DOMAIN} addresses can be invited.`);
      return;
    }
    invite({ email: value, displayName, role });
    onClose();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="Invite a user"
      description="They sign in with a one-time code sent to this address. No password is ever set."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit}>Send invite</Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormField
          id="invite-email"
          label="Email address"
          error={error}
          hint={`Must be an @${ALLOWED_DOMAIN} address`}
        >
          <Input
            id="invite-email"
            type="email"
            value={email}
            placeholder={`someone@${ALLOWED_DOMAIN}`}
            onChange={(e) => {
              setEmail(e.target.value);
              setError(undefined);
            }}
            {...fieldA11y('invite-email', error, true)}
          />
        </FormField>

        <FormField id="invite-name" label="Display name" hint="Optional">
          <Input
            id="invite-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            {...fieldA11y('invite-name', undefined, true)}
          />
        </FormField>

        <FormField
          id="invite-role"
          label="Role"
          hint="Superadmins see every account and bypass grants — every bypass is written to the audit log."
        >
          <Select
            id="invite-role"
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            {...fieldA11y('invite-role', undefined, true)}
          >
            <option value="user">User — sees only what you grant</option>
            <option value="superadmin">Superadmin — sees everything</option>
          </Select>
        </FormField>

        <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          An invite grants no access by itself. Until you give them an account, they can sign in and
          will see an empty dashboard — which is the intended behaviour, not a failure.
        </p>
      </div>
    </Dialog>
  );
}
