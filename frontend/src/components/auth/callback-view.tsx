'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { completeSignIn } from '@/lib/services/session-service';
import { cn } from '@/lib/utils';
import { AuthShell } from './auth-shell';

/**
 * Where Cognito delivers the authorization code.
 *
 * Three things have to happen here and the order matters: exchange the
 * code for tokens, confirm with `GET /meta/me` that the API will accept
 * them, and only then replace the URL. The code is single-use, so
 * `exchanged` guards React strict mode's double effect -- without it
 * the second attempt redeems an already-spent code and the user sees
 * `invalid_grant` on a sign-in that actually worked.
 *
 * `router.replace` is what takes the code out of the address bar. Until
 * it runs the code sits in `window.location`, which is where
 * `document.referrer` and the browser's own history pick things up.
 */
export function CallbackView() {
  const router = useRouter();
  const params = useSearchParams();
  const code = params.get('code');
  const state = params.get('state');
  const cognitoError = params.get('error_description') ?? params.get('error');

  const [error, setError] = useState<string | null>(null);
  const exchanged = useRef(false);

  useEffect(() => {
    if (exchanged.current) return;
    exchanged.current = true;

    if (cognitoError) {
      setError(cognitoError);
      return;
    }
    if (!code) {
      setError('This page is only reachable from the sign-in screen.');
      return;
    }

    completeSignIn(code, state)
      .then((next) => router.replace(next))
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Sign-in could not be completed. Try again.',
        );
      });
  }, [code, state, cognitoError, router]);

  if (error) {
    return (
      <AuthShell>
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">Sign-in did not complete</h1>
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          If this says your account is not provisioned, you exist in the identity pool but not in
          CostHub&apos;s own user table — ask a superadmin to re-send the invite.
        </p>
        <Link href="/login" className={cn(buttonVariants(), 'w-full')}>
          Back to sign in
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden />
        <p role="status" className="text-sm text-muted-foreground">
          Completing sign-in…
        </p>
      </div>
    </AuthShell>
  );
}
