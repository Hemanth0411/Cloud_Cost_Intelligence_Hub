/**
 * Data-access facade for registered cloud accounts.
 *
 * Same contract as `cost-service` and `admin-service`: UI code talks to
 * this module, never to `fetch` or to the mock dataset directly, and
 * which mode it runs in is decided once per page load by `isMock()`.
 *
 * THE ENDPOINTS, LIVE -- all superadmin-only, enforced server-side,
 * all in `api/routes/connections.py`:
 *
 *   listConnections       -> GET    /admin/connections
 *   listIngestRuns        -> GET    /admin/ingest-runs
 *   registerConnection    -> POST   /admin/connections
 *   updateConnection      -> PATCH  /admin/connections/{id}
 *   deleteConnection      -> DELETE /admin/connections/{id}
 *   setConnectionEnabled  -> POST   /admin/connections/{id}/enabled?value=
 *   testConnection        -> POST   /admin/connections/{id}/test
 *   importNow             -> POST   /admin/connections/{id}/import?days=
 *
 * FOUR THINGS THE API DOES THAT THE UI HAS TO ACCOUNT FOR:
 *
 *  * `external_id` IS RETURNED IN FULL. It used to come back as the
 *    literal string `"set"`, and the reasoning -- one half of the
 *    cross-account trust, so do not emit it -- was reversed on purpose:
 *    an ExternalId is not a password but the value the OTHER account's
 *    trust policy must contain, so redacting it from a superadmin
 *    removed the one thing they have to distribute. Nothing redacts it
 *    now; `routes/connections.py` carries the full argument.
 *  * `POST /admin/connections` IS AN UPSERT, not an insert.
 *    `store.upsert` is `ON CONFLICT (provider, account_id) DO UPDATE`,
 *    so re-registering an account id that already exists silently
 *    REPLACES its credential columns and returns 201 either way. It also
 *    REVIVES a soft-deleted row (`deleted_at = NULL, enabled = true`).
 *    The dialog therefore has to tell the user which of the two is about
 *    to happen; the API cannot.
 *  * `PATCH` IS A PARTIAL UPDATE and means it. The body is read with
 *    `exclude_unset=True`, so an absent key leaves a column alone and an
 *    explicit `null` clears it. `lib/connection-edits.ts` builds the
 *    body from a diff for that reason -- a form that round-tripped the
 *    whole object would clear every field the user did not touch.
 *  * `DELETE` IS A SOFT DELETE and keeps the cost rows. It answers
 *    `cost_data_kept: true`, because `fact_cost_daily` is keyed by
 *    (provider, account_id) rather than by connection.
 *
 * IMPORT CAN BE TRIGGERED, and that is newer than most of this file.
 * `importNow` runs the real ingest for one connection inline and returns
 * how many rows landed; the EventBridge schedule at 06:00 UTC is no
 * longer the only way data arrives. Enable and disable remain the
 * lifecycle controls (FR-13).
 */
import { ApiError, del, getRows, patch, post } from '@/lib/api/client';
import { isMock } from '@/lib/mode';
import { registrationBody, type RegistrationDraft } from '@/lib/aws-onboarding';
import type { ConnectionPatchBody } from '@/lib/connection-edits';
import { mockConnectionRows, mockIngestRunRows } from '@/lib/mock/connection-rows';

/**
 * A row of `cloud_connections`, as the browser is allowed to see it.
 *
 * `externalId` is the REAL value now, not a marker. The API stopped
 * redacting it: an ExternalId is not a password, it is the value the
 * other account's trust policy must contain, so it has to be readable
 * and re-sendable. This type said `'set' | null` for a while after the
 * API changed, and the column rendered "—" for every connection that
 * had one -- directly under copy promising it was shown in full.
 * `getRows` is a bare cast, so tsc could not catch the lie.
 *
 * Previously: typed as the redacted marker rather than
 * a value: `'set' | null` makes it impossible to write a component that
 * tries to print the secret, because there is nothing to print.
 */
export interface ConnectionRow {
  id: string;
  provider: string;
  /** The cloud-native id, or the literal `'self'` for the deploy account. */
  accountId: string;
  displayName: string;
  credentialMode: string;
  roleArn: string | null;
  /** The real value, in full, or null when the row has none. */
  externalId: string | null;
  profileName: string | null;
  secretArn: string | null;
  enabled: boolean;
  lastIngestAt: string | null;
  lastIngestStatus: string | null;
}

export interface IngestRunRow {
  id: string;
  source: string;
  provider: string;
  accountId: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  rowsWritten: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** What this mode can actually do, so the UI offers only that. */
export const CONNECTION_CAPABILITIES = {
  /**
   * Connect / disconnect / sync on /accounts are a local simulation.
   * True only in mock mode; live mode has no such endpoint and the
   * column comes off rather than inventing a health state.
   */
  simulated: isMock(),
  /** `POST /admin/connections/{id}/enabled` exists in live mode only. */
  canToggleEnabled: !isMock(),
  /**
   * `POST /admin/connections/{id}/test` actually calls AWS, so it
   * cannot be simulated honestly -- a mock 'pass' would be the
   * opposite of what this button is for.
   */
  canTest: !isMock(),
  /**
   * `POST /admin/connections/{id}/import` actually calls Cost
   * Explorer and writes rows, so there is nothing honest to
   * simulate: a mock 'imported 11 rows' would be a lie about the
   * one thing the button exists to prove.
   */
  canImport: !isMock(),
  /**
   * `PATCH` and `DELETE` exist in live mode only, and are deliberately
   * NOT simulated. A mock edit would have to either mutate a derived
   * array that is rebuilt from the dataset on the next read -- so the
   * change vanishes and the screen lies about having saved -- or pretend
   * to persist something no store exists for. The actions column is
   * hidden wholesale in mock mode for the same reason.
   */
  canEdit: !isMock(),
  canDelete: !isMock(),
} as const;

// ------------------------------------------------------------- reads

export async function listConnections(): Promise<ConnectionRow[]> {
  if (isMock()) return mockConnectionRows();
  return getRows<ConnectionRow>('/admin/connections');
}

export async function listIngestRuns(limit = 20): Promise<IngestRunRow[]> {
  if (isMock()) return mockIngestRunRows();
  return getRows<IngestRunRow>('/admin/ingest-runs', { query: { limit } });
}

export interface ConnectionsSnapshot {
  connections: ConnectionRow[];
  runs: IngestRunRow[];
  /** The run history could not be read; the connections still could. */
  runsFailed: boolean;
}

/**
 * Both reads, but NOT coupled.
 *
 * `Promise.all` rejects on the first rejection, which meant a failing
 * `/admin/ingest-runs` emptied the connections table as well -- an
 * operator could not enable or disable anything because the IMPORT
 * HISTORY call failed. Worse, the screen then handed the dialog an
 * empty `existing` array, which silently disables its duplicate
 * warning (see `registerConnection`). The connection list is the
 * screen; the runs are an annotation on it, so only the former is
 * allowed to fail the whole read.
 */
export async function loadConnections(): Promise<ConnectionsSnapshot> {
  const [connectionsResult, runsResult] = await Promise.allSettled([
    listConnections(),
    listIngestRuns(),
  ]);
  if (connectionsResult.status === 'rejected') throw connectionsResult.reason;
  return {
    connections: connectionsResult.value,
    runs: runsResult.status === 'fulfilled' ? runsResult.value : [],
    runsFailed: runsResult.status === 'rejected',
  };
}

/**
 * The most recent run per `provider|account_id`.
 *
 * Keyed on the pair rather than on the connection id because
 * `ingest_runs.connection_id` is nullable (migration 004 added it to an
 * existing table) and the rows the API returns do not carry it at all.
 */
export function latestRunByAccount(runs: readonly IngestRunRow[]): Map<string, IngestRunRow> {
  const out = new Map<string, IngestRunRow>();
  for (const run of runs) {
    const key = `${run.provider}|${run.accountId}`;
    const held = out.get(key);
    if (!held || run.startedAt > held.startedAt) out.set(key, run);
  }
  return out;
}

// ------------------------------------------------------------ writes

export interface RegisterResult {
  /** Null in mock mode: nothing was created, so there is no id. */
  id: string | null;
  /** True when an existing (provider, account_id) row was replaced. */
  updated: boolean;
}

/**
 * Register an AWS account, or update the one already on that id.
 *
 * `existing` MUST be a loaded list. An empty array is indistinguishable
 * from "nothing is registered", so passing one that is merely not
 * loaded yet turns the duplicate warning off exactly when it matters --
 * the POST is an upsert, so the user is told they created something
 * while a live connection's ExternalId is rotated out from under it.
 * The caller gates the button on a resolved read for that reason.
 *
 * In mock mode nothing is sent anywhere -- the caller animates a
 * simulation and says so on screen. That asymmetry is the whole point
 * of the mode switch, and it is handled here rather than in the dialog
 * so the dialog has exactly one submit path.
 */
export async function registerConnection(
  draft: RegistrationDraft,
  existing: readonly ConnectionRow[],
): Promise<RegisterResult> {
  const body = registrationBody(draft);
  const updated = existing.some(
    (c) => c.provider === body.provider && c.accountId === body.account_id,
  );
  if (isMock()) return { id: null, updated };
  const response = await post<{ id: string }>('/admin/connections', body);
  return { id: response.id, updated };
}

/**
 * Correct a connection in place.
 *
 * `body` MUST be a diff -- see `lib/connection-edits.ts`. This function
 * does not build one, and deliberately does not accept a whole row:
 * there is no shape of `ConnectionRow` it could take without being able
 * to clear a field nobody edited.
 *
 * Two refusals are expected rather than exceptional, and both arrive as
 * an `ApiError` whose message is the server's own sentence:
 *
 *   400  the schema CHECK -- an `assume_role` row must keep a role ARN,
 *        and `display_name` / `credential_mode` cannot be null. This is
 *        the first half of "retype the ARN", so it is a normal thing to
 *        hit and the message names the rule.
 *   422  pydantic -- `display_name` of `''` fails `min_length=1`.
 *
 * Both must reach the user verbatim. A dialog that replaced either with
 * "could not save" would leave someone retyping the same value.
 */
export async function updateConnection(id: string, body: ConnectionPatchBody): Promise<string[]> {
  const response = await patch<{ id: string; changed: string[] }>(
    `/admin/connections/${encodeURIComponent(id)}`,
    body,
  );
  return response.changed;
}

export interface DeleteOutcome {
  deleted: boolean;
  /** Always true from this endpoint. Rendered, not assumed -- see below. */
  costDataKept: boolean;
}

/**
 * Stop importing from an account.
 *
 * SOFT, and the cost rows stay. `fact_cost_daily` is keyed by
 * (provider, account_id) and not by connection, so the history remains
 * readable and every chart is unchanged -- which is the opposite of what
 * the word "delete" suggests, so the confirmation says it and this
 * function returns the flag rather than hardcoding the claim in the
 * dialog.
 */
export async function deleteConnection(id: string): Promise<DeleteOutcome> {
  return del<DeleteOutcome>(`/admin/connections/${encodeURIComponent(id)}`);
}

/**
 * Did this fail because the connection is gone?
 *
 * Every route on this resource answers 404 for an id that no longer
 * matches a live row, and soft delete makes that ordinary: two tabs
 * open, one removes a connection, the other still has the row on screen
 * and clicks Test. The caller's job is then to re-read the list rather
 * than to report a fault -- the row on screen is simply stale.
 */
export function isMissingConnection(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 404;
}

export async function setConnectionEnabled(id: string, value: boolean): Promise<void> {
  if (isMock()) return;
  await post(`/admin/connections/${encodeURIComponent(id)}/enabled`, undefined, {
    query: { value },
  });
}

export interface ImportOutcome {
  ok: boolean;
  rows: number;
  window: [string, string];
  detail: string;
}

/**
 * Import from one account now, rather than waiting for 06:00 UTC.
 *
 * Runs inline on the server, so this can take several seconds and the
 * caller must show that it is working. It answers 200 with ok=false for
 * a failed import -- same contract as the test endpoint: the status says
 * the request ran, the body says what happened.
 */
export async function importNow(id: string, days = 7): Promise<ImportOutcome> {
  return post<ImportOutcome>(`/admin/connections/${encodeURIComponent(id)}/import`, undefined, {
    query: { days },
  });
}

/** The stage a failed test got to -- which decides who can fix it. */
export interface ProbeOutcome {
  ok: boolean;
  stage: 'credentials' | 'assume_role' | 'cost_explorer' | 'unsupported' | 'ok';
  detail: string;
  sample: string[] | null;
}

/**
 * Test a connection against the real account, now.
 *
 * The endpoint answers 200 whether or not the connection works: the
 * status says "the test ran", the body says "the connection is good".
 * So a non-ok body is NOT an error to throw -- it is the result, and the
 * caller renders it.
 */
export async function testConnection(id: string): Promise<ProbeOutcome> {
  return post<ProbeOutcome>(`/admin/connections/${encodeURIComponent(id)}/test`);
}

/**
 * Does this connection look reachable?
 *
 * Deliberately NOT a health check -- nothing probes the target account.
 * It reports only what the row says: whether ingest has ever succeeded
 * against it. `null` means no run has been recorded, which is the state
 * a just-registered account is in and must not be drawn as a failure.
 */
export function ingestVerdict(row: ConnectionRow): 'ok' | 'failed' | 'running' | 'never' {
  if (row.lastIngestStatus === null) return 'never';
  if (row.lastIngestStatus === 'success') return 'ok';
  // 'running' is a real state, not a failure: `ingest_runs.status` is
  // CHECK (status IN ('running','success','failed')) and `_start_run`
  // writes 'running' BEFORE fetching. Painting an in-flight import red
  // reports a fault that has not happened.
  if (row.lastIngestStatus === 'running') return 'running';
  return 'failed';
}
