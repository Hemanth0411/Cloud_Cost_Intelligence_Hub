import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ForgotPasswordView } from '@/components/auth/forgot-password-view';

export const metadata: Metadata = { title: 'Forgot password' };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <ForgotPasswordView />
    </Suspense>
  );
}
