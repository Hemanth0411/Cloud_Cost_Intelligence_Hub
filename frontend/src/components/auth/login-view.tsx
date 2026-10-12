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
import { USE_MOCK } from '@/lib/config';
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
 * replace it. So the live path is a hand-off.
 */
export function LoginView() {
  return USE_MOCK ? <MockLogin /> : <ManagedLoginHandoff />;
}

// --------------------------------------------------------------- live

function ManagedLoginHandoff() {
  const params = useSearchParams();
  const nextPath = safeNext(params.get('next'));
  /** Cognito reports a refused authorize request back here. */
  const cognitoError = params.get('error_description') ?? params.get('error');

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
    if (takeSignedOut() || cognitoError) return;
    go();
    // `go` is stable for the life of this component and intentionally
    // not a dependency: re-running this effect would restart sign-in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cognitoError]);

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

// --------------------------------------------------------------- mock

function MockLogin() {
  const router = useRouter();
  const params = useSearchParams();
  const nextPath = safeNext(params.get('next'));
  const justReset = params.get('reset') === '1';

  const [email, setEmail] = useState<string>(DEMO_CREDENTIALS.email);
  const [password, setPassword] = useState<string>(DEMO_CREDENTIALS.password);
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
        <p className="text-sm text-muted-foreground">Sign in to your CloudLens workspace.</p>
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
          <Link href="/forgot-password" className="text-xs font-medium text-primary hover:underline">Forgot password?</Link>
        </div>

        {formError && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{formError}</p>}

        <Button type="submit" size="lg" className="w-full" disabled={submitting}>
          {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {submitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      <p className="text-center text-sm text-muted-foreground">
        New here? <Link href={`/register${query}`} className="font-medium text-primary hover:underline">Create an account</Link>
      </p>

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

      <DemoNotice>
        Authentication is simulated in your browser. No password is stored or sent anywhere. An account you register here signs in with any password that meets the policy.
      </DemoNotice>
    </AuthShell>
  );
}
