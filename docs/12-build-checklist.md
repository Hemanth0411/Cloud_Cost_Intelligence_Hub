# Build checklist

Everything to be built, by area. `[x]` = done, `[ ]` = pending.
Size: **S** ≤2h, **M** ≤half a day, **L** ≤1 day.

Requirement ids refer to [01-requirements.md](01-requirements.md).

---

## 0. Prerequisites (external — start first, they have lead times)

| | Item | Owner | Blocks |
|---|---|---|---|
| [ ] | Postgres for dev — Neon project or local install | you | **everything** |
| [ ] | `git init` + remote (Amplify builds from a repo) | you | frontend deploy |
| [ ] | Decide the SES sender identity (domain you own, ideally) | you | login |
| [ ] | Verify SES sender + each recipient | you | login |
| [ ] | Personal account: enable Cost Explorer | you (root) | real data |
| [ ] | Personal account: activate cost allocation tags | you (root) | **not retroactive** |
| [ ] | Stemline: root enables billing-info IAM access | their root | stemline data |
| [ ] | Stemline: `CostHubCostReader` role created | their IAM admin | stemline data |
| [ ] | Azure subscription + Entra app registration | TBD | Azure data only |

None of these block starting the backend — `dev_seed` covers development.

---

## 1. Database and schema

| | Item | Size | Req |
|---|---|---|---|
| [x] | `001_core.sql` — users, identities, access_grants, audit_log | — | FR-4, FR-5 |
| [x] | `002_facts.sql` — ingest_runs, dims, fact_cost_daily | — | FR-14 |
| [x] | `003_alerts_anomaly.sql` — rules, events, findings | — | FR-31 |
| [x] | `004_connections.sql` — `cloud_connections` | S | FR-11–13 |
| [x] | `005_audit_append_only.sql` — statement triggers that RAISE on UPDATE/DELETE | S | NFR-4, TODO-10 |
| [x] | `migrate.py` runner | — | — |
| [x] | Run migrations against a real database | S | — |

---

## 2. Backend — core

| | Item | Size | Req |
|---|---|---|---|
| [x] | `config.py` — settings, `CostAccount` | — | — |
| [x] | `db.py` — transactional connect, fetch helpers | — | — |
| [x] | `audit.py` — append-only writer, shares caller's transaction | — | FR-36, FR-37 |
| [x] | `query/scoped.py` — the grant predicate, series/breakdown/compare | — | **NFR-1**, FR-18–22 |
| [x] | `rbac/admin.py` — invite, grant, revoke, list | — | FR-5–7, FR-10 |
| [x] | `rbac/resolve.py` — effective grants for a user, now | S | FR-34 |
| [x] | **Tests for `scoped.py`** — all 10 cases, fail-closed first | M | FR-8 |

The test suite is not optional padding. Every security claim in
[07-security-rbac.md](07-security-rbac.md) is only true if those ten tests
pass — in particular `test_no_grants_sees_nothing`.

---

## 3. Backend — connections and ingest

| | Item | Size | Req |
|---|---|---|---|
| [x] | `connections/store.py` — CRUD over `cloud_connections` | S | FR-11–13 |
| [x] | `connections/credentials.py` — `AssumeRole` / `self` / profile → boto3 session | M | FR-12 |
| [x] | `ingest/dev_seed.py` — generated rows, planted step/spike/creep | M | — |
| [x] | `ingest/cost_explorer.py` — CE adapter, DAILY, grouped by SERVICE | M | FR-14 |
| [x] | `ingest/runner.py` — per-connection loop, `ingest_runs` lineage, idempotent upsert | M | FR-15–17 |
| [x] | backfill — `cli.py:cmd_backfill`, month-chunked with a 400-day floor (not a separate module) | S | FR-14 |
| [x] | `ingest/azure_cm.py` — Azure Cost Management Query API | L | FR-14 |

Notes: CE is **us-east-1 only**; `GroupBy` takes at most 2 dimensions; the
backfill is ~14 calls per account (~$0.28 total). Azure's response is
parallel `columns`/`rows` arrays mapped by index — write it against a saved
sample response, since it cannot be verified without a subscription.

---

## 4. Backend — anomaly and alerts

| | Item | Size | Req |
|---|---|---|---|
| [x] | `anomaly/ports.py` — `Detector` protocol, `Finding` | S | — |
| [x] | `anomaly/mad.py` — rolling median + MAD, step/spike/creep classifier | M | FR-27, FR-30 |
| [x] | `anomaly/runner.py` — per account × service, skip last 1–2 days | M | FR-26, FR-28 |
| [x] | `alerts/ports.py` — `Notifier` protocol | S | — |
| [x] | `alerts/evaluate.py` — threshold, forecast, digest, anomaly | M | FR-31, FR-32 |
| [x] | `alerts/inapp.py` — writes `alert_events` | S | FR-33 |
| [x] | `alerts/ses.py` — email via SES | S | FR-33 |
| [x] | **Grant re-check at send time** | S | **FR-34** |

FR-34 is one call to `rbac.resolve` and is easy to forget. A rule can outlive
the grant that justified it; without the re-check you email someone about an
account they can no longer open.

---

## 5. Backend — API

| | Item | Size | Req |
|---|---|---|---|
| [x] | `api/deps.py` — **verify JWT signature** against JWKS → `Principal` | M | **TODO-4** |
| [x] | `api/routes/cost.py` — series, breakdown, compare | M | FR-18–22 |
| [x] | `api/routes/meta.py` — scoped accounts and services | S | FR-9, FR-20 |
| [x] | `api/routes/anomalies.py` — list, acknowledge | S | FR-29 |
| [x] | `api/routes/alerts.py` — rule CRUD, feed | M | FR-31–35 |
| [x] | `api/routes/admin.py` — users, grants, connections, audit | M | FR-1, FR-5, FR-39 |
| [x] | Response envelope: `as_of`, `metric`, `currency`, `partial_period` | S | FR-24, FR-25 |
| [x] | `cli.py` — `bootstrap-admin`, `add-connection`, `backfill` | S | — |

`deps.py` is the one to get right: verifying issuer/audience/expiry but
**not the signature** is the classic failure, and it is an open finding in
the DFIQ RBAC audit.

---

## 6. Frontend

| | Item | Size | Req |
|---|---|---|---|
| [ ] | Project scaffold (Vite + React + TS + Tailwind + shadcn) | S | — |
| [ ] | Cognito auth — Managed Login, email OTP, no register/forgot screens | M | FR-1–3 |
| [ ] | API client + TanStack Query setup | S | — |
| [ ] | `FilterBar` — cascading, **options from `/meta/*`** | M | **FR-9**, FR-20 |
| [ ] | `TimeGrainToggle` | S | FR-18 |
| [ ] | `CostChart` (Recharts time series) | M | FR-18 |
| [ ] | `BreakdownChart` | S | FR-19 |
| [ ] | `ComparisonTable` — Δ absolute **and** percent | M | FR-21, FR-22 |
| [ ] | `KpiTile` | S | — |
| [ ] | `PartialPeriodBadge` | S | FR-24 |
| [ ] | `AsOfLabel` | S | FR-25, NFR-10 |
| [ ] | `EmptyState` — "no accounts shared with you yet" | S | **FR-8** |
| [ ] | `AnomalyCard` + acknowledge | M | FR-29, FR-30 |
| [ ] | `AlertRuleForm` + `AlertFeed` | L | FR-31–33 |
| [ ] | Admin: Users, Grants, Connections, Audit | L | FR-1, FR-5, FR-39 |
| [ ] | `ConnectionForm` — role ARN + external id, **no secret fields** | S | FR-12 |
| [ ] | Showcase fixtures + toggle + banner, default **off** | M | FR-40–45 |

`FilterBar` and `EmptyState` are the demo's proof of RBAC — a restricted
user's dropdown containing only their accounts shows the access control
working in about fifteen seconds.

---

## 7. Infrastructure (Terraform)

| | Item | Size |
|---|---|---|
| [x] | `main.tf` — `locals.env = terraform.workspace`, workspace guard | S |
| [x] | `provider default_tags` — Project / Environment / ManagedBy | S |
| [x] | `env/dev.tfvars`, `env/staging.tfvars`, `env/main.tfvars` | S |
| [x] | `variables.tf`, `outputs.tf` | S |
| [x] | `iam.tf` — Lambda roles under path `/costhub/` | M |
| [x] | `database.tf` — RDS, SG, parameter group (`rds.force_ssl=1`, encrypted) | M |
| [x] | `lambda.tf` — 5 functions, zip packaging, Function URL | L |
| [x] | `schedule.tf` — EventBridge rules | S |
| [x] | `cognito.tf` — pool (Essentials), Managed Login, pre-signup Lambda, SES sender | L |
| [x] | `amplify.tf` — app, branch, **basic auth** | M |
| [x] | `messaging.tf` — budget, SES identity ARN | S |
| [x] | `secrets.tf` — DB password, `recovery_window_in_days = 0` | S |
| [x] | `logs.tf` — **explicit** log groups, 7-day retention | S |
| [x] | Teardown flags on every resource | S |
| [ ] | `terraform destroy` rehearsed | S |

Teardown flags: `force_destroy`, `skip_final_snapshot`,
`deletion_protection = false`, `recovery_window_in_days = 0`,
`deletion_protection = "INACTIVE"` on Cognito. Without them destroy fails
halfway (NFR-14).

---

## 8. Configuration and operations

| | Item | Size |
|---|---|---|
| [x] | `Makefile` — `up`, `teardown`, `restore`, `export-data`, `sweep`, `outputs`; `ENV` required, **no default** | M |
| [x] | `make teardown` — backup → **verify non-empty** → destroy → tag sweep | M |
| [x] | Backup guard: abort if the dump contains no `users` rows | S |
| [ ] | `env/<env>.tfvars` filled in per environment | S |
| [ ] | `frontend/.env.<env>` generated from `terraform output` | S |
| [ ] | Budget alerts at 50% / 80% of credits | S |
| [ ] | Credit-exhaustion alarm (Free plan **suspends**, not bills) | S |
| [ ] | Ingest-failure alert | S |
| [ ] | `./do.sh teardown dev` rehearsed, sweep returns empty | S |

---

## 9. Demo readiness

| | Item |
|---|---|
| [ ] | Backfill complete; `ingest_runs` = `success` for every connection |
| [ ] | Superadmin sees both accounts |
| [ ] | Restricted analyst sees one account, two services |
| [ ] | No-grant user sees the empty state — not an error, not everything |
| [ ] | Account-vs-account comparison on **real** data |
| [ ] | Anomaly detected, classified, with baseline vs observed |
| [ ] | Alert fires into the in-app feed |
| [ ] | Revoking a grant changes the view on refresh |
| [ ] | Audit log shows all of the above |
| [ ] | **A test OTP received in a real `@chryselys.com` inbox** |
| [ ] | Amplify basic auth set, URL shared |
| [ ] | Showcase toggle works and is clearly labelled |
| [ ] | `terraform destroy` rehearsed |

---

## Counts

Counted from the checkboxes above, not estimated — the previous version of
this table claimed 0 done for Ingest, API and Terraform while every box in
those sections was ticked, and a total (94) that matched no section sum.

| § | Area | Items | Done |
|---|---|---|---|
| 0 | Prerequisites (external) | 9 | 0 |
| 1 | Database and schema | 7 | 7 |
| 2 | Backend — core | 7 | 7 |
| 3 | Backend — connections and ingest | 7 | 7 |
| 4 | Backend — anomaly and alerts | 8 | 8 |
| 5 | Backend — API | 8 | 8 |
| 6 | Frontend | 17 | 0 |
| 7 | Infrastructure (Terraform) | 15 | 14 |
| 8 | Configuration and operations | 9 | 3 |
| 9 | Demo readiness | 13 | 0 |
| | **Total** | **100** | **54** |

To re-derive after an edit:

```bash
grep -c '^| \[x\]' docs/12-build-checklist.md   # done
grep -c '^| \[ \]' docs/12-build-checklist.md   # outstanding
```

**Backend and infrastructure are complete** (132 tests green). What remains
is the frontend, the live deploy, and the external prerequisites in §0.

## Critical path

```
Postgres → 004 + tests → connections → cost_explorer → runner →
backfill → API → [real data on screen] → anomaly → alerts → Terraform
```

Frontend runs in parallel from day one against the fixed API contract in
[06-frontend.md](06-frontend.md). Azure sits off the critical path — build it
once the AWS path works, so the access request is concrete.
