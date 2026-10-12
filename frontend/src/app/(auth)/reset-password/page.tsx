import type { Metadata } from 'next';
import { Suspense } from 'react';
import { MockOnlyRoute } from '@/components/auth/mock-only-route';
import { ResetPasswordView } from '@/components/auth/reset-password-view';

export const metadata: Metadata = { title: 'Reset password' };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <MockOnlyRoute title="Password reset">
        <ResetPasswordView />
      </MockOnlyRoute>
    </Suspense>
  );
}
