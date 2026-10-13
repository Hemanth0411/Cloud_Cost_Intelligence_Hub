'use client';

import { TerminalSquare, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { fieldA11y, FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import type { SegmentedOption } from '@/components/ui/segmented-control';
import {
  CREDENTIAL_MODE_LABEL,
  CREDENTIAL_MODE_HINT,
  PROFILE_MODE_LIMITS,
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
}) {
  return (
    <FormField id={id} label={label} error={error} hint={hint}>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        inputMode={inputMode}
        autoComplete="off"
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
 * The modes a browser may REGISTER, in the order they should be tried.
 *
 * `secret` is not here: see the type's note in `lib/aws-onboarding.ts`.
 * `profile` is last, and its label says "local" rather than naming a
 * cloud, because it is the only one of the three that cannot work on the
 * schedule -- the segmented control is the first place someone decides,
 * so it is the first place that has to be honest about it.
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
    value: 'profile',
    label: 'Local CLI profile',
    title:
      'A named AWS CLI profile. Works only when the ingest is run by hand on a machine that has it -- never on the schedule.',
  },
];

/**
 * The modes the EDIT dialog offers for a given row.
 *
 * The three registerable ones, plus `secret` only when the row already
 * holds it. Switching an AWS row TO `secret` would produce a connection
 * `aws_session` refuses outright ("unsupported credential_mode for
 * AWS"), so it is not offered; an Azure row that already is `secret`
 * still has to be correctable, so it is not taken away either.
 */
export function editModes(
  current: StoredCredentialMode,
): readonly SegmentedOption<StoredCredentialMode>[] {
  const base: SegmentedOption<StoredCredentialMode>[] = REGISTER_MODES.map((m) => ({ ...m }));
  if (current === 'secret') {
    base.push({
      value: 'secret',
      label: CREDENTIAL_MODE_LABEL.secret,
      title: CREDENTIAL_MODE_HINT.secret,
    });
  }
  return base;
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
