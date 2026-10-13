/**
 * Turning an edit form into the smallest possible PATCH body.
 *
 * THIS IS THE WHOLE REASON THE EDIT DIALOG IS SAFE, so it lives in a
 * pure function rather than inside a component.
 *
 * `PATCH /admin/connections/{id}` reads its body with
 * `ConnectionPatch.model_dump(exclude_unset=True)`. Three states, not
 * two, and the API distinguishes them deliberately:
 *
 *   key absent        leave the column alone
 *   key set to null   clear the column
 *   key set to value  write that value
 *
 * So sending the whole object back -- the obvious thing an edit form
 * does -- is destructive, and specifically destructive in the way this
 * feature exists to prevent: re-stating `external_id: null` because the
 * field was not on screen clears the one value that has to be matched by
 * the other account's trust policy, and the only recovery is rotating
 * it and asking them to apply it again. `routes/connections.py` says the
 * same thing from the other side ("which is exactly how an edit screen
 * silently destroys an ExternalId").
 *
 * `provider` and `account_id` are not here because they are not
 * editable: they are the natural key, `fact_cost_daily` is keyed by
 * account_id, and changing either would orphan the imported history
 * rather than edit anything. `edits.py:EDITABLE` is the server's copy of
 * this list.
 */
import type { StoredCredentialMode } from '@/lib/aws-onboarding';
import type { ConnectionRow } from '@/lib/services/connection-service';

/**
 * The form's state: every field a string, because that is what an
 * `<input>` holds. `''` is how a cleared field looks, and the mapping
 * from `''` to `null` happens once, below.
 */
export interface ConnectionEditDraft {
  displayName: string;
  credentialMode: StoredCredentialMode;
  roleArn: string;
  externalId: string;
  profileName: string;
  secretArn: string;
}

/**
 * The body sent to the API. Snake_case because `lib/api/client.ts`
 * renames keys on the way IN only -- a request body is passed through
 * `JSON.stringify` untouched.
 *
 * Every key optional and every value nullable, which is the API's
 * contract rather than laziness: an absent key and a null one mean
 * different things.
 */
export interface ConnectionPatchBody {
  display_name?: string;
  credential_mode?: StoredCredentialMode;
  role_arn?: string | null;
  external_id?: string | null;
  profile_name?: string | null;
  secret_arn?: string | null;
}

/** The row as the form starts out: a null column is an empty input. */
export function editDraftFrom(row: ConnectionRow): ConnectionEditDraft {
  return {
    displayName: row.displayName,
    credentialMode: row.credentialMode as StoredCredentialMode,
    roleArn: row.roleArn ?? '',
    externalId: row.externalId ?? '',
    profileName: row.profileName ?? '',
    secretArn: row.secretArn ?? '',
  };
}

/** `''` means the user emptied the field, which means clear the column. */
function nullable(value: string | null): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Only what changed.
 *
 * Compared against the row the dialog was opened on, field by field. A
 * field the user never touched is byte-identical and so emits no key at
 * all -- which is what stops this from clearing anything.
 *
 * `display_name` is the one field that is NOT sent as null when it is
 * emptied. The column is NOT NULL, so a null would be refused by
 * Postgres and surface as a 400 about a constraint; an empty string is
 * refused by pydantic's `min_length=1` as a 422 naming the field, which
 * is the more useful of the two. Neither is swallowed -- the dialog
 * prints whichever comes back -- but it may as well be the readable one.
 *
 * BOTH SIDES ARE NORMALISED, and that is not cosmetic. The draft is
 * trimmed before it is sent, so comparing a trimmed draft against an
 * UNTRIMMED stored value made whitespace in the database look like a
 * user edit. Nothing on the write path trims -- not `ConnectionIn`, not
 * `store.upsert`, not `cli.py` -- so `external_id = ' 7c1f... '` is
 * storable by any non-UI client, and merely OPENING this dialog would
 * then have emitted `external_id` with no user interaction at all. A
 * stored value of `'   '` was worse: it normalised to null, so the
 * destructive clear this whole module exists to prevent was emitted for
 * a field nobody touched.
 *
 * The consequence, stated rather than hidden: surrounding whitespace in
 * a stored value cannot be stripped from this dialog, because a draft
 * that differs only by whitespace now compares equal. That is the right
 * way round. It is a wart in data this UI did not write, and leaving it
 * alone is exactly what "only send what the user changed" means.
 */
export function connectionPatch(
  row: ConnectionRow,
  draft: ConnectionEditDraft,
): ConnectionPatchBody {
  const body: ConnectionPatchBody = {};

  const name = draft.displayName.trim();
  if (name !== row.displayName.trim()) body.display_name = name;

  if (draft.credentialMode !== row.credentialMode) {
    body.credential_mode = draft.credentialMode;
  }

  const roleArn = nullable(draft.roleArn);
  if (roleArn !== nullable(row.roleArn)) body.role_arn = roleArn;

  const externalId = nullable(draft.externalId);
  if (externalId !== nullable(row.externalId)) body.external_id = externalId;

  const profileName = nullable(draft.profileName);
  if (profileName !== nullable(row.profileName)) body.profile_name = profileName;

  const secretArn = nullable(draft.secretArn);
  if (secretArn !== nullable(row.secretArn)) body.secret_arn = secretArn;

  return body;
}

/**
 * Which editable columns differ between two reads of the same row.
 *
 * For telling someone that the connection they are editing was changed
 * somewhere else while the dialog was open. Expressed through
 * `connectionPatch` rather than as a second field-by-field comparison,
 * so there is exactly one definition of "these two differ" and it
 * cannot drift from the one that builds the request.
 */
export function differingColumns(a: ConnectionRow, b: ConnectionRow): string[] {
  return changedFields(connectionPatch(a, editDraftFrom(b)));
}

/**
 * The field names in a patch, for the "N changes" line and the disabled
 * Save button. Deliberately derived from the body that will actually be
 * sent, so the count on screen cannot disagree with the request.
 */
export function changedFields(body: ConnectionPatchBody): string[] {
  return Object.keys(body).sort();
}

/** `display_name` -> `Name`, for a sentence listing what will change. */
export const FIELD_LABEL: Record<keyof ConnectionPatchBody, string> = {
  display_name: 'Name',
  credential_mode: 'Credential mode',
  role_arn: 'Role ARN',
  external_id: 'ExternalId',
  profile_name: 'CLI profile',
  secret_arn: 'Secret ARN',
};

export function describeChanges(body: ConnectionPatchBody): string {
  return changedFields(body)
    .map((key) => {
      const label = FIELD_LABEL[key as keyof ConnectionPatchBody] ?? key;
      // Name the clears explicitly. "ExternalId" and "ExternalId
      // (cleared)" are very different edits to be about to confirm.
      return body[key as keyof ConnectionPatchBody] === null ? `${label} (cleared)` : label;
    })
    .join(', ');
}
