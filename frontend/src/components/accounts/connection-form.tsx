'use client';

import { KeyRound, TerminalSquare, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { fieldA11y, FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import type { SegmentedOption } from '@/components/ui/segmented-control';
import {
  MODE_RECOMMENDATION,
  PROFILE_MODE_LIMITS,
  STORED_KEY_LIMITS,
  type CredentialMode,
  type StoredCredentialMode,
} from '@/lib/aws-onboarding';

/**
 * The pieces the add dialog and the edit dialog both use.
 *
 * There are two forms over one table -- `connect-dialog.tsx` writes a
 * `cloud_connections` row and `connection-edit-dialog.tsx` corrects one
 * -- and they must not drift. A second hand-built field layout is how
 * one of them ends up with a different hint, a different placeholder, or
 * no `aria-describedby`; a second copy of the profile-mode warning is
 * how one of them ends up still claiming something that was corrected in
 * the other.
 *
 * So the label/control/hint/error layout, the credential-mode options
 * and the profile-mode warning live here, and both dialogs import them.
 */

/** label + control + hint/error, wired for screen readers. */
export function ConnectionField({
  id,
  label,
  hint,
  error,
  value,
  onChange,
  placeholder,
  required = false,
  mono = false,
  inputMode,
  after,
  secret = false,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Announced by screen readers. These forms are not inside a <form>,
      so the native `required` attribute would do nothing. */
  required?: boolean;
  /** For ARNs and ids, which are read character by character. */
  mono?: boolean;
  inputMode?: 'numeric' | 'text';
  /** A control that belongs with the field -- "Use the derived ARN". */
  after?: ReactNode;
  /**
   * The one field on these forms that holds a credential: masked, and
   * `new-password` rather than `off` so a browser does not offer to
   * remember it. `off` is widely ignored for password inputs; this is
   * the value that is actually honoured.
   */
  secret?: boolean;
}) {
  return (
    <FormField id={id} label={label} error={error} hint={hint}>
      <Input
        id={id}
        type={secret ? 'password' : undefined}
        value={value}
        placeholder={placeholder}
        inputMode={inputMode}
        autoComplete={secret ? 'new-password' : 'off'}
        spellCheck={false}
        className={mono ? 'font-mono text-xs' : undefined}
        aria-required={required || undefined}
        onChange={(e) => onChange(e.target.value)}
        {...fieldA11y(id, error, hint !== undefined)}
      />
      {after}
    </FormField>
  );
}

/**
 * The modes a browser may REGISTER, IN THE ORDER THEY SHOULD BE TRIED,
 * which is the only thing stopping this control from presenting four
 * equivalent choices.
 *
 * `assume_role` is first because it is the right answer: hour-long
 * credentials, nothing stored. `secret` is third because it works
 * everywhere AssumeRole does -- including on the 06:00 schedule -- but
 * at the cost of a long-lived key somebody has to look after.
 * `profile` is last, and its label says "local" rather than naming a
 * cloud, because it is the only one of the four that cannot work on the
 * schedule at all.
 *
 * Order alone does not say which is recommended, so `MODE_RECOMMENDATION`
 * is rendered under the control and both dialogs show it.
 */
export const REGISTER_MODES: readonly SegmentedOption<CredentialMode>[] = [
  {
    value: 'assume_role',
    label: 'Another AWS account',
    title: 'Short-lived credentials via STS. Needs a role created in that account.',
  },
  {
    value: 'self',
    label: 'This account',
    title:
      "The account CostHub runs in, read with the application's own role. Nothing to configure.",
  },
  {
    value: 'secret',
    label: 'Access key',
    title:
      'An IAM access key you already hold, kept in Secrets Manager. Works on the schedule, but it is long-lived -- prefer AssumeRole.',
  },
  {
    value: 'profile',
    label: 'Local CLI profile',
    title:
      'A named AWS CLI profile. Works only when the ingest is run by hand on a machine that has it -- never on the schedule.',
  },
];

/**
 * The modes the EDIT dialog offers for a given row.
 *
 * All four, now that AWS `secret` is implemented. It used to be the
 * three registerable ones plus `secret` only when the row already held
 * it, because switching an AWS row TO `secret` produced a connection
 * `aws_session` refused outright ("unsupported credential_mode for
 * AWS"). That is no longer true, so the restriction is gone and the
 * signature keeps its argument only so the caller does not have to
 * change.
 *
 * Switching INTO `secret` without supplying a key is refused by the API
 * (a row with no secret to resolve can never authenticate), and the
 * dialog warns before the save rather than blocking it -- the same way
 * it treats every other server-side rule.
 *
 * Kept as a function rather than collapsed into `REGISTER_MODES` at the
 * call site: it is the seam where a mode becomes conditional again, and
 * it returns copies so a caller cannot mutate the shared array.
 */
export function editModes(): readonly SegmentedOption<StoredCredentialMode>[] {
  return REGISTER_MODES.map((m) => ({ ...m }));
}

/**
 * What storing a key means, shown wherever one can be typed.
 *
 * The counterweight to how easy this mode is to pick, and worded only
 * from what the code does: the lines come from `STORED_KEY_LIMITS`, so
 * the add dialog and the edit dialog cannot end up claiming different
 * things about the same mode.
 */
export function StoredKeyNotice({ rotating = false }: { rotating?: boolean }) {
  return (
    <div className="space-y-2 rounded-md border border-warning/50 bg-warning/10 px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-xs font-semibold">
        <KeyRound className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
        {rotating
          ? 'Replacing the stored key — the old one stops working immediately'
          : 'A long-lived credential, stored on your behalf'}
      </p>
      <ul className="list-disc space-y-1 pl-4 text-[11px] text-muted-foreground">
        {STORED_KEY_LIMITS.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground">
        Give it the least it needs: <code className="font-mono">ce:GetCostAndUsage</code> and{' '}
        <code className="font-mono">ce:GetDimensionValues</code> are the two calls the import
        and the connection test actually make.
      </p>
    </div>
  );
}

/** One sentence on which mode this screen is recommending, and why. */
export function ModeRecommendation() {
  return <p className="text-xs text-muted-foreground">{MODE_RECOMMENDATION}</p>;
}

/**
 * What a `profile` connection cannot do.
 *
 * Shown whenever the mode is selected -- in the add dialog and in the
 * edit dialog -- and worded only from what this code can establish. Two
 * boundaries it stays inside:
 *
 *  * it does NOT say the profile works locally, because nothing here can
 *    see the machine that would run the CLI, or whether it has a profile
 *    by that name;
 *  * it does NOT state where the API is running. The browser holds a
 *    base URL and no more. The scheduled import is certain -- an
 *    EventBridge rule on a Lambda -- but the API's whereabouts are not,
 *    so that half is conditional on the deployment.
 */
export function ProfileModeNotice({ profileName }: { profileName?: string }) {
  const named = profileName?.trim();
  return (
    <div className="space-y-2 rounded-md border border-warning/50 bg-warning/10 px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-xs font-semibold">
        <TerminalSquare className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
        Local use only &mdash; this connection cannot import on its own
      </p>
      <ul className="list-disc space-y-1 pl-4 text-[11px] text-muted-foreground">
        {PROFILE_MODE_LIMITS.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground">
        {named
          ? `Nothing here can check whether a profile called "${named}" exists on any machine — the browser cannot read ~/.aws/config, and neither can the API. It is stored exactly as typed.`
          : 'Nothing here can check whether a profile exists on any machine — the browser cannot read ~/.aws/config, and neither can the API. It is stored exactly as typed.'}
      </p>
    </div>
  );
}

/** A failed write, as a sentence. Never a raw object. */
export function FailureNotice({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive"
    >
      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{message}</span>
    </p>
  );
}
