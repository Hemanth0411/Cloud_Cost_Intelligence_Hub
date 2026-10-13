/**
 * Mock `cloud_connections` and `ingest_runs` rows.
 *
 * These exist so /admin/connections has something to render in mock
 * mode WITHOUT the view inferring anything. The screen it feeds used to
 * guess the credential mode from a row's position in the list
 * (`modeFor(index)`), which was invented data in live mode. The fix is
 * that the view now reads one field, `credentialMode`, and the two
 * modes differ only in where the rows come from -- so every value on
 * screen is a value its source actually stated.
 *
 * Shaped exactly like the API's response, not like the mock dataset:
 * the mode boundary belongs in `connection-service`, and a different
 * shape per mode would push it into the component.
 *
 * TWO RULES THESE ROWS OBEY, because mock must never show a capability
 * that cannot be real:
 *
 *  * ONLY PROVIDERS THAT CAN ACTUALLY BE READ. `ingest/sources.py`
 *    registers adapters for `aws` and `azure` and nothing else -- a GCP
 *    connection hits `NoAdapter`. So the mock estate's GCP accounts get
 *    no connection row; inventing a credential mode and a Secrets
 *    Manager ARN for them would advertise an ingest path that does not
 *    exist. They still appear on /accounts, which is a spend view.
 *  * ONLY STATUSES THE SYSTEM CAN WRITE. `ingest_runs.status` is
 *    CHECK (status IN ('running','success','failed')) and
 *    `runner.record_ingest` writes only 'success' or 'failed'. An
 *    earlier draft used 'partial', which no run can ever produce.
 *
 * The credential mode IS still derived from position for AWS, which is
 * what `modeFor(index)` used to do in the view. The difference that
 * matters is reachability: this runs under `isMock()` only, and the
 * live screen reads `credential_mode` off the API row.
 */
import { getDataset } from '@/lib/mock/dataset';
import type { ConnectionRow, IngestRunRow } from '@/lib/services/connection-service';
import type { MockAccount } from '@/types/domain';

/** Deterministic, so a demo looks the same every time it is opened. */
/* Plausible UUIDs, deterministic so mock renders identically every
   time. The API returns the real ExternalId now, so mock must model a
   VALUE -- it used to hardcode the literal 'set', which meant mock was
   the only mode where this column rendered as intended. */
const MOCK_EXTERNAL_IDS = [
  '7c1f2a84-5b03-4e19-9a62-0d8e4f1c3b57',
  'b4e9d2c1-8a77-4f30-91de-5c6a2b70e84f',
  '2f8a6b05-3c41-49ad-8e72-91b4d0f5a6c3',
] as const;

/** Providers `ingest/sources.py` has an adapter for. See the note above. */
const READABLE_PROVIDERS = new Set(['aws', 'azure']);

/**
 * The mock estate writes AWS ids for display -- `'4821-7730-1159'` --
 * and a dashed id is not an AWS account id. Interpolated into an ARN it
 * produces `arn:aws:iam::4821-7730-1159:role/...`, which is not a valid
 * ARN in any account. Stripping the separators yields the twelve digits
 * the real column holds, so the mock row is at least shaped like the
 * thing it stands in for.
 */
const awsAccountId = (externalId: string): string => externalId.replace(/\D/g, '');

/**
 * How each mock account would be reached if it were real.
 *
 * AWS: the first account stands in for the deploy account, read with
 * the app's own execution role; the rest are other accounts reached by
 * AssumeRole. Azure has no cross-cloud AssumeRole equivalent, so it is
 * a service principal held in Secrets Manager -- which is what
 * `credentials.py:azure_credentials` actually does.
 */
function modeOf(account: MockAccount, awsIndex: number): string {
  if (account.providerId === 'azure') return 'secret';
  return awsIndex === 0 ? 'self' : 'assume_role';
}

export function mockConnectionRows(): ConnectionRow[] {
  const ds = getDataset();
  let awsSeen = 0;
  return ds.accounts
    .filter((a) => READABLE_PROVIDERS.has(a.providerId))
    .map((account) => {
      const provider = ds.providerById.get(account.providerId);
      const awsIndex = account.providerId === 'aws' ? awsSeen++ : -1;
      const mode = modeOf(account, awsIndex);
      const status = provider?.status ?? 'disconnected';
      const isSelf = mode === 'self';
      const awsId = awsAccountId(account.externalId);
      return {
        id: `conn-${account.id}`,
        provider: account.providerId,
        accountId: isSelf ? 'self' : account.providerId === 'aws' ? awsId : account.externalId,
        displayName: account.name,
        credentialMode: mode,
        roleArn: mode === 'assume_role' ? `arn:aws:iam::${awsId}:role/CostHubCostReader` : null,
        externalId:
          mode === 'assume_role'
            ? MOCK_EXTERNAL_IDS[Math.max(awsIndex, 0) % MOCK_EXTERNAL_IDS.length]
            : null,
        profileName: null,
        secretArn:
          mode === 'secret'
            ? `arn:aws:secretsmanager:us-east-1:000000000000:secret:costhub/${account.id}`
            : null,
        enabled: status !== 'disconnected',
        lastIngestAt: status === 'disconnected' ? null : provider?.lastSyncedAt ?? null,
        // 'failed' and 'success' are the only two `record_ingest` writes.
        lastIngestStatus:
          status === 'disconnected' ? null : status === 'degraded' ? 'failed' : 'success',
      };
    });
}

/** One run per connected mock account, newest first. */
export function mockIngestRunRows(): IngestRunRow[] {
  const ds = getDataset();
  const end = ds.endDate;
  return mockConnectionRows()
    .filter((c) => c.enabled)
    .map((c, i) => ({
      id: `run-${c.id}`,
      // The adapter that would have produced it, per ingest/sources.py.
      source: c.provider === 'azure' ? 'azure_cm' : 'cost_explorer',
      provider: c.provider,
      accountId: c.accountId,
      periodStart: end,
      periodEnd: end,
      status: c.lastIngestStatus === 'failed' ? 'failed' : 'success',
      rowsWritten: 120 + i * 7,
      error: null,
      startedAt: c.lastIngestAt ?? `${end}T00:00:00Z`,
      finishedAt: c.lastIngestAt ?? `${end}T00:00:00Z`,
    }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
