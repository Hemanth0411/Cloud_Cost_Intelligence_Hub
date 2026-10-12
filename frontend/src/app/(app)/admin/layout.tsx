import type { ReactNode } from 'react';
import { AdminProvider } from '@/components/admin/admin-context';

/**
 * AdminProvider is mounted HERE, not in the (app) layout.
 *
 * It used to wrap every page, which was free when the data came from a
 * mock module and is not free now: each mount reads /admin/users,
 * /admin/grants, /admin/audit and /meta/accounts. On the dashboard
 * nothing consumes any of it, and for a non-superadmin all three admin
 * calls return 403 -- so every page view cost three refused requests to
 * populate a context nothing on that page reads.
 *
 * Scoping it to /admin/* is safe because every consumer of `useAdmin`
 * lives under this route. The sidebar's decision to show the admin
 * group comes from `useSession`, not from this provider.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminProvider>{children}</AdminProvider>;
}
