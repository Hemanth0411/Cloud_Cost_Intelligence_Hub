'use client';

import { RotateCcw, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ErrorStateProps {
  title?: string;
  message?: string;
  onRetry?: () => void;
  /** Fill the whole viewport (used outside the app shell). */
  fullPage?: boolean;
}

/** Friendly, honest error screen. Shows no stack traces to the user. */
/**
 * The default message says nothing about where the data lives.
 *
 * It used to end "Your demo data is safe: it is stored only in this
 * browser" -- reassuring and false on any screen reading the API,
 * and the one screen most likely to be showing this is the one whose
 * API call just failed.
 */
export function ErrorState({ title = 'Something went wrong', message = 'An unexpected error stopped this page from loading. Nothing was changed.', onRetry, fullPage }: ErrorStateProps) {
  return (
    <div role="alert" className={cn('flex flex-col items-center justify-center gap-4 p-3 text-center', fullPage ? 'min-h-screen bg-background' : 'min-h-[50vh]')}>
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/15 text-destructive">
        <TriangleAlert className="h-6 w-6" aria-hidden />
      </span>
      <div className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mx-auto max-w-md text-sm text-muted-foreground">{message}</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {onRetry && (
          <Button onClick={onRetry}>
            <RotateCcw className="h-4 w-4" aria-hidden /> Try again
          </Button>
        )}
        <Link href="/dashboard" className={cn(buttonVariants({ variant: 'outline' }))}>Back to dashboard</Link>
      </div>
    </div>
  );
}
