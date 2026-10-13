/**
 * Runtime configuration, read once from `NEXT_PUBLIC_*`.
 *
 * WHY THESE CANNOT COME FROM TERRAFORM: putting them in
 * `aws_amplify_app.environment_variables` closes a dependency cycle --
 * Amplify's default domain is already an input to the Cognito callback
 * URLs and to the Lambda Function URL's CORS origins, so making the
 * Amplify app depend on Cognito's outputs makes the graph circular and
 * terraform refuses the plan. They are set in the Amplify console for
 * builds and in `frontend/.env.local` (written by `./do.sh outputs`)
 * for local dev.
 *
 * Nothing here is a secret. `NEXT_PUBLIC_*` values are inlined into the
 * client bundle at build time and are readable by anyone who loads the
 * page; a Cognito pool id and a public app client id are designed for
 * that. No credential, client secret or token belongs in this file.
 *
 * MOCK MODE IS THE DEFAULT, and that is deliberate: the app has to keep
 * running with no backend reachable. `NEXT_PUBLIC_USE_MOCK` must be the
 * exact string "false" to turn it off, so a missing, empty or
 * misspelled variable falls back to mock rather than to a screen full
 * of failed requests.
 */

/** Trailing slash removed, so callers can always join with `/path`. */
function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

const env = {
  apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL ?? '',
  clientId: process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? '',
  cognitoDomain: process.env.NEXT_PUBLIC_COGNITO_DOMAIN ?? '',
  deployAccountId: process.env.NEXT_PUBLIC_DEPLOY_ACCOUNT_ID ?? '',
  useMock: process.env.NEXT_PUBLIC_USE_MOCK,
} as const;

export const API_BASE_URL = trimSlash(env.apiBaseUrl);
export const COGNITO_CLIENT_ID = env.clientId;

/**
 * The AWS account this stack is deployed into, or '' when the build
 * was not told.
 *
 * Needed only to print the trust policy a DIFFERENT account's
 * administrator has to apply -- it names us as the principal they
 * trust. It is not a credential and not a secret; an account id is
 * visible in every ARN this app already shows.
 *
 * NOT folded into `liveModeBlockers`. Live mode works perfectly
 * without it, and refusing live data because an onboarding snippet
 * would be less specific would be the wrong trade. Where it is
 * missing, `lib/aws-onboarding.ts` prints a placeholder and the UI
 * says it is a placeholder, rather than guessing a number.
 */
export const DEPLOY_ACCOUNT_ID = /^\d{12}$/.test(env.deployAccountId)
  ? env.deployAccountId
  : '';

// NO pool-id or region export. Managed Login needs only the hosted
// domain and the public client id, and this app never verifies a JWT
// locally (`tokens.ts` decodes without verifying, by design), so
// neither value has a consumer. They stay in .env.local and
// `do.sh outputs` because they document the stack, but exporting them
// would advertise a capability the client does not have.

/** `https://<domain>` -- the value is stored without a scheme. */
export const COGNITO_DOMAIN_URL = env.cognitoDomain
  ? `https://${trimSlash(env.cognitoDomain.replace(/^https?:\/\//, ''))}`
  : '';

/**
 * Is the app running on mock data?
 *
 * True unless USE_MOCK is explicitly "false" AND the three values a
 * live session actually needs are present. The second half matters: a
 * build with `NEXT_PUBLIC_USE_MOCK=false` and a missing API URL would
 * otherwise produce an app that can neither sign in nor show anything,
 * which is a worse outcome than the mock it replaced.
 */
export const USE_MOCK: boolean =
  env.useMock !== 'false' ||
  API_BASE_URL === '' ||
  COGNITO_CLIENT_ID === '' ||
  COGNITO_DOMAIN_URL === '';

/**
 * Which of the three values live mode needs are missing.
 *
 * Exported because the runtime mock/live toggle (`lib/mode.ts`) has to
 * refuse a switch to live when they are absent, and has to say which
 * one is absent. `USE_MOCK` already folds this in, but it folds it in
 * irreversibly -- once it is `true` you cannot tell "the build asked
 * for mock" from "the build asked for live and could not have it".
 */
export function liveModeBlockers(): string[] {
  const missing: string[] = [];
  if (API_BASE_URL === '') missing.push('NEXT_PUBLIC_API_BASE_URL');
  if (COGNITO_CLIENT_ID === '') missing.push('NEXT_PUBLIC_COGNITO_CLIENT_ID');
  if (COGNITO_DOMAIN_URL === '') missing.push('NEXT_PUBLIC_COGNITO_DOMAIN');
  return missing;
}

// SAY SO WHEN LIVE MODE IS REFUSED.
//
// Asking for live mode and silently getting mock is the single most
// confusing thing this flag can do: the app looks like it is working,
// the numbers are plausible, and nothing anywhere says the API was
// never contacted. The usual cause is an Amplify build whose console
// environment variables were wiped by a terraform apply, which is a
// thing that has actually happened here.
//
// Module scope, so it fires once per page load for whoever is looking.
if (env.useMock === 'false' && USE_MOCK && typeof console !== 'undefined') {
  console.warn(
    `[costhub] NEXT_PUBLIC_USE_MOCK=false was requested but mock data is still in use: ` +
      `${liveModeBlockers().join(', ')} ${liveModeBlockers().length === 1 ? 'is' : 'are'} not set.`,
  );
}
