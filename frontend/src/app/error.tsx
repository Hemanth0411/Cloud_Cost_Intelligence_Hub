'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/shared/error-state';

/** Last-resort error boundary for pages outside the app shell (sign-in, register, ...). */
export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return <ErrorState fullPage onRetry={reset} />;
}
