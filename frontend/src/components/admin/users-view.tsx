'use client';

import { ChevronDown, ChevronRight, KeyRound, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { Fragment, useState } from 'react';
import { useAdmin } from '@/components/admin/admin-context';
import { GrantDialog } from '@/components/admin/grant-dialog';
import { GrantList } from '@/components/admin/grant-list';
import { InviteDialog } from '@/components/admin/invite-dialog';
import { UserActions } from '@/components/admin/user-actions';
import { UserRemoveDialog } from '@/components/admin/user-remove-dialog';
import { UserRoleDialog } from '@/components/admin/user-role-dialog';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useDemoNow } from '@/hooks/use-demo-now';
import { formatRelative } from '@/lib/format';
import { visibleAccountCount } from '@/lib/services/admin-service';
import type { ManagedUser, UserStatus } from '@/types/domain';
import { AdminState } from './admin-state';

const STATUS_VARIANT: Record<UserStatus, 'success' | 'warning' | 'secondary'> = {
  active: 'success',
  invited: 'warning',
  disabled: 'secondary',
};

export function UsersView() {
  const { users, grants, accounts, grantsFor, revoke, loading, error, reload } = useAdmin();
  const now = useDemoNow();

  const [inviting, setInviting] = useState(false);
  const [granting, setGranting] = useState<ManagedUser | null>(null);
  const [changingRole, setChangingRole] = useState<ManagedUser | null>(null);
  const [removing, setRemoving] = useState<ManagedUser | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  // The accounts the API says exist, not the mock catalogue. In live
  // mode a grant has to name a real account id, so "visible / total"
  // has to be counted against the same list the grant dialog offers.
  const totalAccounts = accounts.length;

  const superadmins = users.filter((u) => u.role === 'superadmin').length;
  const withoutAccess = users.filter(
    (u) => u.role !== 'superadmin' && u.status !== 'disabled' && grantsFor(u.id).length === 0,
  ).length;

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

      <AdminState loading={loading} error={error} subject="users and grants" onRetry={reload} />

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
                        {/* The chevron is not decoration. The grants
                            panel -- and the only per-account revoke in
                            the product -- lives behind this toggle, and
                            with nothing but a bold name there was no
                            sign the row opened at all. */}
                        <button
                          type="button"
                          onClick={() => setExpanded(open ? null : user.id)}
                          className="flex items-start gap-1.5 text-left"
                          aria-expanded={open}
                        >
                          {open ? (
                            <ChevronDown
                              className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                              aria-hidden
                            />
                          ) : (
                            <ChevronRight
                              className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                              aria-hidden
                            />
                          )}
                          <span>
                            <span className="block text-sm font-medium">
                              {user.displayName ?? user.email}
                            </span>
                            {user.displayName && (
                              <span className="block text-xs text-muted-foreground">
                                {user.email}
                              </span>
                            )}
                          </span>
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
                        <UserActions
                          user={user}
                          onGrant={() => setGranting(user)}
                          onChangeRole={() => setChangingRole(user)}
                          onRemove={() => setRemoving(user)}
                        />
                      </TableCell>
                    </TableRow>
                    {open && (
                      <TableRow>
                        <TableCell colSpan={6} className="bg-muted/30">
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            {user.role === 'superadmin'
                              ? 'Superadmin — sees every account regardless of grants'
                              : 'Grants'}
                          </p>
                          {/* Says what Revoke does, because it takes one
                              account and reads like all of them. This is
                              the only control in the product that
                              removes a single account, and nothing on
                              screen stated its scope. */}
                          {user.role !== 'superadmin' && userGrants.length > 0 && (
                            <p className="mb-2 mt-1 text-xs text-muted-foreground">
                              Revoke removes access to that one account. Their other grants are
                              unaffected, and the revoked grant is kept with a timestamp.
                            </p>
                          )}
                          <GrantList grants={userGrants} now={now} onRevoke={revoke} />
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
      <UserRoleDialog user={changingRole} onClose={() => setChangingRole(null)} />
      <UserRemoveDialog user={removing} onClose={() => setRemoving(null)} />
    </div>
  );
}
