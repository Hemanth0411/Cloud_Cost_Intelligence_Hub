'use client';

import { KeyRound, Plus } from 'lucide-react';
import { Fragment, useState } from 'react';
import { ConnectDialog } from '@/components/accounts/connect-dialog';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { useAsyncData } from '@/hooks/use-async-data';
import { ApiError } from '@/lib/api/client';
import { formatDateTime } from '@/lib/format';
import {
  CONNECTION_CAPABILITIES,
  testConnection,
  type ProbeOutcome,
  ingestVerdict,
  latestRunByAccount,
  loadConnections,
  setConnectionEnabled,
  type ConnectionRow,
} from '@/lib/services/connection-service';
import { ABSENT } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { AdminState } from './admin-state';

/**
 * The operator's view: how each account is reached, and whether its
 * data is arriving. Deliberately not a second copy of /accounts, which
 * is the spend view.
 *
 * WHAT CHANGED AND WHY. This screen used to render the mock account
 * list in both modes and DERIVE the credential mode from a row's
 * position -- `modeFor(index)` returned `self` for the first row and
 * `assume_role` for every other one. In mock mode that is a
 * simulation; in live mode it was a fabrication sitting next to real
 * account names, and the one thing this project does not do is display
 * a value it does not have. It now reads `GET /admin/connections` and
 * prints the `credential_mode` the row actually carries.
 *
 * THERE IS NO SYNC BUTTON, in either mode, and its absence is the
 * honest answer: ingest runs on an EventBridge schedule over
 * `cloud_connections` and no endpoint triggers it. The old button
 * animated a spinner and changed nothing. Enable and disable are the
 * two controls that do exist (FR-13), so they are the two offered.
 *
 * EVERY VALUE HERE IS A STORED ONE. "Last import" is
 * `last_ingest_at` / `last_ingest_status`, not a health probe -- nothing
 * in this app contacts a target account to ask whether it is reachable,
 * and a just-registered connection correctly reads "never" rather than
 * being drawn as broken.
 */

const MODE_LABEL: Record<string, string> = {
  self: 'Deploy account',
  assume_role: 'AssumeRole',
  profile: 'Local profile',
  secret: 'Service principal',
};

/**
 * `running` is NOT a failure. `ingest_runs.status` is
 * CHECK (status IN ('running','success','failed')) and `_start_run`
 * writes 'running' before the fetch, so an import in flight would
 * otherwise be painted red as a fault that has not happened.
 */
const STATUS_CLASS: Record<'ok' | 'failed' | 'running' | 'never', string> = {
  ok: 'text-success',
  failed: 'text-destructive',
  running: 'text-muted-foreground',
  never: 'text-muted-foreground',
};

function runStatusClass(status: string): string {
  if (status === 'success') return 'text-success';
  if (status === 'running') return 'text-muted-foreground';
  return 'text-destructive';
}

const MODE_HINT: Record<string, string> = {
  self: 'Read with the application’s own execution role. Nothing to configure.',
  assume_role: 'Short-lived credentials via STS, using an ExternalId. Needs a role in that account.',
  profile: 'A named CLI profile. Local development only.',
  secret: 'Client secret held in a secrets manager and read at call time.',
};

export function AdminConnectionsView() {
  const { toast } = useToast();
  const [reloadKey, setReloadKey] = useState(0);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, ProbeOutcome>>({});
  const state = useAsyncData(`connections:${reloadKey}`, loadConnections);

  const ready = state.status === 'ready';
  const connections = ready ? state.data.connections : [];
  const runs = ready ? state.data.runs : [];
  const runsFailed = ready && state.data.runsFailed;
  const latestRun = latestRunByAccount(runs);
  const reload = (): void => setReloadKey((n) => n + 1);

  /**
   * A 403 here is the access control WORKING -- /admin/* is
   * superadmin-only -- so it is explained, not alarmed about, and
   * offered no retry. `AdminState` is the same component the users and
   * audit screens use; this screen rendering its own red panel with a
   * "Try again" button that re-asks a settled question was the odd one
   * out.
   */
  const error =
    state.status === 'error'
      ? {
          message: state.message,
          forbidden: state.error instanceof ApiError && state.error.forbidden,
        }
      : null;

  function runTest(row: ConnectionRow): void {
    setTestingId(row.id);
    testConnection(row.id)
      .then((outcome) => {
        setOutcomes((prev) => ({ ...prev, [row.id]: outcome }));
        // The stage is the actionable half, so it goes in the toast
        // rather than only in the row.
        toast({
          tone: outcome.ok ? 'success' : 'warning',
          title: outcome.ok ? `${row.displayName}: access works` : `${row.displayName}: ${outcome.stage.replace('_', ' ')}`,
          description: outcome.detail,
        });
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        toast({ tone: 'warning', title: 'Could not run the test', description: message });
      })
      .finally(() => setTestingId(null));
  }

  function toggle(row: ConnectionRow): void {
    setBusyId(row.id);
    setConnectionEnabled(row.id, !row.enabled)
      .then(() => {
        toast({
          tone: row.enabled ? 'warning' : 'success',
          title: `${row.displayName} ${row.enabled ? 'disabled' : 'enabled'}`,
          description: row.enabled
            ? 'Scheduled imports will skip it. Nothing already imported is removed.'
            : 'It will be included in the next scheduled import.',
        });
        reload();
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        toast({ tone: 'warning', title: 'Could not change that', description: message });
      })
      .finally(() => setBusyId(null));
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cloud accounts"
        description="How each account is reached, and whether its cost data is arriving."
        actions={
          /* Disabled until the list has actually loaded. The dialog's
             duplicate warning is derived from `connections`, and an
             empty array reads as "nothing is registered" -- so opening
             this early would turn the warning off at exactly the moment
             it matters, and the POST is an upsert that silently rotates
             a live connection's ExternalId. */
          <Button onClick={() => setAdding(true)} disabled={!ready}>
            <Plus className="mr-2 h-4 w-4" aria-hidden />
            Add cloud account
          </Button>
        }
      />

      <AdminState loading={state.status === 'loading'} error={error} subject="cloud accounts" onRetry={reload} />

      {ready && (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" aria-hidden />
            No credential is ever stored here
          </CardTitle>
          <CardDescription>
            An AssumeRole connection holds a role ARN and an ExternalId &mdash; never a key.
            Both are shown in full: the ExternalId is not a password, it is the value the other
            account&rsquo;s trust policy must contain, so you need to be able to read it back and
            re-send it. Adding an account needs no infrastructure change on this side; the
            permission to assume a <code className="font-mono text-xs">CostHubCostReader</code>{' '}
            role is already granted for any AWS account.
            {!CONNECTION_CAPABILITIES.canToggleEnabled &&
              ' The rows below are sample data shaped like that response — mock mode calls no API.'}
          </CardDescription>
        </CardHeader>
      </Card>
      )}

      {ready && (
      <Card>
        <CardHeader>
          <CardTitle>Registered connections</CardTitle>
          <CardDescription>
            Imports run on a schedule; there is no on-demand trigger, so &ldquo;last import&rdquo; is
            the stored outcome of the last scheduled run and not a live check.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {(
            <Table className="min-w-[860px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Credential mode</TableHead>
                  <TableHead>ExternalId</TableHead>
                  <TableHead>Last import</TableHead>
                  {CONNECTION_CAPABILITIES.canToggleEnabled && (
                    <TableHead className="text-right">Actions</TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {connections.length === 0 && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell
                      colSpan={CONNECTION_CAPABILITIES.canToggleEnabled ? 6 : 5}
                      className="py-12 text-center text-sm text-muted-foreground"
                    >
                      No cloud account is registered yet. &ldquo;Add cloud account&rdquo; writes the
                      first one.
                    </TableCell>
                  </TableRow>
                )}
                {connections.map((row) => {
                  const verdict = ingestVerdict(row);
                  const run = latestRun.get(`${row.provider}|${row.accountId}`);
                  const mainRow = (
                    <TableRow key={row.id} className={row.enabled ? undefined : 'opacity-60'}>
                      <TableCell>
                        <span className="block text-sm font-medium">{row.displayName}</span>
                        <span className="block font-mono text-xs text-muted-foreground">
                          {row.accountId}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm uppercase">{row.provider}</TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          title={MODE_HINT[row.credentialMode] ?? 'Unrecognised credential mode.'}
                        >
                          {MODE_LABEL[row.credentialMode] ?? row.credentialMode}
                        </Badge>
                        {row.roleArn && (
                          <span className="mt-1 block break-all font-mono text-[10px] text-muted-foreground">
                            {row.roleArn}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {row.externalId === 'set' ? (
                          <Badge variant="outline">set</Badge>
                        ) : (
                          <span className="text-muted-foreground">{ABSENT}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {verdict === 'never' ? (
                          <span className="text-muted-foreground">
                            never — no import has run against it
                          </span>
                        ) : (
                          <>
                            <span className={cn('font-medium', STATUS_CLASS[verdict])}>
                              {row.lastIngestStatus}
                            </span>
                            {/* Absolute, not relative. `formatRelative`
                                needs a "now", and the only clock this app
                                has is the demo clock -- anchored to
                                12 Oct 2026 -- which would misreport a real
                                timestamp by however far reality has moved. */}
                            <span className="block text-muted-foreground">
                              {row.lastIngestAt ? formatDateTime(row.lastIngestAt) : ABSENT}
                            </span>
                            {run?.error && (
                              <span className="mt-0.5 block break-words text-destructive">
                                {run.error}
                              </span>
                            )}
                          </>
                        )}
                      </TableCell>
                      {CONNECTION_CAPABILITIES.canToggleEnabled && (
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            {CONNECTION_CAPABILITIES.canTest && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={testingId === row.id}
                                onClick={() => runTest(row)}
                                title="Assume the role and make one Cost Explorer call now"
                              >
                                {testingId === row.id ? 'Testing…' : 'Test'}
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busyId === row.id}
                              onClick={() => toggle(row)}
                            >
                              {busyId === row.id ? '…' : row.enabled ? 'Disable' : 'Enable'}
                            </Button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                  const outcome = outcomes[row.id];
                  if (!outcome) return mainRow;
                  return (
                    <Fragment key={`${row.id}-tested`}>
                      {mainRow}
                      {/* The detail stays on screen after the toast has
                          gone: it names which of the three prerequisites
                          is missing, and that is the thing somebody has
                          to copy into an email. */}
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={6} className="bg-muted/30 text-xs">
                          <span
                            className={cn(
                              'font-medium',
                              outcome.ok ? 'text-success' : 'text-warning',
                            )}
                          >
                            {outcome.ok ? 'Test passed' : `Test failed at: ${outcome.stage.replace('_', ' ')}`}
                          </span>
                          <span className="mt-0.5 block text-muted-foreground">{outcome.detail}</span>
                          {outcome.sample && outcome.sample.length > 0 && (
                            <span className="mt-1 block text-muted-foreground">
                              Read from this account: {outcome.sample.join(', ')}
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      )}

      {ready && (
      <Card>
        <CardHeader>
          <CardTitle>Recent imports</CardTitle>
          <CardDescription>
            {runsFailed
              ? 'The import history could not be read. The connections above loaded normally.'
              : runs.length === 0
                ? 'No import has been recorded yet.'
                : CONNECTION_CAPABILITIES.canToggleEnabled
                  ? 'From ingest_runs — one row per connection per run, with whatever error it recorded.'
                  : 'Sample rows, shaped like ingest_runs. Mock mode calls no API.'}
          </CardDescription>
        </CardHeader>
        {runs.length > 0 && (
          <CardContent className="px-0 pb-0">
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Window</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell className="text-xs">{formatDateTime(run.startedAt)}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {run.provider}/{run.accountId}
                    </TableCell>
                    <TableCell className="text-xs">{run.source}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {run.periodStart} … {run.periodEnd}
                    </TableCell>
                    <TableCell className="text-xs">
                      <span className={cn('font-medium', runStatusClass(run.status))}>
                        {run.status}
                      </span>
                      {run.error && (
                        <span className="block break-words text-destructive">{run.error}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-xs">
                      {run.rowsWritten ?? ABSENT}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        )}
      </Card>
      )}

      {/* Mounted only while open. The form state and the one-time
          ExternalId then live exactly as long as the dialog does,
          instead of being reset by an effect that runs a frame after
          the portal has already painted the previous session's values. */}
      {adding && (
        <ConnectDialog
          open
          existing={connections}
          onClose={() => setAdding(false)}
          onRegistered={reload}
        />
      )}
    </div>
  );
}
