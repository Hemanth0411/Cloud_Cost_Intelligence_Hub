import type { Metadata } from 'next';
import { UsersView } from '@/components/admin/users-view';

export const metadata: Metadata = { title: 'Users & grants' };

export default function AdminUsersPage() {
  return <UsersView />;
}
