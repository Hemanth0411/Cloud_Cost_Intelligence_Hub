'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/shared/error-state';

/** Error boundary inside the app shell: the sidebar and header stay usable when one page fails. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return <ErrorState onRetry={reset} />;
}
