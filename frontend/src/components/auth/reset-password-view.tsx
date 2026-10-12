'use client';

import { CheckCircle2, Loader2, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { DEMO_CREDENTIALS } from '@/lib/auth/constants';
import { browserStore, checkResetToken, consumeResetToken, emptyStore } from '@/lib/auth/store';
import { maskEmail, validateReset, type FieldErrors } from '@/lib/auth/validation';
import { AuthShell, DemoNotice } from './auth-shell';
import { PasswordField } from './password-field';

type Phase = { kind: 'checking' } | { kind: 'bad'; reason: 'invalid' | 'expired' | 'used' } | { kind: 'ready'; email: string } | { kind: 'done'; email: string };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const BAD_COPY: Record<'invalid' | 'expired' | 'used', { title: string; body: string }> = {
  invalid: { title: 'This reset link is not valid', body: 'It may have been replaced by a newer link, or it was opened in a different browser.' },
  expired: { title: 'This reset link has expired', body: 'Reset links work for 15 minutes. Request a new one to continue.' },
  used: { title: 'This reset link was already used', body: 'Each link works once. Request a new one if you still need to reset.' },
};

export function ResetPasswordView() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<FieldErrors<'password' | 'confirm'>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const check = checkResetToken(browserStore() ?? emptyStore(), token, Date.now());
    setPhase(check.status === 'valid' ? { kind: 'ready', email: check.email } : { kind: 'bad', reason: check.status });
  }, [token]);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (phase.kind !== 'ready') return;
    const found = validateReset({ password, confirm });
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    await sleep(700);
    // The token is consumed, but the new password is deliberately not saved anywhere.
    const result = consumeResetToken(browserStore() ?? emptyStore(), token, Date.now());
    setSubmitting(false);
    if (result.status === 'valid') setPhase({ kind: 'done', email: phase.email });
    else setPhase({ kind: 'bad', reason: result.status });
  }

  return (
    <AuthShell>
      {phase.kind === 'checking' && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Checking your reset link…</p>
      )}

      {phase.kind === 'bad' && (
        <>
          <div className="space-y-2">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-warning/15 text-warning"><TriangleAlert className="h-5 w-5" aria-hidden /></span>
            <h1 className="text-2xl font-semibold tracking-tight">{BAD_COPY[phase.reason].title}</h1>
            <p className="text-sm text-muted-foreground">{BAD_COPY[phase.reason].body}</p>
          </div>
          <Link href="/forgot-password" className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            Request a new link
          </Link>
        </>
      )}

      {phase.kind === 'ready' && (
        <>
          <div className="space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
            <p className="text-sm text-muted-foreground">For <strong className="font-medium text-foreground">{maskEmail(phase.email)}</strong></p>
          </div>
          <form onSubmit={(e) => void onSubmit(e)} className="space-y-4" noValidate>
            <PasswordField id="rp-password" label="New password" value={password} onChange={setPassword} error={errors.password} autoComplete="new-password" showStrength hint="At least 8 characters with a letter and a number." />
            <PasswordField id="rp-confirm" label="Confirm new password" value={confirm} onChange={setConfirm} error={errors.confirm} autoComplete="new-password" />
            <Button type="submit" size="lg" className="w-full" disabled={submitting}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {submitting ? 'Updating…' : 'Reset password'}
            </Button>
          </form>
        </>
      )}

      {phase.kind === 'done' && (
        <>
          <div className="space-y-2">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-success/15 text-success"><CheckCircle2 className="h-5 w-5" aria-hidden /></span>
            <h1 className="text-2xl font-semibold tracking-tight">Password reset (simulated)</h1>
            <p className="text-sm text-muted-foreground">
              {phase.email.toLowerCase() === DEMO_CREDENTIALS.email
                ? `The built-in demo account always signs in with its documented password (${DEMO_CREDENTIALS.password}), so nothing changed for it.`
                : 'Your new password passed the checks. It was not saved: this demo accepts any policy-compliant password for registered accounts.'}
            </p>
          </div>
          <Link href="/login?reset=1" className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            Continue to sign in
          </Link>
        </>
      )}

      <DemoNotice>Simulated flow: no email was sent and no password is stored. The reset link is single-use and expires after 15 minutes.</DemoNotice>
    </AuthShell>
  );
}
