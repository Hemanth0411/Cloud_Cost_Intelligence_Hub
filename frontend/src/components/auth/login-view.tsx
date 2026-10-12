'use client';

import { CheckCircle2, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { fieldA11y, FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { DEMO_CREDENTIALS } from '@/lib/auth/constants';
import { startSession } from '@/lib/auth/session';
import { browserStore, emptyStore, signIn } from '@/lib/auth/store';
import { validateLogin, type FieldErrors } from '@/lib/auth/validation';
import { AuthShell, DemoNotice } from './auth-shell';
import { PasswordField } from './password-field';

/** Only allow same-site relative redirects. */
function safeNext(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/dashboard';
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function LoginView() {
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
