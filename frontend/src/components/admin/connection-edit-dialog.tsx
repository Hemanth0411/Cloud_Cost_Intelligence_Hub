'use client';

import { Loader2 } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import {
  ConnectionField,
  FailureNotice,
  ProfileModeNotice,
  editModes,
} from '@/components/accounts/connection-form';
import { CrossAccountHandoff } from '@/components/accounts/cross-account-handoff';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { ApiError } from '@/lib/api/client';
import { costReaderArn, newExternalId, type StoredCredentialMode } from '@/lib/aws-onboarding';
import {
  changedFields,
  connectionPatch,
  describeChanges,
  differingColumns,
  editDraftFrom,
  FIELD_LABEL,
  type ConnectionEditDraft,
  type ConnectionPatchBody,
} from '@/lib/connection-edits';
import {
  isMissingConnection,
  updateConnection,
  type ConnectionRow,
} from '@/lib/services/connection-service';

/**
 * Correct a registered connection, without re-registering it.
 *
 * THE COMPLAINT THIS EXISTS FOR: a mistyped role ARN used to be
 * unfixable. `POST /admin/connections` is an upsert, so the only
 * recovery was submitting the account id again -- which rotates the
 * ExternalId and invalidates whatever trust policy the other account
 * has already applied. `PATCH` and `DELETE` were built for that, and
 * then had no UI at all, so the complaint was still true from a browser
 * and only answerable with curl.
 *
 * IT SENDS A DIFF, NEVER THE OBJECT. The API reads its body with
 * `exclude_unset=True`: an absent key leaves a column alone, an explicit
 * `null` clears it. So the natural shape of an edit form -- read the
 * row, bind six inputs, PUT it back -- would clear every field that is
 * not on screen, and the field most likely not to be on screen is the
 * ExternalId. `lib/connection-edits.ts` does the diffing as a pure
 * function and this component renders what it produced, down to the
 * "Will send" line in the footer area: what the dialog claims it will
 * change is read off the request body itself, so the two cannot drift.
 *
 * IT DOES NOT RE-IMPLEMENT THE SCHEMA. Two rules can refuse a save --
 * `CHECK (credential_mode <> 'assume_role' OR role_arn IS NOT NULL)` as
 * a 400, and `display_name` of `''` as a 422 from pydantic -- and both
 * are shown as the server worded them. The fields that would trip them
 * carry a WARNING rather than a block, deliberately: a client-side copy
 * of a database constraint is a second place for it to be written, and
 * it will eventually disagree with the first. The server is the
 * authority; this dialog is honest about what it is about to try.
 *
 * `provider` and `account_id` are not editable, here or in the API.
 * They are the natural key and `fact_cost_daily` is keyed by
 * account_id, so changing either would orphan every imported row rather
 * than edit anything. Removing and re-registering is the operation for
 * that, and the dialog says so.
 */

interface Props {
  connection: ConnectionRow;
  onClose: () => void;
  /** The row was changed; re-read the list. */
  onSaved: (changed: string[]) => void;
  /** 404 -- the row is gone. The list on screen is stale. */
  onVanished: () => void;
}

export function ConnectionEditDialog({ connection, onClose, onSaved, onVanished }: Props) {
  /**
   * THE DIFF BASE IS FROZEN AT MOUNT, and the live prop is not it.
   *
   * `connection` is resolved out of the loaded list on every render, so
   * it is replaced by a fresh object whenever the screen re-reads --
   * which it does after an import, and an import can be running while
   * this dialog is open. The draft is seeded once. Diffing a
   * mount-time draft against a POST-reload row makes every field that
   * changed underneath look like a user edit, and the request then
   * writes the stale value back: someone rotates an ExternalId in
   * another tab and applies it in the target account, this dialog
   * silently restores the old one, and the next AssumeRole is denied.
   *
   * Freezing the base is what makes the diff mean "what the user
   * changed in this dialog" rather than "how this differs from the
   * server right now". A field nobody touched then emits no key at
   * all, so the newer value survives -- which is the correct merge.
   * What the user does need to be told is that it happened, and
   * `movedElsewhere` below is on screen for exactly that.
   */
  const baseRef = useRef(connection);
  const base = baseRef.current;

  const [draft, setDraft] = useState<ConnectionEditDraft>(() => editDraftFrom(base));
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** `newExternalId` answered null. See the button. */
  const [cannotGenerate, setCannotGenerate] = useState(false);

  const body = connectionPatch(base, draft);
  const changed = changedFields(body);
  const nothingToSave = changed.length === 0;
  const movedElsewhere = differingColumns(base, connection);

  const set = <K extends keyof ConnectionEditDraft>(
    key: K,
    value: ConnectionEditDraft[K],
  ): void => setDraft((prev) => ({ ...prev, [key]: value }));

  const mode = draft.credentialMode;
  const twelveDigits = /^\d{12}$/.test(base.accountId);
  const derivedArn = twelveDigits ? costReaderArn(base.accountId) : null;
  const arnIsDerived = derivedArn !== null && draft.roleArn.trim() === derivedArn;
  // Against the frozen base, and trimmed on both sides -- otherwise a
  // stored value carrying a stray space opened the rotation panel by
  // itself, over an edit the user had not made.
  const externalIdRotated =
    draft.externalId.trim() !== (base.externalId ?? '').trim() && draft.externalId.trim() !== '';

  /**
   * Rotate the ExternalId -- or say why it could not be.
   *
   * `newExternalId` answers null when neither `crypto.randomUUID` nor
   * `getRandomValues` exists, which is the ordinary case on plain http:
   * it has no `Math.random` fallback because a predictable ExternalId
   * provides none of the protection it exists for. Writing that null
   * into the field as `''` would CLEAR the column -- one click on a
   * button labelled "Generate a new one" destroying the value instead
   * of replacing it. Registration refuses in exactly this situation
   * (`validateRegistration`); so does this.
   */
  function regenerate(): void {
    const next = newExternalId();
    if (next === null) {
      setCannotGenerate(true);
      return;
    }
    setCannotGenerate(false);
    set('externalId', next);
  }

  function save(): void {
    setSaving(true);
    setFailure(null);
    updateConnection(base.id, body)
      .then((fields) => onSaved(fields))
      .catch((cause: unknown) => {
        setSaving(false);
        if (isMissingConnection(cause)) {
          onVanished();
          return;
        }
        const error = cause instanceof Error ? cause : new Error(String(cause));
        // The 400 and the 422 both arrive here with the server's own
        // sentence in `message` -- the 400 names the CHECK that refused
        // and the 422 names the field. Printing it is the whole point;
        // replacing it with "could not save" would leave someone
        // retyping the same value.
        setFailure(
          error instanceof ApiError && error.forbidden
            ? 'Editing a cloud account is restricted to superadmins, and this account is not one. Nothing was changed.'
            : error.message || 'The change could not be saved.',
        );
      });
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && !saving && onClose()}
      title={`Edit ${base.displayName}`}
      description="Only the fields you change are sent. Anything you leave alone is left alone."
      className="sm:max-w-2xl"
      footer={
        <>
          <span className="mr-auto text-[11px] text-muted-foreground">
            {nothingToSave ? 'No changes yet.' : `Will send: ${describeChanges(body)}`}
          </span>
          <Button variant="outline" size="sm" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={saving || nothingToSave} onClick={save}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {movedElsewhere.length > 0 && (
          <Advisory>
            This connection was changed somewhere else since you opened this dialog &mdash;{' '}
            <strong className="font-medium">
              {movedElsewhere
                .map((c) => FIELD_LABEL[c as keyof ConnectionPatchBody] ?? c)
                .join(', ')}
            </strong>
            . The fields below still show what it said when you opened it. Saving sends only the
            fields you edit here, so anything in that list that you do not touch keeps its newer
            value &mdash; but close and reopen if you want to see it.
          </Advisory>
        )}

        <div className="rounded-md border bg-muted/30 px-3 py-2.5 text-xs">
          <p>
            <span className="text-muted-foreground">Account</span>{' '}
            <code className="font-mono">
              {base.provider}/{base.accountId}
            </code>
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            The provider and account id are the connection&rsquo;s identity and cannot be edited.
            Imported cost rows are keyed by them, so changing either would orphan the history
            instead of moving it. Remove this connection and register the other id if that is what
            you need.
          </p>
        </div>

        <ConnectionField
          id="edit-name"
          label="Name"
          value={draft.displayName}
          onChange={(v) => set('displayName', v)}
          placeholder="Finance-AWS"
          hint="Only a label — it changes nothing about access."
        />
        {draft.displayName.trim() === '' && (
          <Advisory>
            A name is required: the column is <code className="font-mono">NOT NULL</code> and the
            API rejects an empty one. Saving will come back refused rather than clearing it.
          </Advisory>
        )}

        <div className="space-y-2">
          <p className="text-xs font-medium">Credential mode</p>
          <SegmentedControl
            options={editModes(base.credentialMode as StoredCredentialMode)}
            value={mode}
            onChange={(v) => set('credentialMode', v)}
            ariaLabel="Credential mode"
          />
          {mode !== base.credentialMode && (
            <Advisory>
              This changes HOW the account is read, not which account it is. The fields below are
              what the new mode will use; anything the old mode needed stays stored unless you clear
              it.
            </Advisory>
          )}
          {mode === 'self' && twelveDigits && (
            /* The same hazard the ADD dialog refuses outright, reached
               by a different door. `account_id` is not editable, so this
               row keeps its 12-digit id while being read with the
               deployment's own role -- and `cost_explorer.py` ignores
               the account id, returning whatever the session can see.
               If `self` is also registered, one bill is then written
               under two account ids and every total double-counts. It
               is a UI rule rather than a schema one, so it is said
               rather than enforced. */
            <Advisory>
              Read with CostHub&rsquo;s own role, this connection returns the DEPLOY
              account&rsquo;s bill &mdash; but the rows are still filed under{' '}
              <code className="font-mono">{base.accountId}</code>, because the account id
              cannot be edited. If the deploy account is also registered as &ldquo;This
              account&rdquo;, the same spend is imported twice under two ids and every total
              double-counts.
            </Advisory>
          )}
        </div>

        {mode === 'profile' && <ProfileModeNotice profileName={draft.profileName} />}

        <ConnectionField
          id="edit-role-arn"
          label="Role ARN"
          value={draft.roleArn}
          onChange={(v) => set('roleArn', v)}
          placeholder={derivedArn ?? 'arn:aws:iam::123456789012:role/CostHubCostReader'}
          mono
          hint="Used when the credential mode is AssumeRole. Empty clears it."
          after={
            derivedArn !== null && !arnIsDerived ? (
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => set('roleArn', derivedArn)}
              >
                Use the derived ARN
              </Button>
            ) : null
          }
        />
        {mode === 'assume_role' && draft.roleArn.trim() === '' && (
          <Advisory>
            An AssumeRole connection must keep a role ARN &mdash; it is a schema CHECK, so saving
            this will come back refused and nothing will change. Retype the ARN in place rather
            than clearing it first.
          </Advisory>
        )}
        {derivedArn !== null && !arnIsDerived && draft.roleArn.trim() !== '' && (
          <Advisory>
            This is not the ARN this deployment is known to be able to assume.{' '}
            <code className="font-mono">terraform/iam.tf</code> grants{' '}
            <code className="font-mono">sts:AssumeRole</code> on{' '}
            <code className="break-all font-mono">{derivedArn}</code> by name, at the root
            IAM path, for every account. Another value &mdash; including this role name under
            a path &mdash; works only if it was added to that same policy by hand, through{' '}
            <code className="font-mono">data_source_accounts</code> in tfvars, which this
            screen cannot see. Otherwise it is denied however its trust policy is written.
          </Advisory>
        )}

        <ConnectionField
          id="edit-external-id"
          label="ExternalId"
          value={draft.externalId}
          onChange={(v) => set('externalId', v)}
          placeholder="7c1f2a84-5b03-4e19-9a62-0d8e4f1c3b57"
          mono
          hint="The value the other account's trust policy must contain. Empty clears it."
          after={
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={regenerate}
            >
              Generate a new one
            </Button>
          }
        />
        {cannotGenerate && (
          <Advisory>
            This browser could not generate an ExternalId &mdash; <code>crypto.randomUUID</code> and{' '}
            <code>crypto.getRandomValues</code> both need a secure context, and this page is not on
            one. Nothing was substituted and the field is unchanged: a predictable ExternalId would
            remove the protection it exists for, and an empty one would clear the value rather than
            rotate it. Open this over https or on localhost.
          </Advisory>
        )}
        {mode === 'assume_role' && draft.externalId.trim() === '' && base.externalId && (
          <Advisory>
            Clearing this is allowed by the schema but will break the connection if the role&rsquo;s
            trust policy still requires an ExternalId &mdash; AssumeRole is then denied, and the
            message looks like the role is missing.
          </Advisory>
        )}
        {externalIdRotated && (
          <>
            <Advisory>
              A changed ExternalId has to be applied in the target account before the next import,
              or AssumeRole starts failing. The trust policy below carries the new value.
            </Advisory>
            <CrossAccountHandoff
              accountId={twelveDigits ? base.accountId : ''}
              externalId={draft.externalId.trim()}
            />
          </>
        )}

        <ConnectionField
          id="edit-profile-name"
          label="AWS CLI profile name"
          value={draft.profileName}
          onChange={(v) => set('profileName', v)}
          placeholder="costhub"
          mono
          hint="Used when the credential mode is Local profile. Empty clears it."
        />
        {mode === 'profile' && draft.profileName.trim() === '' && (
          <Advisory>
            A local-profile connection with no profile name fails at credential resolution
            (&ldquo;profile_name missing&rdquo;) rather than at the cloud API. The schema allows it;
            the ingest cannot use it.
          </Advisory>
        )}

        {/* Gated on the ROW, never on the draft. Gating on the draft's
            mode let the field unmount while its value stayed in the
            draft, so switching away from "Service principal" after
            typing an ARN still sent `secret_arn` -- a value written to
            a column the user could no longer see. Keyed on the row, the
            field is either present for the whole session or absent for
            it. */}
        {(base.credentialMode === 'secret' || base.secretArn !== null) && (
          <ConnectionField
            id="edit-secret-arn"
            label="Secret ARN"
            value={draft.secretArn}
            onChange={(v) => set('secretArn', v)}
            placeholder="arn:aws:secretsmanager:us-east-1:…:secret:costhub/…"
            mono
            hint="A Secrets Manager ARN, never a credential value. Used by Azure service-principal connections."
          />
        )}

        {failure !== null && <FailureNotice message={failure} />}
      </div>
    </Dialog>
  );
}

/** A consequence worth reading before saving. Not a validation error. */
function Advisory({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[11px]">
      {children}
    </p>
  );
}
