import type { Metadata } from 'next';
import { ProvidersView } from '@/components/providers/providers-view';

export const metadata: Metadata = { title: 'Providers' };

export default function Page() {
  return <ProvidersView />;
}
