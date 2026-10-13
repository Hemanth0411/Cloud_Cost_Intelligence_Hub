'use client';

import { ArrowLeft, Loader2, Mail } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { fieldA11y, FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { browserStore, createResetToken, emptyStore, type ResetToken } from '@/lib/auth/store';
import { validateEmail } from '@/lib/auth/validation';
import { AuthShell, DemoNotice } from './auth-shell';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Sent {
  email: string;
  token: ResetToken | null;
}

export function ForgotPasswordView() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);

  async function request(address: string): Promise<void> {
    setSubmitting(true);
    await sleep(700);
    const token = createResetToken(browserStore() ?? emptyStore(), address, Date.now());
    setSent({ email: address.trim(), token });
    setSubmitting(false);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const problem = validateEmail(email);
    setError(problem ?? undefined);
    if (problem) return;
    await request(email);
  }

  return (
    <AuthShell>
      {sent === null ? (
        <>
          <div className="space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">Forgot your password?</h1>
            <p className="text-sm text-muted-foreground">Enter your email and we will show you a simulated reset link.</p>
          </div>
          <form onSubmit={(e) => void onSubmit(e)} className="space-y-4" noValidate>
            <FormField id="fp-email" label="Work email" error={error}>
              <Input id="fp-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} {...fieldA11y('fp-email', error)} />
            </FormField>
            <Button type="submit" size="lg" className="w-full" disabled={submitting}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {submitting ? 'Preparing link…' : 'Send reset link'}
            </Button>
          </form>
        </>
      ) : (
        <>
          <div className="space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">Check your inbox</h1>
            <p className="text-sm text-muted-foreground" role="status">
              If an account exists for <strong className="font-medium text-foreground">{sent.email}</strong>, a reset link is on its way.
            </p>
          </div>

          {sent.token ? (
            <div className="overflow-hidden rounded-lg border">
              <div className="flex items-center justify-between gap-2 border-b bg-muted/50 px-4 py-2.5">
                <span className="flex items-center gap-2 text-sm font-medium"><Mail className="h-4 w-4" aria-hidden /> Simulated inbox</span>
                <Badge variant="warning">Demo only · no email was sent</Badge>
              </div>
              <div className="space-y-3 p-4 text-sm">
                <dl className="space-y-0.5 text-xs text-muted-foreground">
                  <div className="flex gap-2"><dt className="w-12">From</dt><dd>CostHub &lt;no-reply@costhub.demo&gt;</dd></div>
                  <div className="flex gap-2"><dt className="w-12">To</dt><dd>{sent.email}</dd></div>
                  <div className="flex gap-2"><dt className="w-12">Subject</dt><dd className="text-foreground">Reset your CostHub password</dd></div>
                </dl>
                <p>Use the button below within 15 minutes to choose a new password. If you did not ask for this, ignore it.</p>
                <Link href={`/reset-password?token=${sent.token.token}`} className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90">
                  Reset password
                </Link>
              </div>
            </div>
          ) : (
            <DemoNotice>
              Demo note: no simulated email was generated because <strong className="font-medium text-foreground">{sent.email}</strong> is not registered here. A real service shows this same message either way, so it never reveals which emails have accounts.
            </DemoNotice>
          )}

          <Button variant="outline" className="w-full" disabled={submitting} onClick={() => void request(sent.email)}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Resend link
          </Button>
        </>
      )}

      <Link href="/login" className="inline-flex items-center gap-1.5 text-sm font-medium text-ateneo hover:underline">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to sign in
      </Link>
      <DemoNotice>The reset flow is simulated. No email is sent and no password is stored; the link only works in this browser for 15 minutes.</DemoNotice>
    </AuthShell>
  );
}
