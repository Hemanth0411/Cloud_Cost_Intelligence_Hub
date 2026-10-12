'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ErrorState } from '@/components/shared/error-state';
import { ensureFilterOptions } from '@/lib/services/cost-service';

/**
 * Nothing inside the app shell renders until the filter options are
 * in hand.
 *
 * WHY A GATE RATHER THAN A LOADING STATE PER COMPONENT: twelve places
 * read `getFilterOptions()` during render -- the URL filter parser,
 * the filter bar, `dashboardLink`, the breadcrumb's data date. The
 * parser is the one that forces the issue: it validates `?account=`
 * against the known accounts and resets it to "all" when it does not
 * recognise it. With an empty list every deep link would silently
 * lose its filters on the first paint and never recover, because
 * nothing re-parses the URL when the options arrive later.
 *
 * WHY IT ALSO GATES MOCK MODE: `isMock()` can differ between the
 * server render (build default) and the browser (localStorage
 * override), so anything whose output depends on the mode must not
 * decide it during the first client render. Showing the same
 * placeholder in both modes makes the server HTML and the first
 * hydrated tree identical by construction, which is cheaper to reason
 * about than auditing each consumer for mode-dependence.
 *
 * A 403 IS NOT AN ERROR HERE. `ensureFilterOptions` resolves with
 * empty options and records the restriction, so a correctly
 * authenticated user with no grants reaches the app and sees empty
 * screens with an explanation -- not a failure page.
 */
export function AppDataGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    ensureFilterOptions()
      .then(() => !cancelled && setState('ready'))
      .catch((cause: unknown) => {
        if (cancelled) return;
        setMessage(cause instanceof Error ? cause.message : String(cause));
        setState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === 'failed') {
    return (
      <div className="flex h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-lg">
          <ErrorState
            title="Could not load your accounts"
            message={message}
            onRetry={() => window.location.reload()}
          />
        </div>
      </div>
    );
  }

  if (state === 'loading') {
    return (
      <div
        className="flex h-screen items-center justify-center bg-background"
        role="status"
        aria-label="Loading"
      >
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </div>
    );
  }

  return <>{children}</>;
}
