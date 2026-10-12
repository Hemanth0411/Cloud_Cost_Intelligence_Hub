import { hashString } from '@/lib/mock/seed';
import type { Account, AccountConnection, Connectivity, ProviderId } from '@/types/domain';

// ---- Connection details form (simulated: nothing is sent or stored) --------------------------------------------
export interface ConnectionField {
  key: string;
  label: string;
  placeholder: string;
  help: string;
}

export const CONNECTION_FIELDS: Record<ProviderId, readonly ConnectionField[]> = {
  aws: [{ key: 'roleArn', label: 'IAM role ARN', placeholder: 'arn:aws:iam::123456789012:role/CloudLensReadOnly', help: 'A read-only role that can read Cost Explorer data.' }],
  azure: [
    { key: 'tenantId', label: 'Tenant ID', placeholder: '00000000-0000-0000-0000-000000000000', help: 'Directory (tenant) ID of the Azure AD.' },
    { key: 'subscriptionId', label: 'Subscription ID', placeholder: '00000000-0000-0000-0000-000000000000', help: 'Subscription to import cost data from.' },
  ],
  gcp: [{ key: 'projectId', label: 'Project ID', placeholder: 'my-project-123', help: 'Project that hosts the billing export.' }],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AWS_ROLE_ARN = /^arn:aws:iam::\d{12}:role\/[\w+=,.@-]{1,64}$/;
const GCP_PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** Format checks only. Returns field -> error message (empty object means valid). */
export function validateConnectionDetails(providerId: ProviderId, details: Readonly<Record<string, string>>): Record<string, string> {
  const errors: Record<string, string> = {};
  const get = (k: string): string => (details[k] ?? '').trim();
  if (providerId === 'aws') {
    if (get('roleArn') === '') errors.roleArn = 'Role ARN is required';
    else if (!AWS_ROLE_ARN.test(get('roleArn'))) errors.roleArn = 'Use the form arn:aws:iam::<12-digit account>:role/<name>';
  } else if (providerId === 'azure') {
    for (const key of ['tenantId', 'subscriptionId']) {
      if (get(key) === '') errors[key] = 'This field is required';
      else if (!UUID.test(get(key))) errors[key] = 'Enter a valid GUID (8-4-4-4-12 hex)';
    }
  } else {
    if (get('projectId') === '') errors.projectId = 'Project ID is required';
    else if (!GCP_PROJECT.test(get('projectId'))) errors.projectId = '6-30 characters: lowercase letters, digits, hyphens; start with a letter';
  }
  return errors;
}

const uuidFrom = (seed: string): string => {
  const hex = [0, 1, 2, 3].map((i) => hashString(`${seed}:${i}`).toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

/** Valid example values so a demo can be completed in one click. */
export function sampleConnectionDetails(account: Pick<Account, 'id' | 'providerId' | 'externalId'>): Record<string, string> {
  if (account.providerId === 'aws') {
    const digits = account.externalId.replace(/\D/g, '').padEnd(12, '0').slice(0, 12);
    return { roleArn: `arn:aws:iam::${digits}:role/CloudLensReadOnly` };
  }
  if (account.providerId === 'azure') {
    return { tenantId: uuidFrom(`${account.id}:tenant`), subscriptionId: uuidFrom(`${account.id}:sub`) };
  }
  return { projectId: account.externalId.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30) };
}

// ---- Status roll-ups ----------------------------------------------------------------------------------------------
export function deriveProviderStatus(statuses: readonly Connectivity[]): Connectivity {
  if (statuses.length === 0) return 'disconnected';
  if (statuses.every((s) => s === 'disconnected')) return 'disconnected';
  if (statuses.some((s) => s === 'degraded' || s === 'disconnected')) return 'degraded';
  return 'connected';
}

export interface ConnectionSummary {
  healthy: number;
  degraded: number;
  disconnected: number;
  /** Accounts still syncing (healthy + degraded). This is the "connected accounts" number. */
  linked: number;
  providers: number;
  degradedProviders: number;
}

export function summarizeConnections(
  accounts: ReadonlyArray<{ id: string; providerId: ProviderId }>,
  statusOf: (accountId: string) => Connectivity,
): ConnectionSummary {
  let healthy = 0;
  let degraded = 0;
  let disconnected = 0;
  const byProvider = new Map<ProviderId, Connectivity[]>();
  for (const a of accounts) {
    const s = statusOf(a.id);
    if (s === 'connected') healthy += 1;
    else if (s === 'degraded') degraded += 1;
    else disconnected += 1;
    byProvider.set(a.providerId, [...(byProvider.get(a.providerId) ?? []), s]);
  }
  const providerStatuses = [...byProvider.values()].map(deriveProviderStatus);
  return {
    healthy,
    degraded,
    disconnected,
    linked: healthy + degraded,
    providers: byProvider.size,
    degradedProviders: providerStatuses.filter((s) => s === 'degraded').length,
  };
}

// ---- Persisted connection overrides ---------------------------------------------------------------------------------
const CONNECTIVITY: readonly string[] = ['connected', 'degraded', 'disconnected'];

/** Structural validation of the saved per-account connection overrides. */
export function parseConnectionOverrides(raw: unknown): Record<string, AccountConnection> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const out: Record<string, AccountConnection> = {};
  for (const [id, v] of Object.entries(raw)) {
    if (typeof v !== 'object' || v === null) continue;
    const c = v as Record<string, unknown>;
    if (typeof c.status === 'string' && CONNECTIVITY.includes(c.status) && typeof c.lastSyncedAt === 'string' && (c.changedAt === null || typeof c.changedAt === 'string')) {
      out[id] = { status: c.status as Connectivity, lastSyncedAt: c.lastSyncedAt, changedAt: c.changedAt };
    }
  }
  return out;
}
