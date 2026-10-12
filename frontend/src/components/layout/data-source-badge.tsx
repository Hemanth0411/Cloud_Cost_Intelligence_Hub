'use client';

import { Database, Lock, Radio } from 'lucide-react';
import { useDataStatus } from '@/hooks/use-data-status';
import { useMode } from '@/hooks/use-mode';
import { formatDateTime, formatRelative } from '@/lib/format';
import { useDemoNow } from '@/hooks/use-demo-now';
import { cn } from '@/lib/utils';

/**
 * What the numbers on screen actually are.
 *
 * THIS REPLACES A HARDCODED STRING. The sidebar footer read
 * "Mock dataset · no live cloud APIs" unconditionally, which made it
 * wrong in both directions at once: it reassured a demo audience
 * correctly, and it told anyone looking at real billing data that it
 * was fake.
 *
 * IN LIVE MODE IT SHOWS `as_of`, NOT "live". Cost data lags the
 * provider by 8-24 hours and is restated for days afterwards, so
 * anything implying real-time would be the same class of error with
 * the sign flipped. `as_of` is the finish time of the last successful
 * ingest, which every response envelope carries, and it is null until
 * one has run -- the state this deployment is in today, and worth
 * saying out loud rather than hiding behind a blank.
 */
export function DataSourceBadge({ variant }: { variant: 'sidebar' | 'header' }) {
  const { mock, resolved } = useMode();
  const { asOf, restricted } = useDataStatus();
  const now = useDemoNow();

  // Until the mode is resolved (one tick after mount) the honest
  // answer is nothing at all. Guessing here is what produces a
  // hydration mismatch, and a badge that flickers from "Mock" to
  // "Live" is worse than one that appears a frame late.
  if (!resolved) return <Shell variant={variant} icon={Database} tone="muted">Checking data source…</Shell>;

  if (mock) {
    return (
      <Shell variant={variant} icon={Database} tone="muted" title="Generated locally. No cloud API is contacted.">
        Mock dataset · no live cloud APIs
      </Shell>
    );
  }

  if (restricted) {
    return (
      <Shell variant={variant} icon={Lock} tone="warning" title="The API returned no rows for your grants.">
        Live API · no accounts granted
      </Shell>
    );
  }

  if (asOf === null) {
    return (
      <Shell variant={variant} icon={Radio} tone="warning" title="No ingest run has completed yet.">
        Live API · no data ingested yet
      </Shell>
    );
  }

  return (
    <Shell variant={variant} icon={Radio} tone="live" title={`Last successful ingest: ${formatDateTime(asOf)}`}>
      Live API · data as of {formatRelative(asOf, now)}
    </Shell>
  );
}

function Shell({
  variant,
  icon: Icon,
  tone,
  title,
  children,
}: {
  variant: 'sidebar' | 'header';
  icon: typeof Database;
  tone: 'muted' | 'warning' | 'live';
  title?: string;
  children: React.ReactNode;
}) {
  if (variant === 'header') {
    return (
      <div
        className="hidden items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground md:flex"
        title={title}
      >
        <Icon
          className={cn(
            'h-3 w-3',
            tone === 'live' && 'text-success',
            tone === 'warning' && 'text-warning',
          )}
          aria-hidden
        />
        {children}
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-2 rounded-md bg-white/10 px-2.5 py-2 text-xs text-sidebar-muted"
      title={title}
    >
      <Icon
        className={cn(
          'h-3.5 w-3.5 shrink-0',
          tone === 'live' && 'text-success',
          tone === 'warning' && 'text-warning',
        )}
        aria-hidden
      />
      <span>{children}</span>
    </div>
  );
}
