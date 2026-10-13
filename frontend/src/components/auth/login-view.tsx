'use client';

import { CheckCircle2, Loader2, Mail } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { fieldA11y, FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { beginSignIn, takeSignedOut } from '@/lib/auth/cognito';
import { DEMO_CREDENTIALS } from '@/lib/auth/constants';
import { startSession } from '@/lib/auth/session';
import { browserStore, emptyStore, signIn } from '@/lib/auth/store';
import { validateLogin, type FieldErrors } from '@/lib/auth/validation';
import { signInWithCredentials } from '@/lib/services/session-service';
import { useMode } from '@/hooks/use-mode';
import { AuthShell, DemoNotice } from './auth-shell';
import { PasswordField } from './password-field';

/** Only allow same-site relative redirects. */
function safeNext(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/dashboard';
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `/login` in both modes.
 *
 * Live mode has no form to render. The pool is passwordless email OTP,
 * which REQUIRES Cognito Managed Login -- the one-time-code screen is
 * Cognito's, not ours, and there is no API this app could call to
 * replace it. So the OTP path is a hand-off.
 *
 * THE DEFAULT PATH IS NOW A PASSWORD, posted straight to Cognito's
 * InitiateAuth, so the form is ours and the user never leaves. The
 * hand-off above is kept as a fallback and reached deliberately:
 * `/login?otp=1`, or automatically when Cognito bounces an authorize
 * request back here with an `error`.
 *
 * ONE FORM SERVES BOTH MODES. Mock and live differ in the submit
 * handler and the footer only -- the fields, validation, error display
 * and busy state are identical, so duplicating sixty lines of JSX to
 * vary two of them is how the two copies drift apart.
 */
export function LoginView() {
  // RUNTIME, not build-time. If this stayed on the compiled-in
  // default, flipping to mock on /settings would give you mock data
  // behind a Cognito sign-in you cannot complete offline -- the
  // toggle would be half-wired and fail in exactly the situation it
  // exists for (no connectivity, demo about to start).
  const { mock, resolved } = useMode();
  const params = useSearchParams();
  const wantsOtp = params.get('otp') === '1';
  const hasCognitoError = params.get('error') !== null;
  // Keep the shell on screen while the override is read. Returning
  // null would mean the sign-in page server-renders to nothing and
  // flashes blank before hydrating -- on the one page a first-time
  // visitor always lands on.
  if (!resolved) {
    return (
      <AuthShell>
        <div className="flex h-40 items-center justify-center" role="status" aria-label="Loading sign-in">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
        </div>
      </AuthShell>
    );
  }
  // The hand-off is opt-in, EXCEPT when Cognito has refused an
  // authorize request: that error arrives as a query parameter on this
  // page, and only the hand-off renders it. Routing past it would
  // swallow the one message that explains the failure.
  if (!mock && (wantsOtp || hasCognitoError)) return <ManagedLoginHandoff />;
  return <CredentialsLogin mock={mock} />;
}

// --------------------------------------------------------------- live

function ManagedLoginHandoff() {
  const params = useSearchParams();
  const nextPath = safeNext(params.get('next'));
  /**
   * Cognito reports a refused authorize request back here.
   *
   * The CODE is kept; `error_description` is NOT rendered. It is
   * attacker-controllable text arriving in a query parameter, and
   * printing it on our own sign-in page turns that page into free
   * phishing copy ("Your account needs verification, call ..."). React
   * escapes it, so this is not XSS -- it is the social half of the same
   * problem. The code is a short fixed vocabulary and is enough to act
   * on; the description goes to the console for whoever is debugging.
   */
  const cognitoErrorCode = params.get('error');
  const cognitoError = cognitoErrorCode
    ? `Cognito refused the sign-in request (${cognitoErrorCode}). This usually means the app's redirect URL or client id does not match the user pool.`
    : null;

  useEffect(() => {
    const description = params.get('error_description');
    if (description) console.warn('[costhub] Cognito error_description:', description);
  }, [params]);

  const [error, setError] = useState<string | null>(cognitoError);
  const [redirecting, setRedirecting] = useState(false);
  const started = useRef(false);

  const go = (): void => {
    setError(null);
    setRedirecting(true);
    void beginSignIn(nextPath).catch((cause: unknown) => {
      setRedirecting(false);
      setError(cause instanceof Error ? cause.message : 'Could not start sign-in.');
    });
  };

  /**
   * Auto-hand-off, with two deliberate exceptions.
   *
   * Redirecting unconditionally makes two states impossible to escape.
   * After signing out, `/logout` returns here and an immediate
   * re-authorize means "sign out" shows the code screen again with no
   * way to simply leave. And when Cognito has refused the request, the
   * error arrives as a query parameter on this page -- auto-redirecting
   * would retry it forever and the user would never see why.
   *
   * The ref guards React strict mode, which runs effects twice in dev.
   */
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (takeSignedOut() || cognitoErrorCode) return;
    go();
    // `go` is stable for the life of this component and intentionally
    // not a dependency: re-running this effect would restart sign-in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cognitoErrorCode]);

  return (
    <AuthShell>
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-sm text-muted-foreground">
          CostHub sends a one-time code to your work email. There is no password to remember —
          none is ever set.
        </p>
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <Button size="lg" className="w-full" disabled={redirecting} onClick={go}>
        {redirecting ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <Mail className="h-4 w-4" aria-hidden />
        )}
        {redirecting ? 'Opening sign-in…' : 'Continue with email code'}
      </Button>

      <DemoNotice>
        Access is by invitation only, and only <code className="font-mono">@chryselys.com</code>{' '}
        addresses are accepted. Signing in grants no access to cost data by itself — a superadmin
        has to grant you an account first, and until then your dashboard is empty by design.
      </DemoNotice>
    </AuthShell>
  );
}

// -------------------------------------------------- the credentials form

function CredentialsLogin({ mock }: { mock: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const nextPath = safeNext(params.get('next'));
  const justReset = params.get('reset') === '1';

  // Prefilled in mock mode because it is a demo whose credentials are
  // printed on the page anyway; empty in live mode, where guessing at
  // somebody's email is just a field to clear.
  const [email, setEmail] = useState<string>(mock ? DEMO_CREDENTIALS.email : '');
  const [password, setPassword] = useState<string>(mock ? DEMO_CREDENTIALS.password : '');
  const [errors, setErrors] = useState<FieldErrors<'email' | 'password'>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);
    const found = validateLogin({ email, password });
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);

    if (!mock) {
      try {
        await signInWithCredentials(email, password);
      } catch (cause) {
        setSubmitting(false);
        // The message is already written for a person: cognito.ts maps
        // Cognito's error codes, and session-service throws the API's
        // own refusal (a pool user with no `users` row, say). Anything
        // unrecognised is a bug, not something to dress up.
        setFormError(cause instanceof Error ? cause.message : 'Sign-in failed.');
        return;
      }
      router.replace(nextPath);
      return;
    }

    await sleep(650);
    const result = signIn(browserStore() ?? emptyStore(), email, password);
    if (!result.ok) {
      setSubmitting(false);
      setFormError(result.error);
      return;
    }
    startSession(result.user);
    router.replace(nextPath);
  }

  const query = nextPath === '/dashboard' ? '' : `?next=${encodeURIComponent(nextPath)}`;

  return (
    <AuthShell>
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
        <p className="text-sm text-muted-foreground">
          {mock
            ? 'Sign in to your CostHub workspace.'
            : 'Sign in with your work email and password.'}
        </p>
      </div>

      {justReset && (
        <p role="status" className="flex items-start gap-2 rounded-md bg-success/10 px-3 py-2.5 text-sm text-success">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Password reset complete (simulated). Sign in to continue.
        </p>
      )}

      <form onSubmit={(e) => void onSubmit(e)} className="space-y-4" noValidate>
        <FormField id="email" label="Work email" error={errors.email}>
          <Input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} {...fieldA11y('email', errors.email)} />
        </FormField>
        <PasswordField id="password" label="Password" value={password} onChange={setPassword} error={errors.password} autoComplete="current-password" />

        <div className="flex justify-end">
          <Link href="/forgot-password" className="text-xs font-medium text-ateneo hover:underline">Forgot password?</Link>
        </div>

        {formError && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{formError}</p>}

        <Button type="submit" size="lg" className="w-full" disabled={submitting}>
          {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {submitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      {/* No "create an account" link in live mode: the pool is
          allow_admin_create_user_only, so self-registration is refused
          by design and the page would be a dead end. */}
      {mock && (
        <p className="text-center text-sm text-muted-foreground">
          New here? <Link href={`/register${query}`} className="font-medium text-ateneo hover:underline">Create an account</Link>
        </p>
      )}

      {!mock && (
        <>
          <p className="text-center text-sm text-muted-foreground">
            <Link
              href={`/login?otp=1${nextPath === '/dashboard' ? '' : `&next=${encodeURIComponent(nextPath)}`}`}
              className="font-medium text-ateneo hover:underline"
            >
              Sign in with an email code instead
            </Link>
          </p>
          <DemoNotice>
            Access is by invitation only, and only{' '}
            <code className="font-mono">@chryselys.com</code> addresses are accepted. Signing in
            grants no access to cost data by itself &mdash; a superadmin has to grant you an
            account first, and until then your dashboard is empty by design.
          </DemoNotice>
        </>
      )}

      {mock && (
      <div className="rounded-lg border border-dashed bg-muted/40 p-3.5 text-sm">
        <p className="font-medium">Demo credentials</p>
        <dl className="mt-2 space-y-1 text-xs">
          <div className="flex gap-2"><dt className="w-16 text-muted-foreground">Email</dt><dd><code className="rounded bg-muted px-1.5 py-0.5">{DEMO_CREDENTIALS.email}</code></dd></div>
          <div className="flex gap-2"><dt className="w-16 text-muted-foreground">Password</dt><dd><code className="rounded bg-muted px-1.5 py-0.5">{DEMO_CREDENTIALS.password}</code></dd></div>
        </dl>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => { setEmail(DEMO_CREDENTIALS.email); setPassword(DEMO_CREDENTIALS.password); setErrors({}); setFormError(null); }}>
          Use demo credentials
        </Button>
      </div>

      )}

      {mock && (
        <DemoNotice>
          Authentication is simulated in your browser. No password is stored or sent anywhere. An account you register here signs in with any password that meets the policy.
        </DemoNotice>
      )}
    </AuthShell>
  );
}
