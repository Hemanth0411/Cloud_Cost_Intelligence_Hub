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
  /**
   * A REPLACEMENT access key, and the only two fields here that are not
   * a diff against the row.
   *
   * They cannot be. The key is in Secrets Manager and no endpoint
   * returns it, so there is no stored value to compare a draft against
   * -- which also means they start empty on every open and a non-empty
   * one is, by construction, something the user just typed. `editDraftFrom`
   * sets them to `''` for that reason, not for want of a source.
   */
  accessKeyId: string;
  secretAccessKey: string;
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
  /**
   * Inputs, not columns. The API pops both off the body before anything
   * reaches the SQL, writes the pair to Secrets Manager and puts the
   * resulting ARN in `secret_arn` -- so what `changed` comes back
   * naming is `secret_arn`, never these.
   *
   * NOT nullable, unlike every other key here. `null` means "clear the
   * column" for a column, and these are not columns: there is nothing
   * for a null to clear, and sending one would only be a request to
   * store an empty credential. Emitted only when non-empty.
   */
  access_key_id?: string;
  secret_access_key?: string;
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
    // Always empty: the stored key is unreadable, so there is no current
    // value and anything here is a replacement the user typed.
    accessKeyId: '',
    secretAccessKey: '',
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

  // NOT diffed, because there is nothing to diff against: the stored key
  // is unreadable by anything, including this application. A non-empty
  // field is therefore a replacement, and an empty one is the ordinary
  // case of an edit that is not about the credential -- which is why
  // neither is ever sent as null. Sending a null would read as "clear
  // it", and the way to remove a stored key is to change the credential
  // mode or remove the connection, both of which delete the secret.
  const accessKeyId = draft.accessKeyId.trim();
  const secretAccessKey = draft.secretAccessKey.trim();
  if (accessKeyId !== '') body.access_key_id = accessKeyId;
  if (secretAccessKey !== '') body.secret_access_key = secretAccessKey;

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
  access_key_id: 'Access key id',
  secret_access_key: 'Secret access key',
};

/**
 * What is about to be sent, as a list of FIELD NAMES.
 *
 * Labels only, never values, which matters more here than it reads: the
 * footer renders this string, and one of the fields it can name holds a
 * credential. Printing "Name: Finance-AWS" would have been a friendlier
 * design and an unprintable one.
 */
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
