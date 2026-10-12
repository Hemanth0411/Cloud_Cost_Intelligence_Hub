'use client';

import { FileClock, ShieldAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAdmin } from '@/components/admin/admin-context';
import { AuditDiff } from '@/components/admin/audit-diff';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useDemoNow } from '@/hooks/use-demo-now';
import { formatDateTime, formatRelative } from '@/lib/format';
import type { AuditAction, AuditEntry } from '@/types/domain';
import { AdminState } from './admin-state';

type Variant = 'success' | 'warning' | 'destructive' | 'outline';

const ACTION_LABEL: Record<AuditAction, string> = {
  'user.invite': 'User invited',
  'user.disable': 'User disabled',
  'grant.create': 'Access granted',
  'grant.revoke': 'Access revoked',
  'connection.create': 'Account connected',
  'connection.update': 'Account updated',
  'connection.enable': 'Account enabled',
  'connection.disable': 'Account disabled',
  'anomaly.scan': 'Anomaly scan',
  'access.superadmin_bypass': 'Superadmin bypass',
};

const ACTION_VARIANT: Record<AuditAction, Variant> = {
  'user.invite': 'outline',
  'user.disable': 'warning',
  'grant.create': 'success',
  'grant.revoke': 'warning',
  'connection.create': 'success',
  'connection.update': 'outline',
  'connection.enable': 'success',
  'connection.disable': 'warning',
  'anomaly.scan': 'outline',
  'access.superadmin_bypass': 'destructive',
};

/**
 * `audit_log.action` is free-form text, so an action with no label here
 * is a real possibility rather than a type error. Showing the raw
 * action is strictly better than an empty badge, which reads as a
 * broken row instead of a missing translation.
 */
const labelFor = (action: string): string => ACTION_LABEL[action as AuditAction] ?? action;
const variantFor = (action: string): Variant => ACTION_VARIANT[action as AuditAction] ?? 'outline';

type Scope = 'all' | 'access' | 'bypass';

export function AuditView() {
  const { audit, loading, error, reload } = useAdmin();
  const now = useDemoNow();
  const [scope, setScope] = useState<Scope>('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const entries = useMemo(() => {
    const term = query.trim().toLowerCase();
    return audit.filter((e) => {
      if (scope === 'bypass' && e.action !== 'access.superadmin_bypass') return false;
      if (scope === 'access' && !e.action.startsWith('grant.')) return false;
      if (!term) return true;
      return (
        e.actor.toLowerCase().includes(term) ||
        e.action.toLowerCase().includes(term) ||
        JSON.stringify(e.after ?? {}).toLowerCase().includes(term)
      );
    });
  }, [audit, scope, query]);

  const bypasses = audit.filter((e) => e.action === 'access.superadmin_bypass').length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit log"
        description="Append-only. Every grant, revocation and superadmin bypass, with who did it and when."
      />

      <AdminState loading={loading} error={error} subject="the audit log" onRetry={reload} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-destructive" aria-hidden />
            Why superadmin bypasses are listed
          </CardTitle>
          <CardDescription>
            A superadmin reads cost data without any grant. That is deliberate, and it is recorded
            with the scope that was read — an unlogged bypass would be indistinguishable from a
            leak. {bypasses} recorded here.
          </CardDescription>
        </CardHeader>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedControl<Scope>
          ariaLabel="Filter audit entries by kind"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'all', label: 'Everything' },
            { value: 'access', label: 'Grants only' },
            { value: 'bypass', label: 'Bypasses', title: 'Superadmin reads outside any grant' },
          ]}
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by actor, action or account…"
          aria-label="Filter the audit log"
          className="sm:max-w-xs"
        />
      </div>

      <Card>
        <CardContent className="px-0 pb-0">
          {entries.length === 0 ? (
            <p className="px-6 py-10 text-center text-sm text-muted-foreground">
              Nothing matches that filter.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Entity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <AuditRow
                    key={entry.id}
                    entry={entry}
                    now={now}
                    open={open === entry.id}
                    onToggle={() => setOpen(open === entry.id ? null : entry.id)}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AuditRow({
  entry,
  now,
  open,
  onToggle,
}: {
  entry: AuditEntry;
  now: Date;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <TableRow>
        <TableCell className="whitespace-nowrap text-xs text-muted-foreground" title={formatDateTime(entry.at)}>
          {formatRelative(entry.at, now)}
        </TableCell>
        <TableCell className="text-sm">{entry.actor}</TableCell>
        <TableCell>
          <Badge variant={variantFor(entry.action)}>{labelFor(entry.action)}</Badge>
        </TableCell>
        <TableCell>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            <FileClock className="h-3.5 w-3.5" aria-hidden />
            {entry.entityType}
          </button>
        </TableCell>
      </TableRow>
      {open && (
        <TableRow>
          <TableCell colSpan={4} className="bg-muted/30">
            <AuditDiff before={entry.before} after={entry.after} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
