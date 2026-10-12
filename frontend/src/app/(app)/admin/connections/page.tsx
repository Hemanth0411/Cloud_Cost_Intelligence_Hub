import type { Metadata } from 'next';
import { AdminConnectionsView } from '@/components/admin/connections-view';

export const metadata: Metadata = { title: 'Cloud accounts' };

export default function AdminConnectionsPage() {
  return <AdminConnectionsView />;
}
