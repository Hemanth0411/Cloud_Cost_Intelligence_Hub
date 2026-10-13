'use client';

import { Check, Loader2, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ConnectionField,
  FailureNotice,
  ModeRecommendation,
  ProfileModeNotice,
  REGISTER_MODES,
  StoredKeyNotice,
} from '@/components/accounts/connection-form';
import { CrossAccountHandoff } from '@/components/accounts/cross-account-handoff';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { ApiError } from '@/lib/api/client';
import {
  costReaderArn,
  newExternalId,
  validateRegistration,
  type CredentialMode,
  type RegistrationDraft,
} from '@/lib/aws-onboarding';
import {
  CONNECTION_CAPABILITIES,
  registerConnection,
  type ConnectionRow,
} from '@/lib/services/connection-service';
import { cn } from '@/lib/utils';

/**
 * Register a cloud account -- for real, in live mode.
 *
 * WHAT THIS SCREEN IS ACTUALLY FOR. Adding a second AWS account is not
 * something this application can do by itself: it needs an IAM role
 * created in an account we do not own and cannot reach. So the dialog
 * has two jobs, and the second is the one that unblocks anybody:
 *
 *   1. write the `cloud_connections` row (POST /admin/connections), and
 *   2. produce the exact instructions the OTHER account's administrator
 *      has to follow, copy-pasteably, because that is the real blocker.
 *
 * THE RECOMMENDED MODE TYPES NO CREDENTIAL, and that is still the
 * default. An AssumeRole connection is a role ARN plus an ExternalId,
 * and neither is a password:
 *
 *   * the role ARN is DERIVED, not entered. `terraform/iam.tf` grants
 *     `sts:AssumeRole` on `arn:aws:iam::*:role/CostHubCostReader` by
 *     name, so a role called anything else is unreachable and letting
 *     someone type an arbitrary ARN would only produce connections that
 *     fail at ingest time with AccessDenied. (The EDIT dialog does let
 *     you type one, because a row can already hold a wrong ARN and the
 *     point of editing is to fix it -- it warns when the value is not
 *     the derived one.)
 *   * the ExternalId is GENERATED here and is not a secret the user
 *     invents on the spot -- it is a shared unguessable string the
 *     target account's trust policy will require us to present.
 *
 * ONE MODE DOES TAKE A REAL CREDENTIAL, and this file used to say in
 * writing that none ever would. `secret` takes an access key id and a
 * secret access key, because the gap that left was not theoretical: an
 * account whose owner already has a key with Cost Explorer access and
 * nobody who will create a role for them had no usable option at all --
 * `profile` cannot run in Lambda, so its data only ever moved when
 * somebody ran the CLI by hand. The key is POSTed once, written to
 * Secrets Manager by the API, and the row stores only the ARN; nothing
 * reads it back, so there is no field for it in the edit dialog, only a
 * replacement. `MODE_RECOMMENDATION` is on screen under the control so
 * the two AWS options are not presented as equivalent.
 *
 * THE LAST MODE IS LOCAL-ONLY AND SAYS SO. `profile` reads a named AWS
 * CLI profile through `boto3.Session(profile_name=...)`, which means
 * `~/.aws/config` on the machine making the call -- and there is no such
 * file in Lambda, where both the 06:00 UTC schedule and this screen's
 * Test and Import now all run. A profile connection therefore fails
 * every morning by construction. It is offered because running the CLI
 * by hand is a real workflow, and `ProfileModeNotice` is on screen the
 * moment the mode is selected so that nobody registers one expecting it
 * to behave like AssumeRole.
 *
 * MOCK MODE STAYS A SIMULATION, with the step animation, and the
 * notice says nothing was sent. The demo's "reconnect this account"
 * flow on /accounts is a DIFFERENT dialog (`reconnect-dialog.tsx`):
 * the mock estate's ids are dashed AWS numbers and Azure GUIDs, which
 * no registration form should accept.
 *
 * ON SUCCESS IT DOES NOT JUST CLOSE. It used to be true that the
 * ExternalId existed in exactly one place -- this component's memo --
 * because the API returned the string "set" for it; that is no longer
 * so, and the connections table shows the real value. The handoff step
 * stays anyway, for a better reason: a registered connection cannot
 * import anything until someone else creates a role, and closing
 * straight out of `.then()` reported success for a connection that was
 * not yet going to work.
 */

const STEPS = ['Validating permissions', 'Importing cost data', 'Finishing setup'] as const;
const STEP_MS = 650;

interface ConnectDialogProps {
  open: boolean;
  onClose: () => void;
  /** Already-registered rows, so a duplicate account id can be named. */
  existing: readonly ConnectionRow[];
  /** Called after a successful write (or a completed simulation). */
  onRegistered?: () => void;
}

export function ConnectDialog({ open, onClose, existing, onRegistered }: ConnectDialogProps) {
  const simulated = CONNECTION_CAPABILITIES.simulated;

  const [mode, setMode] = useState<CredentialMode>('assume_role');
  const [accountId, setAccountId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [profileName, setProfileName] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [step, setStep] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  /** Set once a live registration has written the row. */
  const [registered, setRegistered] = useState(false);
  const timers = useRef<number[]>([]);

  /**
   * One ExternalId per opening of the dialog.
   *
   * Regenerating it on every keystroke would invalidate a trust policy
   * the user may already have copied and sent; regenerating it never
   * would reuse one value across different target accounts. Keyed on
   * `open` is exactly the lifetime that matters.
   *
   * `newExternalId` answers null when neither `crypto.randomUUID` nor
   * `getRandomValues` is available (it has no `Math.random` fallback, on
   * purpose). That becomes `''`, which `validateRegistration` refuses to
   * submit rather than letting a predictable value be stored.
   */
  const externalId = useMemo(() => (open ? newExternalId() ?? '' : ''), [open]);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((t) => window.clearTimeout(t));
  }, []);

  const draft: RegistrationDraft = {
    credentialMode: mode,
    accountId,
    displayName,
    externalId,
    profileName,
    accessKeyId,
    secretAccessKey,
  };
  const working = saving || step !== null;
  const crossAccount = mode === 'assume_role';
  const localProfile = mode === 'profile';
  const storedKey = mode === 'secret';
  const targetId = mode === 'self' ? 'self' : accountId.trim();
  const duplicate =
    targetId !== '' && existing.some((c) => c.provider === 'aws' && c.accountId === targetId);

  function fail(message: string): void {
    setFailure(message);
    setSaving(false);
    setStep(null);
  }

  /** Mock mode only: nothing was written, so there is nothing to keep. */
  function finishSimulated(): void {
    onRegistered?.();
    onClose();
  }

  /**
   * Live mode: hold the dialog open on the handoff.
   *
   * `onRegistered` fires now so the table behind refreshes and the new
   * row is already there when the user dismisses this.
   */
  function finishLive(): void {
    setSaving(false);
    setRegistered(true);
    // Drop the key from component state the moment it is no longer
    // needed. The request has been made and nothing can read it back, so
    // keeping it would only widen the window in which it sits in a
    // React tree -- and the success panel must not be able to show it.
    setSecretAccessKey('');
    onRegistered?.();
  }

  function submit(): void {
    const found = validateRegistration(draft);
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length > 0) return;

    if (simulated) {
      // The demo path: nothing is sent. `registerConnection` returns
      // without a request in mock mode, so the animation is the whole
      // behaviour and the notice above says so.
      setStep(0);
      STEPS.forEach((_, i) => {
        timers.current.push(window.setTimeout(() => setStep(i + 1), (i + 1) * STEP_MS));
      });
      timers.current.push(window.setTimeout(finishSimulated, STEPS.length * STEP_MS + 250));
      return;
    }

    setSaving(true);
    registerConnection(draft, existing)
      .then(finishLive)
      .catch((cause: unknown) => {
        // A readable sentence, never a raw object. ApiError already
        // carries FastAPI's `detail`; the 403 is worth naming because
        // these endpoints are superadmin-only and the UI cannot know
        // the caller's role for certain.
        const error = cause instanceof Error ? cause : new Error(String(cause));
        fail(
          error instanceof ApiError && error.forbidden
            ? 'Registering a cloud account is restricted to superadmins, and this account is not one. Nothing was created.'
            : error.message || 'The account could not be registered.',
        );
      });
  }

  const roleArn = crossAccount && targetId !== '' ? costReaderArn(targetId) : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && !working && onClose()}
      title={registered ? 'Registered — now send this on' : 'Add a cloud account'}
      description={
        registered
          ? crossAccount
            ? 'The connection row exists. It cannot import anything until the role below is created in the target account.'
            : localProfile
              ? 'The connection row exists. It will only ever import when someone runs the ingest by hand on a machine that has this profile.'
              : storedKey
                ? 'The connection row exists and the key is in Secrets Manager. Nothing further is needed — test it below.'
                : 'The connection row exists and is read with CostHub’s own execution role.'
          : simulated
            ? 'Simulated: nothing is sent and no row is written.'
            : 'Writes a connection row. Cost data arrives on the next scheduled import.'
      }
      className="sm:max-w-2xl"
      footer={
        registered ? (
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        ) : (
        <>
          <Button variant="outline" size="sm" disabled={working} onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={working} onClick={submit}>
            {working && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            {working
              ? simulated
                ? 'Connecting…'
                : 'Registering…'
              : duplicate
                ? 'Update this account'
                : 'Register account'}
          </Button>
        </>
        )
      }
    >
      <div className="space-y-4">
        {registered ? (
          <>
            <p className="rounded-md border border-success/40 bg-success/10 px-3 py-2.5 text-xs">
              <strong className="font-medium">{displayName.trim()}</strong> is registered as{' '}
              <code className="font-mono">{targetId}</code>. Imports run on a schedule, so the first
              one will appear under &ldquo;Recent imports&rdquo; after the next run.
            </p>
            {crossAccount ? (
              <CrossAccountHandoff accountId={targetId} externalId={externalId} />
            ) : localProfile ? (
              <ProfileModeNotice profileName={profileName} />
            ) : storedKey ? (
              /* The key is already out of component state by now
                 (`finishLive`), so there is nothing here that could
                 print it even by accident. What is worth saying is
                 where it went and that this screen will not show it
                 again. */
              <p className="text-xs text-muted-foreground">
                The access key was written to AWS Secrets Manager and this connection stores only
                its ARN. It is not shown again anywhere in CostHub &mdash; to change it, open Edit
                and type a new one over it. The first import will run on the 06:00 UTC schedule,
                or use &ldquo;Import now&rdquo; to run one immediately.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Nothing further is needed: the deploy account is read with CostHub&apos;s own
                execution role.
              </p>
            )}
          </>
        ) : (
          <>
        {simulated && (
          <p className="rounded-md border border-dashed bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
            Mock mode. The values are checked for format only — no credential is stored, no row is
            written and no cloud API is called. Switch to live data on Settings to register for real.
          </p>
        )}

        {step !== null ? (
          <ol className="space-y-2.5" aria-live="polite" aria-label="Connection progress">
            {STEPS.map((label, i) => {
              const done = (step ?? 0) > i;
              const current = step === i;
              return (
                <li
                  key={label}
                  className={cn(
                    'flex items-center gap-2.5 text-sm',
                    !done && !current && 'text-muted-foreground/60',
                  )}
                >
                  {done ? (
                    <Check className="h-4 w-4 text-success" aria-hidden />
                  ) : current ? (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden />
                  ) : (
                    <span className="h-4 w-4 rounded-full border" aria-hidden />
                  )}
                  {label}
                </li>
              );
            })}
          </ol>
        ) : (
          <>
            <div className="space-y-2">
              <p className="text-xs font-medium">What is being added</p>
              <SegmentedControl
                options={REGISTER_MODES}
                value={mode}
                onChange={setMode}
                ariaLabel="Credential mode"
              />
              <p className="text-xs text-muted-foreground">
                {crossAccount
                  ? 'CostHub will call sts:AssumeRole into that account. No key is held by either side.'
                  : localProfile
                    ? 'Credentials come from a named profile in ~/.aws/config on whichever machine makes the call.'
                    : storedKey
                      ? 'An access key you already hold, kept in AWS Secrets Manager and read at import time. Works on the schedule, unlike a local profile.'
                      : "Read with CostHub's own execution role. Nothing to configure, and nothing for anyone else to do."}
              </p>
              {/* Under the control, not inside it: a segmented control
                  makes everything in it look equally advisable, and
                  these two are not. */}
              {(crossAccount || storedKey) && <ModeRecommendation />}
            </div>

            {localProfile && <ProfileModeNotice profileName={profileName} />}
            {storedKey && <StoredKeyNotice />}

            <ConnectionField
              id="conn-name"
              label="Name"
              value={displayName}
              onChange={setDisplayName}
              error={errors.displayName}
              placeholder="Finance-AWS"
              required
              hint="How the account is labelled in CostHub. Only a label — it changes nothing about access."
            />

            {mode !== 'self' && (
              <ConnectionField
                id="conn-account"
                label="AWS account id"
                value={accountId}
                onChange={setAccountId}
                error={errors.accountId}
                placeholder="123456789012"
                inputMode="numeric"
                required
                hint={
                  localProfile
                    ? 'The 12-digit id of the account this profile reads. Imported rows are filed under it, and it cannot be changed afterwards.'
                    : 'The 12-digit id of the account whose cost data you want.'
                }
              />
            )}

            {storedKey && (
              <>
                <ConnectionField
                  id="conn-access-key-id"
                  label="Access key id"
                  value={accessKeyId}
                  onChange={setAccessKeyId}
                  error={errors.accessKeyId}
                  placeholder="AKIA…"
                  required
                  mono
                  hint="From IAM, for a user with ce:GetCostAndUsage and ce:GetDimensionValues in that account."
                />
                <ConnectionField
                  id="conn-secret-access-key"
                  label="Secret access key"
                  value={secretAccessKey}
                  onChange={setSecretAccessKey}
                  error={errors.secretAccessKey}
                  placeholder="Shown once by IAM when the key is created"
                  required
                  mono
                  secret
                  hint="Sent once, to Secrets Manager. It is never stored in the database, never written to the audit log, and no endpoint returns it."
                />
              </>
            )}

            {localProfile && (
              <ConnectionField
                id="conn-profile"
                label="AWS CLI profile name"
                value={profileName}
                onChange={setProfileName}
                error={errors.profileName}
                placeholder="costhub"
                required
                mono
                hint="As it appears in ~/.aws/config — the name after [profile …]. Stored as typed; nothing here can verify it exists."
              />
            )}

            {duplicate && (
              <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
                <span>
                  <strong className="font-medium">{targetId}</strong> is already registered.
                  Submitting replaces it rather than adding a second row.{' '}
                  {crossAccount
                    ? 'That includes issuing a new ExternalId, which breaks the existing trust policy until the one below is applied in the target account.'
                    : localProfile
                      ? 'Its credential mode, role ARN and ExternalId are all overwritten with this form’s values, so an AssumeRole connection on this id would become a local-profile one.'
                      : storedKey
                        ? 'The key below REPLACES whatever is stored for this account — there is one secret per account id, so the previous key stops being used and is not kept.'
                        : 'The deploy account holds no ExternalId, so only its name changes.'}{' '}
                  Imported cost rows are not affected. A disabled connection is re-enabled, and a
                  removed one comes back — registering an account id is how you undo removing it.
                  To correct a connection without replacing its credentials, use Edit instead.
                </span>
              </p>
            )}

            {crossAccount && <CrossAccountHandoff accountId={targetId} externalId={externalId} />}

            {errors.externalId && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {errors.externalId}
              </p>
            )}

            {failure !== null && <FailureNotice message={failure} />}

            {roleArn !== null && (
              <p className="text-[11px] text-muted-foreground">
                Will be stored as{' '}
                <code className="font-mono">{roleArn}</code>
                {simulated ? ' — in a real connection.' : '.'}
              </p>
            )}
          </>
        )}
          </>
        )}
      </div>
    </Dialog>
  );
}
