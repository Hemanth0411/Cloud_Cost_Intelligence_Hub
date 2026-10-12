'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useMode } from '@/hooks/use-mode';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { AuthShell } from './auth-shell';

/**
 * Register / forgot-password / reset-password are mock-only flows.
 *
 * They read and write `localStorage` and nothing else. In live mode
 * the user directory is a Cognito user pool, accounts are created by
 * an administrator through `POST /admin/users`, and password recovery
 * is Cognito's own. So these pages would present a working-looking
 * form that creates an account which cannot sign in to anything --
 * "a capability that cannot be real", reached by typing the URL.
 *
 * They are not deleted, because in mock mode they are a real part of
 * what the product looks like in use. They are closed off instead,
 * with the reason, and a link to the sign-in that does work.
 */
export function MockOnlyRoute({ title, children }: { title: string; children: ReactNode }) {
  const { mock, resolved } = useMode();

  // Render nothing decisive until the override has been read: these
  // pages are server-rendered and a mode-dependent first paint is a
  // hydration mismatch.
  if (!resolved) {
    return (
      <AuthShell>
        <div className="flex h-40 items-center justify-center" role="status" aria-label="Loading">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
        </div>
      </AuthShell>
    );
  }

  if (mock) return <>{children}</>;

  return (
    <AuthShell>
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">{title} is not available here</h1>
        <p className="text-sm text-muted-foreground">
          This deployment signs in through Amazon Cognito. Accounts are created by an administrator,
          and password recovery is handled on the Cognito sign-in page — not by this screen, which
          only ever worked against data stored in your own browser.
        </p>
        <Link href="/login" className={cn(buttonVariants(), 'w-full')}>
          Go to sign-in
        </Link>
      </div>
    </AuthShell>
  );
}
