import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RegisterView } from '@/components/auth/register-view';

export const metadata: Metadata = { title: 'Create account' };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <RegisterView />
    </Suspense>
  );
}
