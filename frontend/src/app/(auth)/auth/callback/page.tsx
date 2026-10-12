import type { Metadata } from 'next';
import { Suspense } from 'react';
import { CallbackView } from '@/components/auth/callback-view';

export const metadata: Metadata = { title: 'Signing in' };

export default function AuthCallbackPage() {
  return (
    // useSearchParams needs a Suspense boundary: the authorization code
    // arrives in the query string, so this page cannot be prerendered.
    <Suspense fallback={null}>
      <CallbackView />
    </Suspense>
  );
}
