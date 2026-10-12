import type { Metadata } from 'next';
import { Suspense } from 'react';
import { MockOnlyRoute } from '@/components/auth/mock-only-route';
import { ForgotPasswordView } from '@/components/auth/forgot-password-view';

export const metadata: Metadata = { title: 'Forgot password' };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <MockOnlyRoute title="Password recovery">
        <ForgotPasswordView />
      </MockOnlyRoute>
    </Suspense>
  );
}
