'use client';

import { KeyRound, RefreshCw } from 'lucide-react';
import { useMemo } from 'react';
import { ConnectionBadge } from '@/components/accounts/connection-badge';
import { useConnections } from '@/components/connections/connections-context';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useDemoNow } from '@/hooks/use-demo-now';
import { formatRelative } from '@/lib/format';
import { getFilterOptions } from '@/lib/services/cost-service';
import { PROVIDER_SHORT_NAME } from '@/lib/theme';

/**
 * Deliberately NOT a second copy of /accounts.
 *
 * /accounts is the spend view: what each account costs, with connect and
 * disconnect actions. This one answers the operator's question instead --
 * how is each account reached, and is its data arriving. Same
 * connections-context, same ConnectionBadge, different column set.
 *
 * The credential mode is the interesting column. `self` needs nothing
 * configured; `assume_role` needs a CostHubCostReader role in the target
 * account, which is why adding an account is a conversation with whoever
 * owns it rather than a form submission.
 */
type CredentialMode = 'self' | 'assume_role' | 'profile' | 'secret';

const MODE_LABEL: Record<CredentialMode, string> = {
  self: 'Deploy account',
  assume_role: 'AssumeRole',
  profile: 'Local profile',
  secret: 'Service principal',
};

const MODE_HINT: Record<CredentialMode, string> = {
  self: 'Read with the application’s own execution role. Nothing to configure.',
  assume_role: 'Short-lived credentials via STS, using an ExternalId. Needs a role in that account.',
  profile: 'A named CLI profile. Local development only.',
  secret: 'Client secret held in a secrets manager and read at call time.',
};

/** Mirrors the deploy account being read with the app's own role. */
function modeFor(index: number): CredentialMode {
  return index === 0 ? 'self' : 'assume_role';
}

export function AdminConnectionsView() {
  const accounts = useMemo(() => getFilterOptions().accounts, []);
  const { connectionOf, sync, syncAll } = useConnections();
  const now = useDemoNow();

  const ids = accounts.map((a) => a.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cloud accounts"
        description="How each account is reached, and whether its cost data is arriving."
        actions={
          <Button variant="outline" onClick={() => syncAll(ids)}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
            Sync all
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" aria-hidden />
            No credential is ever stored here
          </CardTitle>
          <CardDescription>
            An AssumeRole connection holds a role ARN and an ExternalId — never a key. The ExternalId
            is write-only: the API returns it as <code className="font-mono text-xs">set</code> rather
            than the value, because it is one half of the cross-account trust and the role ARN is the
            other.
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardContent className="px-0 pb-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Credential mode</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last sync</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((account, index) => {
                const connection = connectionOf(account.id);
                const mode = modeFor(index);
                return (
                  <TableRow key={account.id}>
                    <TableCell>
                      <span className="block text-sm font-medium">{account.name}</span>
                      <span className="block font-mono text-xs text-muted-foreground">
                        {account.externalId}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">
                      {PROVIDER_SHORT_NAME[account.providerId]}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" title={MODE_HINT[mode]}>
                        {MODE_LABEL[mode]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <ConnectionBadge status={connection.status} syncing={connection.syncing} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {connection.status === 'disconnected'
                        ? '—'
                        : formatRelative(connection.lastSyncedAt, now)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={connection.syncing || connection.status === 'disconnected'}
                        onClick={() => sync(account.id)}
                      >
                        Sync
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Adding an account needs a <code className="font-mono">CostHubCostReader</code> role created in
        that account first, trusting this one with the ExternalId. No infrastructure change is needed
        on this side — the permission to assume that role name is already granted for any account.
      </p>
    </div>
  );
}
