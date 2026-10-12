import type { Metadata } from 'next';
import { Suspense } from 'react';
import { MockOnlyRoute } from '@/components/auth/mock-only-route';
import { RegisterView } from '@/components/auth/register-view';

export const metadata: Metadata = { title: 'Create account' };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <MockOnlyRoute title="Creating an account">
        <RegisterView />
      </MockOnlyRoute>
    </Suspense>
  );
}
