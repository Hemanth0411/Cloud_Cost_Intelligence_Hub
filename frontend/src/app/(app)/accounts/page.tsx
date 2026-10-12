import type { Metadata } from 'next';
import { AccountsView } from '@/components/accounts/accounts-view';

export const metadata: Metadata = { title: 'Cloud accounts' };

export default function AccountsPage() {
  return <AccountsView />;
}
