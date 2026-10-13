/**
 * What the OTHER account's administrator has to do, and the values we
 * hand them to do it with.
 *
 * Registering a cross-account connection is not a form submission: it
 * needs an IAM role created in an account we do not own and cannot
 * reach. So the real output of the dialog is a role ARN we can predict
 * and an ExternalId we generate, plus two JSON documents for someone
 * else to apply. They are built here rather than written into JSX so
 * the exact text is one value, testable and copyable, instead of being
 * spread across a component.
 *
 * The source of truth for both documents is `docs/09-deployment.md`
 * ("In each data-source account"). If that changes, change it here.
 */
import { DEPLOY_ACCOUNT_ID } from '@/lib/config';

/**
 * The role name is a CONVENTION, not a choice, and the reason matters:
 * `terraform/iam.tf` grants `sts:AssumeRole` on
 * `arn:aws:iam::*:role/CostHubCostReader` -- by NAME, for any account.
 * So the ARN is derived here, never typed.
 *
 * NOT quite "a role called anything else is unreachable", though it is
 * tempting to write that. The same statement is
 * `concat([...], local.assume_role_arns)`, and `assume_role_arns` is
 * every `role_arn` in `data_source_accounts` in tfvars -- arbitrary
 * ARNs, which nothing in this browser can see. `probe.py` reaches the
 * same conclusion and says "unless" rather than "never" for exactly
 * that reason; the edit dialog's warning about a non-derived ARN hedges
 * the same way.
 */
export const COST_READER_ROLE_NAME = 'CostHubCostReader';

/** Shown when the build does not know the deploy account id. */
export const DEPLOY_ACCOUNT_PLACEHOLDER = '<YOUR_COSTHUB_ACCOUNT_ID>';

/** The account the other side must trust, or the placeholder. */
export function deployAccountLabel(): string {
  return DEPLOY_ACCOUNT_ID || DEPLOY_ACCOUNT_PLACEHOLDER;
}

/** False when the trust policy below carries a placeholder, not an id. */
export const DEPLOY_ACCOUNT_KNOWN = DEPLOY_ACCOUNT_ID !== '';

const AWS_ACCOUNT_ID = /^\d{12}$/;
/** IAM's own bound on an access key id. Mirrors `key_store.py`. */
const ACCESS_KEY_ID = /^[A-Z0-9]{16,128}$/;

/**
 * A fresh ExternalId.
 *
 * NOT typed by the user, and not a password: it is a shared, unguessable
 * string that the target account's trust policy requires us to present,
 * which is what stops a third party who learns the role ARN from
 * persuading us to assume it on their behalf (the confused-deputy
 * problem). Generating it means it is actually unguessable, and means
 * the user is never asked to invent a secret.
 *
 * `crypto.randomUUID` needs a secure context. On plain http it is
 * undefined, so there is a `getRandomValues` fallback -- and no
 * `Math.random` fallback, because a predictable ExternalId provides
 * none of the protection it exists for. If neither is available the
 * caller has to say so rather than ship a weak value.
 */
export function newExternalId(): string | null {
  const c = typeof crypto === 'undefined' ? undefined : crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  if (typeof c?.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return null;
}

/** The ARN that `iam.tf` already permits, for a given account. */
export function costReaderArn(accountId: string): string {
  return `arn:aws:iam::${accountId}:role/${COST_READER_ROLE_NAME}`;
}

const ACTIONS = [
  'ce:GetCostAndUsage',
  'ce:GetCostForecast',
  'ce:GetDimensionValues',
  'ce:GetTags',
  'ce:GetAnomalies',
];

/**
 * What has to be true in the target account BEFORE the role matters.
 *
 * Both are from `docs/09-deployment.md` ("In each data-source
 * account"), both need someone other than whoever creates the role,
 * and a correct IAM policy still returns AccessDenied on every cost
 * API without the first one. They were in the copied text only, which
 * meant anyone relaying the on-screen panel in their own words handed
 * over an incomplete job.
 */
export const ACCOUNT_PREREQUISITES: readonly string[] = [
  'Enable “IAM User and Role Access to Billing Information” — account settings, root only. Without it every cost API returns AccessDenied however the role is written.',
  'Confirm Cost Explorer is enabled. It is free, once, and can take up to 24 hours to populate.',
];

/**
 * The role must sit at the ROOT IAM path.
 *
 * `iam.tf` permits the literal resource
 * `arn:aws:iam::*:role/CostHubCostReader`. A role created under a path
 * -- `/costhub/`, say, which is the convention CostHub uses for its own
 * roles -- has the ARN `...:role/costhub/CostHubCostReader`, which that
 * resource does not match and which is not the ARN stored here either.
 * It is the one mistake that looks correct and fails closed.
 */
export function rootPathNote(targetAccountId?: string): string {
  // Name the ACTUAL account. This used to be a constant containing a
  // literal `<account>`, which read as a third mystery account in a
  // message where every other id was concrete -- and the reader's job
  // is to paste these values into IAM, so an unsubstituted placeholder
  // is the one thing that must not appear.
  const id = targetAccountId && /^\d{12}$/.test(targetAccountId) ? targetAccountId : '<account>';
  return (
    'Create it at the root IAM path (no custom path): the permission is granted to the ' +
    `exact ARN arn:aws:iam::${id}:role/CostHubCostReader.`
  );
}

/** The permissions policy to attach to the role, from docs/09-deployment.md. */
export function permissionsPolicyJson(): string {
  return JSON.stringify(
    {
      Version: '2012-10-17',
      Statement: [{ Sid: 'CostHubRead', Effect: 'Allow', Action: ACTIONS, Resource: '*' }],
    },
    null,
    2,
  );
}

/** The trust policy, which is the half that needs the ExternalId. */
export function trustPolicyJson(externalId: string): string {
  return JSON.stringify(
    {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'TrustCostHub',
          Effect: 'Allow',
          Principal: { AWS: `arn:aws:iam::${deployAccountLabel()}:root` },
          Action: 'sts:AssumeRole',
          Condition: { StringEquals: { 'sts:ExternalId': externalId } },
        },
      ],
    },
    null,
    2,
  );
}

/**
 * Everything the other administrator needs, as one pasteable block.
 *
 * One button as well as the two separate ones, because the whole point
 * is that this gets sent to another team, and three separate copies
 * arrive as three messages with no context around them.
 */
export function handoffText(accountId: string, externalId: string): string {
  return [
    `CostHub needs read-only cost access to AWS account ${accountId}.`,
    '',
    'Please create an IAM role in that account:',
    '',
    `  Role name : ${COST_READER_ROLE_NAME}   (exactly this -- the name is what is permitted)`,
    `  Role ARN  : ${costReaderArn(accountId)}`,
    `  ExternalId: ${externalId}`,
    '',
    `  ${rootPathNote(accountId)}`,
    '',
    'Also required in that account, once:',
    ...ACCOUNT_PREREQUISITES.map((p, i) => `  ${i + 1}. ${p.replace(/[“”]/g, '"')}`),
    '',
    '--- permissions policy ---',
    permissionsPolicyJson(),
    '',
    '--- trust policy ---',
    trustPolicyJson(externalId),
    '',
    'No credential is exchanged: CostHub calls sts:AssumeRole with the',
    'ExternalId above and receives short-lived credentials. It can read',
    'cost data and nothing else.',
  ].join('\n');
}

// ------------------------------------------------------------ the form

/**
 * Every value `cloud_connections.credential_mode` can hold.
 *
 * The column carries
 * `CHECK (credential_mode IN ('self','assume_role','profile','secret'))`,
 * so this is the closed set, and the UI has to be able to LABEL all four
 * -- a row can arrive in any of them, whoever wrote it.
 */
export type StoredCredentialMode = 'self' | 'assume_role' | 'profile' | 'secret';

/**
 * The subset a browser may REGISTER, which is now all four.
 *
 * `secret` used to be absent on purpose, and the reason was sound while
 * it lasted: it resolved an Azure service principal out of Secrets
 * Manager and `aws_session` rejected it outright for AWS, so offering it
 * could only produce rows that cannot authenticate. AWS support is
 * implemented now (`credentials.py:_stored_key_session`), so the field
 * that would have been a trap is a working mode.
 *
 * It is still the LAST RESORT, and `MODE_RECOMMENDATION` says so on
 * screen. See `STORED_KEY_LIMITS` for what it costs.
 */
export type CredentialMode = StoredCredentialMode;

export const CREDENTIAL_MODE_LABEL: Record<StoredCredentialMode, string> = {
  self: 'Deploy account',
  assume_role: 'AssumeRole',
  profile: 'Local profile',
  // Not "Service principal" any more: this mode now covers an AWS
  // access key as well as an Azure service principal, and a label that
  // names only one of them mislabels every row of the other kind.
  secret: 'Stored credential',
};

export const CREDENTIAL_MODE_HINT: Record<StoredCredentialMode, string> = {
  self: 'Read with the application’s own execution role. Nothing to configure.',
  assume_role:
    'Short-lived credentials via STS, using an ExternalId. Needs a role in that account.',
  profile:
    'A named AWS CLI profile, read from the machine making the call. The scheduled import runs in a Lambda, which has none, so it cannot use this.',
  secret:
    'A long-lived credential held in Secrets Manager and read at call time — an access key for AWS, a service principal for Azure. The database stores only the ARN.',
};

/**
 * WHICH MODE THE SCREEN IS RECOMMENDING, in one sentence.
 *
 * On screen wherever the two AWS options are presented, because they are
 * NOT equivalent and a segmented control makes everything in it look
 * equivalent. AssumeRole gets credentials that expire in an hour and
 * stores nothing; a stored key is long-lived, sits in Secrets Manager
 * until someone removes it, and is only the answer when nobody in the
 * target account will create a role.
 */
export const MODE_RECOMMENDATION =
  'AssumeRole is the one to use if you can: it gets credentials that expire in an hour and nothing long-lived is stored. An access key is the fallback for when nobody in that account will create a role.';

/**
 * What storing a key actually means, stated where it is chosen.
 *
 * The honest counterweight to how easy this mode is to pick. Each line
 * is a fact about the implementation rather than a general caution:
 * line 1 is `key_store.py` (Secrets Manager, ARN in the column), line 2
 * is that the form is the only place the value is ever visible, and
 * line 3 is `soft_delete` plus the PATCH path that clears the mode.
 */
export const STORED_KEY_LIMITS: readonly string[] = [
  'The key goes to AWS Secrets Manager. The database stores only its ARN — never the key — and so does the audit log.',
  'It is shown nowhere afterwards. Neither this screen nor the API can read it back, so keep your own copy if you need one; to change it, type a new one over it.',
  'Removing the connection deletes the secret, and so does switching it to another credential mode. Nothing is left behind to find later.',
];

/**
 * WHY `profile` IS OFFERED AT ALL, and what it cannot do.
 *
 * `credentials.py` resolves it as `boto3.Session(profile_name=...)`,
 * which reads `~/.aws/config` on the machine making the call. The
 * scheduled import is an EventBridge rule targeting the `ingest` Lambda
 * (`terraform/schedule.tf`), where that file does not exist, so such a
 * connection fails every morning.
 *
 * Test and Import now are HTTP calls, so they run wherever the API runs
 * -- a SEPARATE Lambda in the deployed stack (`lambda.tf` declares `api`
 * and `ingest` as two functions, not one), and something else entirely
 * if someone is running uvicorn locally.
 *
 * WHICH IS WHY THE SECOND LINE BELOW IS CONDITIONAL. The browser is
 * handed a base URL and nothing more; it cannot tell a deployed API from
 * a local one. Telling someone running the API on the machine that HAS
 * the profile that it will fail would be wrong in the direction that
 * costs them most -- declaring a working connection broken.
 *
 * These lines are a constant rather than JSX so that the add dialog and
 * the edit dialog say the same thing, and so that what the UI claims
 * about this mode is one editable value rather than three.
 */
export const PROFILE_MODE_LIMITS: readonly string[] = [
  'The scheduled 06:00 UTC import runs in a Lambda, which has no AWS CLI profiles and no ~/.aws/config, so it will fail for this connection every day.',
  '“Test” and “Import now” run wherever the API runs, never in your browser. Where CostHub is deployed that is a Lambda too, so both report a missing profile however correct the profile is on your own machine.',
  'Cost data arrives only when someone runs the ingest by hand — python -m costhub.cli ingest — on a machine where this profile is configured.',
];

export interface RegistrationDraft {
  credentialMode: CredentialMode;
  /** A 12-digit AWS account id. Ignored when the mode is `self`. */
  accountId: string;
  displayName: string;
  /** Generated, shown, and sent once. Never typed. */
  externalId: string;
  /** A named AWS CLI profile. Only read when the mode is `profile`. */
  profileName: string;
  /**
   * The access key, for `secret` mode only. TYPED, unlike everything
   * else on this form, and the only value here that is a credential.
   *
   * It lives in component state for as long as the dialog is open and is
   * sent once. The API writes it to Secrets Manager and stores the ARN;
   * nothing reads it back, so there is no "current value" for an edit
   * form to show and no request that could return one.
   */
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Format checks only, and they are not cosmetic.
 *
 * `cloud_connections` carries
 * `CHECK (credential_mode <> 'assume_role' OR role_arn IS NOT NULL)`
 * and the API does not validate it, so an assume_role POST without a
 * role ARN reaches Postgres, raises a CheckViolation, and comes back as
 * an unhandled 500 carrying no CORS headers -- which the browser can
 * only report as an unreachable API. The role ARN is derived from the
 * account id, so the guard that matters is that the account id is
 * present and well formed.
 *
 * `profile_name` is NOT a schema rule -- the column is nullable -- but a
 * profile row without one fails at credential resolution with
 * `CredentialError: profile_name missing`, which is a connection that
 * can never work. Registration is the one place that shape is chosen,
 * so it is refused here.
 */
export function validateRegistration(draft: RegistrationDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = draft.displayName.trim();
  if (name === '') errors.displayName = 'A name is required.';
  else if (name.length > 60) errors.displayName = 'Keep it under 60 characters.';

  // Every mode but `self` is keyed by a real account id, `profile`
  // included: `fact_cost_daily` is keyed by (provider, account_id), so
  // that id is what the imported rows are filed under and what a grant
  // is written against.
  if (draft.credentialMode !== 'self') {
    const id = draft.accountId.trim();
    if (id === '') errors.accountId = 'An AWS account id is required.';
    else if (!AWS_ACCOUNT_ID.test(id)) errors.accountId = 'Exactly 12 digits, no dashes.';
    else if (DEPLOY_ACCOUNT_ID !== '' && id === DEPLOY_ACCOUNT_ID) {
      // The unique key is (provider, account_id), so 'self' and the
      // deploy account's own 12-digit id are two DIFFERENT rows for one
      // real AWS account. Both would be enabled, and Cost Explorer
      // ignores the account id (`cost_explorer.py` reads whatever the
      // session can see), so the same bill would be written twice under
      // two account ids and every total would double-count. An
      // assume_role row also cannot authenticate: it would try to
      // assume a CostHubCostReader role in the deploy account, which
      // does not exist.
      errors.accountId =
        'That is this CostHub account. It is already readable directly — choose “This account” rather than registering it a second time under its own id.';
    }
  }

  if (draft.credentialMode === 'assume_role' && draft.externalId === '') {
    errors.externalId =
      'This browser could not generate an ExternalId. A predictable one would remove the protection it exists for, so none was substituted.';
  }

  if (draft.credentialMode === 'profile' && draft.profileName.trim() === '') {
    errors.profileName =
      'A profile name is required: without one the connection fails at credential resolution rather than at the cloud API.';
  }

  if (draft.credentialMode === 'secret') {
    // BOTH HALVES OR NEITHER. The API refuses half a pair with a 400
    // and stores nothing, so this is not the authority -- but a form
    // that submits with one field still empty is the likeliest mistake
    // on this screen and it may as well be caught before the request.
    //
    // The id is checked against the same pattern the server uses
    // (`key_store.ACCESS_KEY_ID_RE`, IAM's own AccessKeyIdType bound),
    // so a pasted ARN is named here rather than coming back as a 400.
    // The secret deliberately gets only a length check: there is no
    // published format, and a stricter guess would reject a valid key.
    const keyId = draft.accessKeyId.trim();
    const secret = draft.secretAccessKey.trim();
    if (keyId === '') errors.accessKeyId = 'An access key id is required.';
    else if (!ACCESS_KEY_ID.test(keyId)) {
      errors.accessKeyId =
        'That does not look like an access key id: 16 to 128 characters of A-Z and 0-9, normally beginning AKIA.';
    }
    if (secret === '') errors.secretAccessKey = 'A secret access key is required.';
    else if (secret.length < 16) {
      errors.secretAccessKey = 'That is too short to be a secret access key — a real one is 40 characters.';
    }
  }
  return errors;
}

/** The body `POST /admin/connections` is actually sent. */
export interface RegistrationBody {
  provider: string;
  account_id: string;
  display_name: string;
  credential_mode: CredentialMode;
  role_arn: string | null;
  external_id: string | null;
  profile_name: string | null;
  /**
   * Present ONLY for `secret` mode, and omitted rather than nulled for
   * every other one. The API refuses a key sent for a mode that would
   * never read it (400), which is the correct behaviour and also means
   * this must not send one just because the field holds a stale value
   * from before the user switched modes.
   */
  access_key_id?: string;
  secret_access_key?: string;
}

export function registrationBody(draft: RegistrationDraft): RegistrationBody {
  const self = draft.credentialMode === 'self';
  const crossAccount = draft.credentialMode === 'assume_role';
  const accountId = self ? 'self' : draft.accountId.trim();
  const body: RegistrationBody = {
    provider: 'aws',
    account_id: accountId,
    display_name: draft.displayName.trim(),
    credential_mode: draft.credentialMode,
    // Only an AssumeRole connection has either of these, and the ARN is
    // derived. A profile connection authenticates as whoever the profile
    // is, so a role ARN on it would be stored, displayed, and never used.
    role_arn: crossAccount ? costReaderArn(accountId) : null,
    external_id: crossAccount ? draft.externalId : null,
    profile_name: draft.credentialMode === 'profile' ? draft.profileName.trim() : null,
  };
  if (draft.credentialMode === 'secret') {
    body.access_key_id = draft.accessKeyId.trim();
    body.secret_access_key = draft.secretAccessKey.trim();
  }
  return body;
}
