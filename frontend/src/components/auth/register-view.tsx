'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { fieldA11y, FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { startSession } from '@/lib/auth/session';
import { browserStore, registerUser } from '@/lib/auth/store';
import { validateRegistration, type FieldErrors } from '@/lib/auth/validation';
import { AuthShell, DemoNotice } from './auth-shell';
import { PasswordField } from './password-field';

const ROLES = ['FinOps Analyst', 'Cloud Engineer', 'Finance Manager', 'Engineering Manager', 'Viewer'] as const;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function safeNext(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/dashboard';
}

export function RegisterView() {
  const router = useRouter();
  const nextPath = safeNext(useSearchParams().get('next'));

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>(ROLES[0]);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [errors, setErrors] = useState<FieldErrors<'name' | 'email' | 'password' | 'confirm' | 'terms'>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);
    const found = validateRegistration({ name, email, password, confirm, acceptedDemoTerms: accepted });
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    await sleep(750);
    const store = browserStore();
    if (!store) {
      setSubmitting(false);
      setFormError('Browser storage is unavailable, so a demo account cannot be created. Use the built-in demo credentials instead.');
      return;
    }
    // Only the profile is saved. The password is validated for format and then discarded.
    const result = registerUser(store, { name, email, role }, Date.now());
    if (!result.ok) {
      setSubmitting(false);
      setFormError(result.error);
      return;
    }
    startSession(result.user);
    router.replace(nextPath);
  }

  const loginHref = nextPath === '/dashboard' ? '/login' : `/login?next=${encodeURIComponent(nextPath)}`;

  return (
    <AuthShell>
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
        <p className="text-sm text-muted-foreground">Set up a demo workspace login. It takes a few seconds.</p>
      </div>

      <form onSubmit={(e) => void onSubmit(e)} className="space-y-4" noValidate>
        <FormField id="name" label="Full name" error={errors.name}>
          <Input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} {...fieldA11y('name', errors.name)} />
        </FormField>
        <FormField id="reg-email" label="Work email" error={errors.email}>
          <Input id="reg-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} {...fieldA11y('reg-email', errors.email)} />
        </FormField>
        <FormField id="role" label="Your role">
          <Select id="role" value={role} onChange={(e) => setRole(e.target.value)} className="h-10">
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
        </FormField>
        <PasswordField id="reg-password" label="Password" value={password} onChange={setPassword} error={errors.password} autoComplete="new-password" showStrength hint="At least 8 characters with a letter and a number." />
        <PasswordField id="reg-confirm" label="Confirm password" value={confirm} onChange={setConfirm} error={errors.confirm} autoComplete="new-password" />

        <div>
          <label className="flex items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              aria-invalid={errors.terms !== undefined}
              className="mt-0.5 h-4 w-4 rounded border-input accent-[hsl(var(--primary))]"
            />
            <span>I understand this is a demo: nothing is stored on a server and my password is not saved.</span>
          </label>
          {errors.terms && <p role="alert" className="mt-1.5 text-xs font-medium text-destructive">{errors.terms}</p>}
        </div>

        {formError && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{formError}</p>}

        <Button type="submit" size="lg" className="w-full" disabled={submitting}>
          {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {submitting ? 'Creating account…' : 'Create account'}
        </Button>
      </form>

      <p className="text-center text-sm text-muted-foreground">
        Already have an account? <Link href={loginHref} className="font-medium text-ateneo hover:underline">Sign in</Link>
      </p>
      <DemoNotice>Registration saves only your name, email and role in this browser. Passwords are checked for format and discarded.</DemoNotice>
    </AuthShell>
  );
}
