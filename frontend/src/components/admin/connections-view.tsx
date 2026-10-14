'use client';

import { KeyRound, Plus } from 'lucide-react';
import { Fragment, useState } from 'react';
import { ConnectDialog } from '@/components/accounts/connect-dialog';
import { ConnectionDeleteDialog } from '@/components/admin/connection-delete-dialog';
import { ConnectionEditDialog } from '@/components/admin/connection-edit-dialog';
import { ConnectionImportDialog } from '@/components/admin/connection-import-dialog';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { useAsyncData } from '@/hooks/use-async-data';
import { ApiError } from '@/lib/api/client';
import {
  CREDENTIAL_MODE_HINT,
  CREDENTIAL_MODE_LABEL,
  type StoredCredentialMode,
} from '@/lib/aws-onboarding';
import { FIELD_LABEL, type ConnectionPatchBody } from '@/lib/connection-edits';
import { formatDateTime } from '@/lib/format';
import {
  CONNECTION_CAPABILITIES,
  importNow,
  isMissingConnection,
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
 * THE OLD SYNC BUTTON WAS REMOVED because it animated a spinner and
 * changed nothing -- no endpoint triggered ingest. "Import now" is its
 * honest replacement: it calls
 * `POST /admin/connections/{id}/import`, which runs the real ingest for
 * that one account and returns how many rows landed. It is offered in
 * live mode only, because an import that fetched nothing real would be
 * a lie about the one thing the button exists to prove.
 *
 * "Test" is the other new control, and the two answer different
 * questions: Test says whether access works and which prerequisite is
 * missing; Import says whether any data arrived.
 *
 * EDIT AND REMOVE COMPLETE THE SET. `PATCH` and `DELETE` existed,
 * deployed and tested, with no UI -- so "a mistyped role ARN is
 * unfixable without re-registering" stayed true from a browser and was
 * only answerable with curl. Both are live-mode only, like the other
 * two writes.
 *
 * EVERY VALUE IN THE TABLE IS A STORED ONE. "Last import" is
 * `last_ingest_at` / `last_ingest_status`, not a health probe, and a
 * just-registered connection correctly reads "never" rather than being
 * drawn as broken. TWO controls do reach the target account -- Test and
 * Import now -- and the difference is where their answers go. An import
 * writes `last_ingest_*`, so the table absorbs it. A test writes
 * nothing: its verdict lives in component state and is printed under the
 * row it was run on, because a live probe must never be mistaken for a
 * stored outcome.
 *
 * A ROW CAN BE STALE, and soft delete makes that ordinary. Two tabs,
 * one removes a connection, the other still shows it: every route on
 * this resource then answers 404, so each handler re-reads the list
 * instead of reporting a fault. The edit and remove dialogs are
 * addressed by ID and resolved out of the loaded rows, so a re-read that
 * no longer contains the row closes the dialog by itself.
 */

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

/**
 * The label and the hint come from `lib/aws-onboarding.ts`, which is
 * also what the add and edit dialogs' mode picker is built from. They
 * were duplicated here, and the copies had already drifted -- this one
 * described `profile` as "local development only" while the dialog that
 * creates one has to explain that the scheduled import cannot use it at
 * all.
 */
function modeLabel(mode: string): string {
  return CREDENTIAL_MODE_LABEL[mode as StoredCredentialMode] ?? mode;
}

function modeHint(mode: string): string {
  return CREDENTIAL_MODE_HINT[mode as StoredCredentialMode] ?? 'Unrecognised credential mode.';
}

/** A column name from the API's `changed` array, as the form labels it. */
function fieldLabel(column: string): string {
  return FIELD_LABEL[column as keyof ConnectionPatchBody] ?? column;
}

export function AdminConnectionsView() {
  const { toast } = useToast();
  const [reloadKey, setReloadKey] = useState(0);
  const [adding, setAdding] = useState(false);
  /* Both dialogs hold an ID, not a row. The row is resolved out of the
     loaded list on every render, so a reload that no longer contains it
     -- because it was removed here, or in another tab -- unmounts the
     dialog instead of leaving it editing a connection that is gone. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [importPickId, setImportPickId] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, ProbeOutcome>>({});
  const state = useAsyncData(`connections:${reloadKey}`, loadConnections);

  const ready = state.status === 'ready';
  const connections = ready ? state.data.connections : [];
  const runs = ready ? state.data.runs : [];
  const runsFailed = ready && state.data.runsFailed;
  const latestRun = latestRunByAccount(runs);
  const reload = (): void => setReloadKey((n) => n + 1);
  const editing = connections.find((c) => c.id === editingId) ?? null;
  const removing = connections.find((c) => c.id === removingId) ?? null;
  const importPick = connections.find((c) => c.id === importPickId) ?? null;

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

  /**
   * One place for "the row on screen is no longer there".
   *
   * Every route on this resource answers 404 when the id does not match
   * a live row, which soft delete makes a normal thing rather than a
   * fault: another tab removed it, or this tab has been open since
   * before someone else did. Re-reading is the whole fix -- reporting
   * "could not run the test" would be blaming the test for a row that
   * does not exist.
   */
  function stale(): void {
    toast({
      tone: 'warning',
      title: 'That connection no longer exists',
      description:
        'It was removed somewhere else, so nothing was changed. The list has been re-read.',
    });
    reload();
  }

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
        if (isMissingConnection(cause)) {
          stale();
          return;
        }
        const message = cause instanceof Error ? cause.message : String(cause);
        toast({ tone: 'warning', title: 'Could not run the test', description: message });
      })
      .finally(() => setTestingId(null));
  }

  function runImport(row: ConnectionRow, days: number): void {
    setImportingId(row.id);
    importNow(row.id, days)
      .then((outcome) => {
        toast({
          tone: outcome.ok ? 'success' : 'warning',
          title: outcome.ok
            ? `${row.displayName}: imported ${outcome.rows} row(s)`
            : `${row.displayName}: import failed`,
          description: outcome.detail,
        });
        // Re-read so "last import" and the run list reflect what just
        // happened, rather than the previous scheduled run.
        reload();
      })
      .catch((cause: unknown) => {
        if (isMissingConnection(cause)) {
          stale();
          return;
        }
        const message = cause instanceof Error ? cause.message : String(cause);
        toast({
          tone: 'warning',
          title: 'Could not run the import',
          description: `${message} If this timed out, the run may still be recorded below as "running".`,
        });
        reload();
      })
      .finally(() => setImportingId(null));
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
        if (isMissingConnection(cause)) {
          stale();
          return;
        }
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
            No credential is stored in this database
          </CardTitle>
          <CardDescription>
            An AssumeRole connection holds a role ARN and an ExternalId &mdash; no key exists to
            store. Both are shown in full: the ExternalId is not a password, it is the value the
            other account&rsquo;s trust policy must contain, so you need to be able to read it
            back and re-send it. Adding an account that way needs no infrastructure change on
            this side; the permission to assume a{' '}
            <code className="font-mono text-xs">CostHubCostReader</code> role is already granted
            for any AWS account, and it is the mode to prefer.
            <br />
            <br />
            An <strong className="font-medium">access key</strong> connection is the fallback for
            when nobody in the target account will create that role. The key you type goes to AWS
            Secrets Manager and this table stores only the ARN &mdash; the{' '}
            <code className="font-mono text-xs">secret_arn</code> column, which is a pointer and
            not a credential. The key itself is never written to Postgres, never put in the audit
            log, and never returned by any endpoint, so CostHub shows it exactly once: while you
            are typing it. Removing the connection deletes the secret.
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
            Imports run on a schedule at 06:00 UTC, and &ldquo;Import now&rdquo; runs one
            immediately for a single account, over a window of up to 31 days you choose; older
            history is a CLI backfill, and the dialog gives the command. &ldquo;Last import&rdquo; is the stored outcome of
            whichever ran most recently &mdash; not a live health check.
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
                        <Badge variant="outline" title={modeHint(row.credentialMode)}>
                          {modeLabel(row.credentialMode)}
                        </Badge>
                        {row.credentialMode === 'profile' && (
                          /* Not decoration. A profile connection cannot
                             be read by anything that runs server-side,
                             which is every path that reaches it from
                             here and the 06:00 UTC schedule as well, so
                             the row needs to carry that rather than
                             looking like any other connection that
                             happens to keep failing. */
                          <span className="mt-1 block text-[10px] text-warning">
                            Local only — the scheduled import runs in a Lambda,
                            which has no AWS CLI profiles. Test and Import now run wherever
                            the API runs, never in this browser.
                          </span>
                        )}
                        {row.roleArn && (
                          <span className="mt-1 block break-all font-mono text-[10px] text-muted-foreground">
                            {row.roleArn}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {row.externalId ? (
                          /* The real value, shown in full and selectable.
                             It has to be re-sendable: the other account's
                             trust policy must contain this exact string,
                             and getting it wrong is an AccessDenied that
                             looks like their mistake. This cell rendered
                             "—" for a while after the API stopped
                             redacting, because it still tested for the
                             old literal 'set'. */
                          <code className="select-all break-all font-mono text-[11px]">
                            {row.externalId}
                          </code>
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
                            {CONNECTION_CAPABILITIES.canImport && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={importingId === row.id || !row.enabled}
                                /* Opens a window picker rather than firing.
                                   With no `days` the route's default of 7
                                   applied to every manual import, so a new
                                   account showed one week as its 30-day,
                                   month-to-date AND year-to-date total. */
                                onClick={() => setImportPickId(row.id)}
                                title={
                                  row.enabled
                                    ? 'Choose a window of up to 31 days and fetch it from this account now'
                                    : 'Disabled connections are skipped by imports'
                                }
                              >
                                {importingId === row.id ? 'Importing…' : 'Import now…'}
                              </Button>
                            )}
                            {CONNECTION_CAPABILITIES.canTest && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={testingId === row.id}
                                onClick={() => runTest(row)}
                                title={
                                  /* AssumeRole is a stage the probe runs
                                     only for an assume_role row --
                                     `probe.py` goes straight to the cost
                                     call for `self` and `profile`. The
                                     tooltip described work that does not
                                     happen on two of the four modes. */
                                  row.credentialMode === 'assume_role'
                                    ? 'Assume the role and make one Cost Explorer call now'
                                    : "Resolve this connection's credentials and make one Cost Explorer call now"
                                }
                              >
                                {testingId === row.id ? 'Testing…' : 'Test'}
                              </Button>
                            )}
                            {CONNECTION_CAPABILITIES.canEdit && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setEditingId(row.id)}
                                title="Correct the name, credential mode, role ARN or ExternalId"
                              >
                                Edit
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
                            {CONNECTION_CAPABILITIES.canDelete && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive hover:bg-destructive/10"
                                onClick={() => setRemovingId(row.id)}
                                title="Stop importing from this account. Cost data already imported is kept."
                              >
                                Remove
                              </Button>
                            )}
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
                  {/* `default_window` returns an EXCLUSIVE end --
                      `today + 1` -- and the runner stores it verbatim,
                      so a run made today prints an end date of tomorrow.
                      The header says so rather than letting the column
                      read as an inclusive range over a day that has no
                      data in it. */}
                  <TableHead>Window (end exclusive)</TableHead>
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

      {editing && (
        <ConnectionEditDialog
          connection={editing}
          onClose={() => setEditingId(null)}
          onSaved={(changed) => {
            setEditingId(null);
            toast({
              tone: 'success',
              title: `${editing.displayName} updated`,
              // The field list comes from the API's own `changed`
              // array -- the server's account of what it wrote, not the
              // form's account of what it sent. Only the spelling is
              // ours: `display_name` is a column name, "Name" is what
              // the field is called on screen two inches above.
              description:
                changed.length > 0
                  ? `Changed: ${changed.map(fieldLabel).join(', ')}. Nothing else was touched.`
                  : 'Nothing changed.',
            });
            reload();
          }}
          onVanished={() => {
            setEditingId(null);
            stale();
          }}
        />
      )}

      {importPick && (
        <ConnectionImportDialog
          connection={importPick}
          onClose={() => setImportPickId(null)}
          onImport={(days) => {
            setImportPickId(null);
            runImport(importPick, days);
          }}
        />
      )}

      {removing && (
        <ConnectionDeleteDialog
          connection={removing}
          onClose={() => setRemovingId(null)}
          onDeleted={(costDataKept) => {
            setRemovingId(null);
            toast({
              tone: 'success',
              title: `${removing.displayName} will no longer be imported`,
              description: costDataKept
                ? 'Cost data already imported is kept — it is keyed by account id, not by connection. The account leaves the account lists and filters; registering it again brings it back and resumes importing.'
                : 'The connection was removed.',
            });
            reload();
          }}
          onVanished={() => {
            setRemovingId(null);
            stale();
          }}
        />
      )}
    </div>
  );
}
