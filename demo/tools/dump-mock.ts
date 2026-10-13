/**
 * Dump the figures the video shows, straight out of the app's own
 * selectors.
 *
 * WHY: every number on screen has to be a number the product would
 * print. Re-deriving them here would let the video and the app drift,
 * and a video is the one artefact nobody re-checks. So this imports
 * `getDashboardData` -- the same function `/dashboard` calls -- and
 * writes its output to demo/src/data/mock.json.
 *
 * Run it FROM the frontend directory so tsx picks up that tsconfig's
 * `@/*` paths. It reads the frontend; it writes only into demo/.
 *
 *   cd frontend && npx tsx ../demo/tools/dump-mock.ts
 *
 * AWS ONLY, deliberately: the mock estate also carries Azure and
 * Google Cloud accounts, and the ingest side has no Google adapter at
 * all (`backend/costhub/ingest/sources.py`), so putting them on screen
 * would promise a provider that raises NoAdapter.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDataset } from '@/lib/mock/dataset';
import { getDashboardData } from '@/lib/selectors/dashboard';
import { mockGrants, mockUsers, mockAuditLog } from '@/lib/mock/admin';
import type { Filters } from '@/types/analytics';

const base: Filters = {
  range: '12m',
  customFrom: null,
  customTo: null,
  providerId: 'aws',
  accountId: 'all',
  serviceId: 'all',
};

const ds = getDataset();
const all = getDashboardData(ds, base);

/**
 * The narrowed view: one account, which is what one grant buys.
 *
 * This is NOT a free choice. `mockGrants()[0]` gives finance.lead a
 * grant on Prod Core Platform, and the video names that user, so the
 * account has to be the one the fixture actually granted them. An
 * earlier version picked Data Lake because the narrowing looked more
 * dramatic, which made the scene disagree with the data it cited.
 */
const GRANTED_ACCOUNT = 'aws-prod-core';
const granted = getDashboardData(ds, { ...base, accountId: GRANTED_ACCOUNT });

const round = (n: number) => Math.round(n * 100) / 100;
const series = (d: typeof all) =>
  d.series.month.map((p) => ({ start: p.start, aws: round(p.aws), total: round(p.total), partial: p.partial }));

const out = {
  generatedAt: new Date().toISOString(),
  source: 'frontend/src/lib/mock -- audited by `npm run verify:data` (3,940 checks)',
  datasetStart: ds.startDate,
  datasetEnd: ds.endDate,
  range: all.range,
  awsAccountCount: ds.accounts.filter((a) => a.providerId === 'aws').length,
  all: {
    total: round(all.kpis.totalSpend.value),
    avgDaily: round(all.kpis.totalSpend.avgDaily),
    deltaPct: all.kpis.totalSpend.deltaPct,
    servicesInUse: all.kpis.services.inUse,
    monthly: series(all),
    accounts: all.accounts.map((a) => ({
      id: a.accountId,
      name: a.name,
      environment: a.environment,
      team: a.team,
      region: a.region,
      externalId: a.externalId,
      cost: round(a.cost),
      sharePct: round(a.sharePct),
      monthlyBudget: a.monthlyBudget,
    })),
    services: all.breakdowns.service
      .filter((s) => s.providerId === 'aws')
      .map((s) => ({ label: s.label, cost: round(s.cost), sharePct: round(s.sharePct), deltaPct: s.deltaPct })),
  },
  granted: {
    accountId: GRANTED_ACCOUNT,
    accountName: granted.accounts[0]?.name ?? null,
    total: round(granted.kpis.totalSpend.value),
    servicesInUse: granted.kpis.services.inUse,
    monthly: series(granted),
    services: granted.breakdowns.service.map((s) => ({ label: s.label, cost: round(s.cost), sharePct: round(s.sharePct) })),
  },
  admin: {
    users: mockUsers().map((u) => ({ email: u.email, role: u.role, status: u.status })),
    grants: mockGrants().map((g) => ({
      user: g.userEmail,
      provider: g.providerId,
      account: g.accountName,
      service: g.serviceName,
      validUntil: g.validUntil,
      revokedAt: g.revokedAt,
      reason: g.reason,
    })),
    auditActions: mockAuditLog().length,
  },
};

const target = resolve(process.cwd(), '../demo/src/data/mock.json');
writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${target}`);
console.log(
  `aws 12m total=$${out.all.total} accounts=${out.all.accounts.length} services=${out.all.services.length} months=${out.all.monthly.length}`,
);
console.log(`granted(${out.granted.accountName}) total=$${out.granted.total} services=${out.granted.servicesInUse}`);
