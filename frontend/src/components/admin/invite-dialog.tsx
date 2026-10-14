'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAdmin } from '@/components/admin/admin-context';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
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

/**
 * Invite a user, and tell the truth about what that does and does not do.
 *
 * THIS BUTTON USED TO SAY "SEND INVITE", AND NOTHING WAS SENT.
 * `rbac/pool.create_user` passes `MessageAction="SUPPRESS"` on purpose:
 * Cognito's invitation email exists to deliver a temporary password, and
 * this pool is EMAIL_OTP only, so there is no password to deliver and
 * the invitation would name a credential the user does not have. The
 * suppression is right; the label was not. An admin pressed it, was told
 * an invite had been sent, and the colleague waited for an email that
 * was never going to arrive.
 *
 * SO THE CONFIRMATION IS THE FEATURE, not decoration. After a successful
 * invite this dialog stays open and says plainly that no email went out,
 * hands over the URL to pass on, and makes it copyable — because the
 * admin is now the delivery mechanism and a toast cannot carry a URL you
 * have to paste into a message.
 *
 * AND IT IS PRECISE ABOUT WHICH EMAIL DOES NOT ARRIVE. Mail is not
 * broken here: SES has production access and Cognito is wired to a
 * verified sender, so the one-time code at SIGN-IN is delivered
 * normally. Only the invite is silent. Saying "email is disabled" would
 * be a different falsehood, and would send someone to debug a working
 * SES configuration.
 */
export function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { invite, can } = useAdmin();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('user');
  /** A validation problem with the address, shown under the field. */
  const [error, setError] = useState<string>();
  /**
   * A problem with the WRITE, shown as a notice.
   *
   * Separate from `error` because the two are not the same kind of
   * thing: "only @chryselys.com addresses" belongs under the input, and
   * "the pool rejected it -- nothing was created" is about the request,
   * not the field. Rendering a server failure as a field error made it
   * look like the admin had mistyped something.
   */
  const [failure, setFailure] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  /** Set once an invite has landed: the email it was for, and where to send them. */
  const [invited, setInvited] = useState<{ email: string; signInUrl: string } | null>(null);

  useEffect(() => {
    if (open) {
      setEmail('');
      setDisplayName('');
      setRole('user');
      setError(undefined);
      setFailure(null);
      setWorking(false);
      setInvited(null);
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

    // `role` is only sent in mock mode. POST /admin/users takes email
    // and display_name; every invited user lands as 'user'. The role is
    // changeable afterwards from the users table in both modes, which is
    // why offering the choice HERE would still be a control that does
    // nothing -- see CAPABILITIES.canSetRoleAtInvite.
    setWorking(true);
    setError(undefined);
    setFailure(null);
    invite(can.canSetRoleAtInvite ? { email: value, displayName, role } : { email: value, displayName })
      .then(() =>
        setInvited({
          email: value,
          // The origin the admin is on, not a configured value: it is by
          // definition a URL that reaches this deployment, since they
          // are reading this page from it.
          signInUrl: `${window.location.origin}/login`,
        }),
      )
      .catch((cause: unknown) => {
        setFailure(
          cause instanceof Error ? cause.message : 'The invite did not go through.',
        );
      })
      .finally(() => setWorking(false));
  }

  if (invited) {
    return (
      <Dialog
        open={open}
        onOpenChange={(next) => !next && onClose()}
        title={`${invited.email} can now sign in`}
        description="Nothing was emailed to them. Passing the link on is your job."
        footer={
          <>
            <Button variant="ghost" onClick={() => setInvited(null)}>
              Invite someone else
            </Button>
            <Button onClick={onClose}>Done</Button>
          </>
        }
      >
        <div className="space-y-3 text-xs">
          <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2.5">
            <p className="font-medium">No email was sent</p>
            <p className="text-muted-foreground">
              There is no invitation email in this system. Cognito&rsquo;s invitation exists to
              deliver a temporary password, and sign-in here is a one-time code instead — so there
              is nothing for it to say, and it is deliberately suppressed.
            </p>
          </div>

          <div className="space-y-2">
            <p className="font-medium">Send them this, however you normally would</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border bg-background px-2 py-1.5 font-mono">
                {invited.signInUrl}
              </code>
              <CopyButton value={invited.signInUrl} label="Copy link" />
            </div>
            <p className="text-muted-foreground">
              They enter <code className="font-mono">{invited.email}</code> there and ask for a
              code. <strong className="font-medium">That</strong> email does arrive — the one-time
              code is sent normally. It is only the invite that is silent.
            </p>
          </div>

          <p className="rounded-md bg-muted/50 px-3 py-2 text-muted-foreground">
            They have no access to any cost data yet. Until you grant them an account they will
            sign in to an empty dashboard, which is the intended behaviour and not a failure.
          </p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && !working && onClose()}
      title="Invite a user"
      description="Creates their account. Nothing is emailed — you pass them the link yourself."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={working}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={working}>
            {working && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden />}
            {working ? 'Creating…' : 'Create user'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* The domain rule, BEFORE the attempt rather than as a failure.
            The Cognito pre-sign-up trigger rejects anything else, so an
            outside address cannot be invited at all -- finding that out
            from an error message makes it look like a fault. */}
        <p className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Only <code className="font-mono">@{ALLOWED_DOMAIN}</code> addresses can be invited.
          Anything else is refused by the identity provider before an account is created.
        </p>

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
              setFailure(null);
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

        {can.canSetRoleAtInvite && (
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
        )}

        {failure !== null && (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            Nobody was created. {failure}
          </p>
        )}

        <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          An invite grants no access by itself. Until you give them an account, they can sign in and
          will see an empty dashboard — which is the intended behaviour, not a failure.
        </p>
      </div>
    </Dialog>
  );
}
