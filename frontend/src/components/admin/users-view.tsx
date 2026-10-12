'use client';

import { KeyRound, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { Fragment, useState } from 'react';
import { useAdmin } from '@/components/admin/admin-context';
import { GrantDialog } from '@/components/admin/grant-dialog';
import { GrantList } from '@/components/admin/grant-list';
import { InviteDialog } from '@/components/admin/invite-dialog';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useDemoNow } from '@/hooks/use-demo-now';
import { formatRelative } from '@/lib/format';
import { visibleAccountCount } from '@/lib/services/admin-service';
import type { Grant, ManagedUser, UserStatus } from '@/types/domain';
import { AdminState } from './admin-state';

const STATUS_VARIANT: Record<UserStatus, 'success' | 'warning' | 'secondary'> = {
  active: 'success',
  invited: 'warning',
  disabled: 'secondary',
};

export function UsersView() {
  const { users, grants, accounts, grantsFor, revoke, disable, enable, loading, error, can } =
    useAdmin();
  const now = useDemoNow();

  const [inviting, setInviting] = useState(false);
  const [granting, setGranting] = useState<ManagedUser | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  // The accounts the API says exist, not the mock catalogue. In live
  // mode a grant has to name a real account id, so "visible / total"
  // has to be counted against the same list the grant dialog offers.
  const totalAccounts = accounts.length;

  const superadmins = users.filter((u) => u.role === 'superadmin').length;
  const withoutAccess = users.filter(
    (u) => u.role !== 'superadmin' && u.status !== 'disabled' && grantsFor(u.id).length === 0,
  ).length;

  function onRevoke(grant: Grant): void {
    revoke(grant.id, 'Revoked from the users screen');
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users & grants"
        description="Who can sign in, and exactly which accounts each of them can see."
        actions={
          <Button onClick={() => setInviting(true)} disabled={Boolean(error)}>
            <UserPlus className="mr-2 h-4 w-4" aria-hidden />
            Invite user
          </Button>
        }
      />

      <AdminState loading={loading} error={error} subject="users and grants" />

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiCard title="Users" value={String(users.length)} icon={Users} />
        <KpiCard title="Superadmins" value={String(superadmins)} icon={ShieldCheck} />
        <KpiCard
          title="Without any access"
          value={String(withoutAccess)}
          icon={KeyRound}
          tone={withoutAccess > 0 ? 'warning' : 'default'}
          hint="Invited, but cannot see any cost data yet"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>
            Access is per account, and optionally per service. A user with no grants sees an empty
            dashboard — that is the designed behaviour, not a fault.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Accounts visible</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => {
                // `userGrants` is this user's live grants, for the
                // expanded panel. `grants` is every grant, which is what
                // visibleAccountCount needs -- it does its own filtering,
                // and shadowing the name here hid that it was being
                // handed a pre-filtered list.
                const userGrants = grantsFor(user.id);
                const visible = visibleAccountCount(user, grants, totalAccounts);
                const open = expanded === user.id;
                return (
                  <Fragment key={user.id}>
                    <TableRow>
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => setExpanded(open ? null : user.id)}
                          className="text-left"
                          aria-expanded={open}
                        >
                          <span className="block text-sm font-medium">
                            {user.displayName ?? user.email}
                          </span>
                          {user.displayName && (
                            <span className="block text-xs text-muted-foreground">{user.email}</span>
                          )}
                        </button>
                      </TableCell>
                      <TableCell>
                        <Badge variant={user.role === 'superadmin' ? 'default' : 'outline'}>
                          {user.role}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[user.status]}>{user.status}</Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {user.role === 'superadmin' ? (
                          <span title="Superadmins bypass grants; every bypass is audited.">
                            all {totalAccounts}
                          </span>
                        ) : (
                          <>
                            {visible} / {totalAccounts}
                          </>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {user.lastSeenAt ? formatRelative(user.lastSeenAt, now) : 'never'}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button variant="outline" size="sm" onClick={() => setGranting(user)}>
                            Grant
                          </Button>
                          {/* No endpoint enables or disables a user, so in
                              live mode the control is absent rather than
                              present and broken. See CAPABILITIES. */}
                          {can.canSetUserStatus &&
                            (user.status === 'disabled' ? (
                              <Button variant="ghost" size="sm" onClick={() => enable(user.id)}>
                                Enable
                              </Button>
                            ) : (
                              <Button variant="ghost" size="sm" onClick={() => disable(user.id)}>
                                Disable
                              </Button>
                            ))}
                        </div>
                      </TableCell>
                    </TableRow>
                    {open && (
                      <TableRow>
                        <TableCell colSpan={6} className="bg-muted/30">
                          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            {user.role === 'superadmin'
                              ? 'Superadmin — sees every account regardless of grants'
                              : 'Grants'}
                          </p>
                          <GrantList grants={userGrants} now={now} onRevoke={onRevoke} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <InviteDialog open={inviting} onClose={() => setInviting(false)} />
      <GrantDialog user={granting} onClose={() => setGranting(null)} />
    </div>
  );
}
