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
 * A role called anything else is unreachable no matter how its trust
 * policy is written, and nothing on this screen can widen that grant.
 * So the ARN is derived, never typed.
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
export const ROOT_PATH_NOTE =
  'Create it at the root IAM path (no custom path): the permission is granted to the exact ARN arn:aws:iam::<account>:role/CostHubCostReader.';

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
    `  ${ROOT_PATH_NOTE}`,
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

export type CredentialMode = 'self' | 'assume_role';

export interface RegistrationDraft {
  credentialMode: CredentialMode;
  /** A 12-digit AWS account id. Ignored when the mode is `self`. */
  accountId: string;
  displayName: string;
  /** Generated, shown, and sent once. Never typed. */
  externalId: string;
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
 */
export function validateRegistration(draft: RegistrationDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = draft.displayName.trim();
  if (name === '') errors.displayName = 'A name is required.';
  else if (name.length > 60) errors.displayName = 'Keep it under 60 characters.';

  if (draft.credentialMode === 'assume_role') {
    const id = draft.accountId.trim();
    if (id === '') errors.accountId = 'An AWS account id is required.';
    else if (!AWS_ACCOUNT_ID.test(id)) errors.accountId = 'Exactly 12 digits, no dashes.';
    else if (DEPLOY_ACCOUNT_ID !== '' && id === DEPLOY_ACCOUNT_ID) {
      // The unique key is (provider, account_id), so 'self' and the
      // deploy account's own 12-digit id are two DIFFERENT rows for one
      // real AWS account. Both would be enabled, and Cost Explorer
      // ignores the account id (`cost_explorer.py` reads whatever the
      // session can see), so the same bill would be written twice under
      // two account ids and every total would double-count. The second
      // row also cannot authenticate: it would try to assume a
      // CostHubCostReader role in the deploy account, which does not
      // exist.
      errors.accountId =
        'That is this CostHub account. It is already readable directly — choose “This account” instead of registering it as a cross-account role.';
    }
    if (draft.externalId === '') {
      errors.externalId =
        'This browser could not generate an ExternalId. A predictable one would remove the protection it exists for, so none was substituted.';
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
}

export function registrationBody(draft: RegistrationDraft): RegistrationBody {
  const self = draft.credentialMode === 'self';
  const accountId = self ? 'self' : draft.accountId.trim();
  return {
    provider: 'aws',
    account_id: accountId,
    display_name: draft.displayName.trim(),
    credential_mode: draft.credentialMode,
    role_arn: self ? null : costReaderArn(accountId),
    external_id: self ? null : draft.externalId,
  };
}
