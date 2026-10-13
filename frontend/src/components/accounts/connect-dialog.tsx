'use client';

import { Check, Info, Loader2, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog } from '@/components/ui/dialog';
import { fieldA11y, FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import {
  ACCOUNT_PREREQUISITES,
  COST_READER_ROLE_NAME,
  DEPLOY_ACCOUNT_KNOWN,
  rootPathNote,
  costReaderArn,
  deployAccountLabel,
  handoffText,
  newExternalId,
  permissionsPolicyJson,
  trustPolicyJson,
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
 * NO CREDENTIAL IS EVER TYPED HERE. There is no field for one, by
 * design. An AssumeRole connection is a role ARN plus an ExternalId,
 * and neither is a password:
 *
 *   * the role ARN is DERIVED, not entered. `terraform/iam.tf` grants
 *     `sts:AssumeRole` on `arn:aws:iam::*:role/CostHubCostReader` by
 *     name, so a role called anything else is unreachable and letting
 *     someone type an arbitrary ARN would only produce connections that
 *     fail at ingest time with AccessDenied.
 *   * the ExternalId is GENERATED here and remains readable. Not a secret
 *     the user invents on the spot -- it is a shared unguessable string
 *     the target account's trust policy will require us to present.
 *     `GET /admin/connections` redacts it to the string `"set"`, so
 *     this dialog is the only place it is ever visible and the UI says
 *     so rather than letting someone discover it later.
 *
 * MOCK MODE STAYS A SIMULATION, with the step animation, and the
 * notice says nothing was sent. The demo's "reconnect this account"
 * flow on /accounts is a DIFFERENT dialog (`reconnect-dialog.tsx`):
 * the mock estate's ids are dashed AWS numbers and Azure GUIDs, which
 * no registration form should accept.
 *
 * ON SUCCESS IT DOES NOT JUST CLOSE. The ExternalId exists in exactly
 * one place -- this component's memo -- and `GET /admin/connections`
 * returns it as the string "set" forever after. Closing straight out
 * of `.then()` threw it away for anyone who had not already pressed
 * Copy, and the only recovery is re-registering, which rotates it
 * again and invalidates any trust policy already applied. So a live
 * registration ends on a handoff step the user dismisses deliberately.
 */

const STEPS = ['Validating permissions', 'Importing cost data', 'Finishing setup'] as const;
const STEP_MS = 650;

const MODES: readonly { value: CredentialMode; label: string; title: string }[] = [
  {
    value: 'assume_role',
    label: 'Another AWS account',
    title: 'Short-lived credentials via STS. Needs a role created in that account.',
  },
  {
    value: 'self',
    label: 'This account',
    title: "The account CostHub runs in, read with the application's own role. Nothing to configure.",
  },
];

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
  };
  const working = saving || step !== null;
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

  const crossAccount = mode === 'assume_role';
  const roleArn = crossAccount && targetId !== '' ? costReaderArn(targetId) : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && !working && onClose()}
      title={registered ? 'Registered — now send this on' : 'Add a cloud account'}
      description={
        registered
          ? 'The connection row exists. It cannot import anything until the role below is created in the target account.'
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
                    <Loader2 className="h-4 w-4 animate-spin text-ateneo" aria-hidden />
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
                options={MODES}
                value={mode}
                onChange={setMode}
                ariaLabel="Credential mode"
              />
              <p className="text-xs text-muted-foreground">
                {crossAccount
                  ? 'CostHub will call sts:AssumeRole into that account. No key is held by either side.'
                  : "Read with CostHub's own execution role. Nothing to configure, and nothing for anyone else to do."}
              </p>
            </div>

            <FormField
              id="conn-name"
              label="Name"
              error={errors.displayName}
              hint="How the account is labelled in CostHub. Only a label — it changes nothing about access."
            >
              <Input
                id="conn-name"
                value={displayName}
                placeholder="Finance-AWS"
                autoComplete="off"
                onChange={(e) => setDisplayName(e.target.value)}
                {...fieldA11y('conn-name', errors.displayName, true)}
              />
            </FormField>

            {crossAccount && (
              <FormField
                id="conn-account"
                label="AWS account id"
                error={errors.accountId}
                hint="The 12-digit id of the account whose cost data you want."
              >
                <Input
                  id="conn-account"
                  value={accountId}
                  placeholder="123456789012"
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setAccountId(e.target.value)}
                  {...fieldA11y('conn-account', errors.accountId, true)}
                />
              </FormField>
            )}

            {duplicate && (
              <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
                <span>
                  <strong className="font-medium">{targetId}</strong> is already registered.
                  Submitting replaces it rather than adding a second row.{' '}
                  {crossAccount
                    ? 'That includes issuing a new ExternalId, which breaks the existing trust policy until the one below is applied in the target account.'
                    : 'The deploy account holds no ExternalId, so only its name changes.'}{' '}
                  Imported cost rows are not affected, and a disabled connection stays disabled.
                </span>
              </p>
            )}

            {crossAccount && <CrossAccountHandoff accountId={targetId} externalId={externalId} />}

            {errors.externalId && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {errors.externalId}
              </p>
            )}

            {failure !== null && (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive"
              >
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>{failure}</span>
              </p>
            )}

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

/**
 * The half of the job that happens in someone else's account.
 *
 * Rendered as copyable text rather than described in prose, because its
 * entire purpose is to be sent to another team. The ExternalId appears
 * here and nowhere else, ever -- see the note at the top of the file.
 */
function CrossAccountHandoff({
  accountId,
  externalId,
}: {
  accountId: string;
  externalId: string;
}) {
  const target = accountId === '' ? '<ACCOUNT_ID>' : accountId;
  const permissions = permissionsPolicyJson();
  const trust = trustPolicyJson(externalId);

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
            What the other account&apos;s administrator must do
          </p>
          <p className="text-xs text-muted-foreground">
            Send them this. CostHub cannot create anything in an account it does not own, so until
            the role exists the connection will be registered but imports will fail with
            AccessDenied.
          </p>
        </div>
        {externalId !== '' && (
          <CopyButton value={handoffText(target, externalId)} label="Copy all" />
        )}
      </div>

      <dl className="space-y-1.5 text-xs">
        <Pair term="Role name" value={COST_READER_ROLE_NAME} note="exactly this name" />
        <Pair term="Role ARN" value={costReaderArn(target)} />
        <Pair term="Trusts account" value={deployAccountLabel()} />
        <Pair term="ExternalId" value={externalId || 'could not be generated'} />
      </dl>

      <p className="text-[11px] text-muted-foreground">{rootPathNote(target)}</p>

      {/* These two are not IAM and are easy to leave out of a relayed
          message, but a perfectly correct role still returns
          AccessDenied on every cost API without the first one. They
          were in the copied text only; now they are on screen too. */}
      <div className="space-y-1">
        <p className="text-xs font-medium">Also required in that account, once</p>
        <ol className="list-decimal space-y-1 pl-4 text-[11px] text-muted-foreground">
          {ACCOUNT_PREREQUISITES.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      </div>

      {externalId !== '' && (
        <p className="flex items-start gap-2 rounded border border-warning/40 bg-warning/10 px-2.5 py-2 text-[11px]">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
          <span>
            Send this ExternalId to the other account&rsquo;s administrator &mdash; their trust
            policy has to contain this exact value. It stays readable on the Cloud accounts
            screen, so you can look it up again rather than re-registering the account.
          </span>
        </p>
      )}

      {!DEPLOY_ACCOUNT_KNOWN && (
        <p className="text-[11px] text-warning">
          <code className="font-mono">NEXT_PUBLIC_DEPLOY_ACCOUNT_ID</code> is not set in this build,
          so the trust policy below carries a placeholder instead of this stack&apos;s account id.
          Replace it before sending. Run <code className="font-mono">./do.sh outputs dev</code> for
          local dev, or set the variable in the Amplify console for the deployed site.
        </p>
      )}

      <PolicyBlock title="Permissions policy" json={permissions} />
      <PolicyBlock title="Trust policy" json={trust} />

      <p className="text-[11px] text-muted-foreground">
        Nothing is needed on this side: the CostHub execution role is already permitted to assume a
        role named <code className="font-mono">{COST_READER_ROLE_NAME}</code> in{' '}
        <strong className="font-medium">any</strong> AWS account, so no Terraform change and no
        redeploy is involved in adding an account.
      </p>
    </div>
  );
}

function Pair({ term, value, note }: { term: string; value: string; note?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-28 shrink-0 text-muted-foreground">{term}</dt>
      <dd className="min-w-0 flex-1 break-all font-mono">{value}</dd>
      {note && <span className="shrink-0 text-[10px] text-muted-foreground">{note}</span>}
    </div>
  );
}

function PolicyBlock({ title, json }: { title: string; json: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium">{title}</p>
        <CopyButton value={json} />
      </div>
      <pre className="max-h-44 overflow-auto rounded border bg-card p-2.5 font-mono text-[11px] leading-relaxed">
        {json}
      </pre>
    </div>
  );
}
