# Build checklist

Everything to be built, by area. `[x]` = done, `[ ]` = pending.
Size: **S** ≤2h, **M** ≤half a day, **L** ≤1 day.

Requirement ids refer to [01-requirements.md](01-requirements.md).

---

## 0. Prerequisites (external — start first, they have lead times)

| | Item | Owner | Blocks |
|---|---|---|---|
| [x] | Postgres for local dev — the Neon sandbox | you | local development |
| [x] | `git init` + remote (Amplify builds from a repo) | you | frontend deploy |
| [x] | Decide the SES sender identity (a domain you own, ideally) | you | login |
| [x] | Verify the SES sender, and each recipient while sandboxed | you | login |
| [x] | Deploy account: enable Cost Explorer | you (root) | real data |
| [x] | Deploy account: enable billing-info IAM access | you (root) | real data |
| [ ] | Deploy account: activate cost allocation tags | you (root) | **never retroactive**, and TODO-19 depends on it |
| [ ] | Each data-source account: root enables billing-info IAM access | their root | that account's data |
| [ ] | Each data-source account: `CostHubCostReader` at the root IAM path | their IAM admin | that account's data — **or** use `credential_mode = "secret"` instead |
| [ ] | Azure subscription + Entra app registration with Cost Management Reader | TBD | Azure data only |
| [ ] | Bedrock: submit the Anthropic use-case form | account owner | **only** if you want a Claude model. Nova Lite needs nothing |
| [ ] | PostgreSQL client tools (`pg_dump`, `psql`) on the deploy machine | you | **teardown, export-data and restore** |

None of these block starting the backend — `dev_seed` covers development.
The last one blocks teardown, which is why teardown has never been run.

---

## 1. Database and schema

| | Item | Size | Req |
|---|---|---|---|
| [x] | `001_core.sql` — users, identities, access_grants, audit_log | — | FR-4, FR-5 |
| [x] | `002_facts.sql` — ingest_runs, dims, fact_cost_daily | — | FR-14 |
| [x] | `003_alerts_anomaly.sql` — rules, events, findings | — | FR-31 |
| [x] | `004_connections.sql` — `cloud_connections` | S | FR-11–13 |
| [x] | `005_audit_append_only.sql` — statement triggers that RAISE on UPDATE/DELETE | S | NFR-4, TODO-10 |
| [x] | `006_seed_superadmin.sql` — the row half of the first superadmin | S | FR-1 |
| [x] | `007_reclassify_charge_category.sql` — fix rows written before the adapter derived it | S | FR-23 |
| [x] | `008_insight_narrations.sql` — the narration cache and call ledger | S | TODO-18 |
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
| [x] | `rbac/pool.py` — the Cognito half of an invite, plus enable/disable | M | FR-1 |
| [x] | `rbac/users.py` — remove a user, change a role | S | FR-1 |
| [x] | **Tests for `scoped.py`** — all 10 cases, fail-closed first | M | FR-8 |
| [x] | **`test_invariant.py`** — single reader, predicate coverage, no fabricated superadmins, the 300-line limit, each with a test that the check can fail | M | **NFR-1**, NFR-18 |

The test suite is not optional padding. Every security claim in
[07-security-rbac.md](07-security-rbac.md) is only true if those tests
pass — in particular `test_no_grants_sees_nothing`. And `test_invariant.py`
is what keeps NFR-1 true as the code grows: it had already silently become
false twice while five documents asserted it.

---

## 3. Backend — connections and ingest

| | Item | Size | Req |
|---|---|---|---|
| [x] | `connections/store.py` — CRUD over `cloud_connections` | S | FR-11–13 |
| [x] | `connections/edits.py` — patch, enable/disable, soft delete with revive | M | FR-13 |
| [x] | `connections/credentials.py` — the four modes → a boto3 session | M | FR-12 |
| [x] | `connections/key_store.py` — the access key in Secrets Manager, under one prefix, tagged | M | FR-12, NFR-3 |
| [x] | `connections/probe.py` — the **two-stage** test, so AccessDenied names the right account | M | FR-11 |
| [x] | `ingest/stale.py` — close `ingest_runs` whose process was killed | S | NFR-22 |
| [x] | `ingest/dev_seed.py` — generated rows, planted step/spike/creep | M | — |
| [x] | `ingest/cost_explorer.py` — CE adapter, DAILY, grouped by SERVICE | M | FR-14 |
| [x] | `ingest/runner.py` — per-connection loop, `ingest_runs` lineage, idempotent upsert | M | FR-15–17 |
| [x] | backfill — `cli.py:cmd_backfill`, month-chunked with a 400-day floor (not a separate module) | S | FR-14 |
| [x] | `ingest/azure_cm.py` — Azure Cost Management Query API | L | FR-14 |

Notes: CE is **us-east-1 only**; `GroupBy` takes at most 2 dimensions; the
backfill is ~14 calls per account (~$0.28 total). Azure's response is
parallel `columns`/`rows` arrays mapped **by name, not by index** — the
column order shifts with the grouping requested, and a positional read
silently swaps cost and date. It is written against a saved sample
response, because it cannot be verified without a subscription, and it
**has never spoken to Azure**.

**There is no GCP adapter** — `ADAPTERS` is `{aws, azure}`. TODO-16.

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
| [x] | `api/routes/admin.py` — users, grants, audit, ingest-runs | M | FR-1, FR-5, FR-39 |
| [x] | `api/routes/connections.py` + `connection_edits` + `connection_import` | M | FR-11–13 |
| [x] | `api/routes/insights.py` + the `insights/` package | L | TODO-18 |
| [x] | Response envelope: `as_of`, `metric`, `currency`, `partial_period` | S | FR-24, FR-25 |
| [x] | The 422 credential scrub — pydantic echoes the whole body on a `missing` error | S | **NFR-3** |
| [x] | `_UnhandledErrors` **inside** `CORSMiddleware`, so a 500 is not reported as a CORS fault | S | — |
| [x] | `cli.py` / `cli_jobs.py` — `add-connection`, `backfill`, `detect`, `alerts`, `status` | S | — |
| [x] | `./do.sh cli <env>` — point the CLI at the **deployed** database | S | — |

`deps.py` is the one to get right: verifying issuer/audience/expiry but
**not the signature** is the classic failure, and it is an open finding in
the DFIQ RBAC audit.

---

## 6. Frontend

**Built as Next.js 15 app router, not Vite.** The scaffold line below used
to say "Vite + React + TS + Tailwind + shadcn", and
`14-frontend-build-spec.md` specified nine pages against that stack. The
frontend that exists is Next; the spec has been deleted and
[06-frontend.md](06-frontend.md) rewritten against the real app.

| | Item | Size | Req |
|---|---|---|---|
| [x] | Project scaffold — Next.js 15 app router, React 19, TS, Tailwind | S | — |
| [x] | Cognito auth — PKCE code flow to Managed Login for email OTP, plus a direct password form | M | FR-1–3 |
| [x] | API client — ID token, pre-emptive refresh, one shared refresh, 401 vs 403 | M | — |
| [x] | `FilterBar` — cascading, **options from `/meta/*`** | M | **FR-9**, FR-20 |
| [x] | Time-grain control | S | FR-18 |
| [x] | Spend-over-time chart (Recharts) | M | FR-18 |
| [x] | Breakdown charts, provider donut, sparklines | S | FR-19 |
| [x] | Comparison table — Δ absolute **and** percent | M | FR-21, FR-22 |
| [x] | KPI cards and grid | S | — |
| [x] | Partial-period labelling | S | FR-24 |
| [x] | As-of label, and a data-source badge naming the live mode | S | FR-25, NFR-10 |
| [x] | Empty / error / no-data states | S | **FR-8** |
| [x] | Anomalies: table, filters, timeline, investigation, acknowledge | L | FR-29, FR-30 |
| [x] | Alerts: rules, feed, notification bell and preferences | L | FR-31–33 |
| [x] | Admin: Users & grants, Cloud accounts, Audit log | L | FR-1, FR-5, FR-39 |
| [x] | Connect dialog — role ARN + ExternalId; access key fields for `secret` mode, **write-only** | S | FR-12 |
| [x] | Import dialog — inline import with the verdict in the response | M | FR-11 |
| [x] | `/insights` wired to `GET /insights` in live mode | M | TODO-18 |
| [x] | Mock/live: a runtime `localStorage` override, `?mock=1`, a refusal when live is unsupported, and an on-screen badge | M | FR-40–45 |
| [x] | `MockOnlyRoute` — register / forgot / reset closed off in live mode, with the reason | S | — |
| [x] | `npm run verify:data` — a gate on the mock estate, exits non-zero | M | FR-41 |
| [ ] | **Live mode exercised against the deployed API in a browser** — built but unproven until someone signs in and looks | S | — |

`FilterBar` and the empty states are the demo's proof of RBAC — a
restricted user's dropdown containing only their accounts shows the access
control working in about fifteen seconds.

---

## 7. Infrastructure (Terraform)

| | Item | Size |
|---|---|---|
| [x] | `main.tf` — `locals.env = terraform.workspace`, workspace guard | S |
| [x] | `provider default_tags` — Project / Environment / ManagedBy | S |
| [x] | `env/dev.tfvars`, `env/staging.tfvars`, `env/main.tfvars` | S |
| [x] | `variables.tf`, `outputs.tf` | S |
| [x] | `iam.tf` — the shared Lambda role under path `/costhub/`, plus separate policies for assume-cost-roles, Bedrock and connection secrets | M |
| [x] | `database.tf` — RDS, SG, parameter group (`rds.force_ssl=1`, encrypted) | M |
| [x] | `lambda.tf` — 4 app functions + presignup from one zip. **No Function URL** | L |
| [x] | `apigateway.tf` — HTTP API, `$default` route and stage, throttling, service-principal permission | M |
| [x] | `schedule.tf` — EventBridge rules for ingest / anomaly / alerts | S |
| [x] | `cognito.tf` — pool (ESSENTIALS), Managed Login v2, pre-signup Lambda, SES sender, the seeded superadmin | L |
| [x] | `amplify.tf` — app on `WEB_COMPUTE`, branch, and the `ignore_changes` on the co-owned env-var map | M |
| [x] | `messaging.tf` — budget, SES identity ARN | S |
| [x] | `secrets.tf` — DB password, `recovery_window_in_days = 0` | S |
| [x] | `logs.tf` — **explicit** log groups, 7-day retention | S |
| [x] | Teardown flags on every resource | S |
| [x] | `fileexists` guard on the Lambda bundle, so `plan -destroy` works on a fresh clone | S |
| [ ] | `terraform destroy` rehearsed | S |
| [ ] | Narrow the `ce:` grant to the two actions actually called (TODO-5) | S |

Teardown flags: `force_destroy`, `skip_final_snapshot`,
`deletion_protection = false`, `recovery_window_in_days = 0`,
`deletion_protection = "INACTIVE"` on Cognito. Without them destroy fails
halfway (NFR-14).

---

## 8. Configuration and operations

| | Item | Size |
|---|---|---|
| [x] | `do.sh` — `build`, `up`, `migrate`, `cli`, `outputs`, `export-data`, `teardown`, `sweep`, `restore`; `ENV` required, **no default** | M |
| [x] | `teardown` — backup → **verify non-empty** → destroy → tag sweep | M |
| [x] | Backup guard: abort if the dump contains no `users` rows | S |
| [x] | `./do.sh cli <env>` — reads `DATABASE_URL` off the api Lambda, not Terraform state | S |
| [x] | Budget alerts at 50% / 80% of `budget_limit_usd`, created by Terraform | S |
| [x] | `env/dev.tfvars` filled in | S |
| [x] | `frontend/.env.local` generated by `./do.sh outputs` | S |
| [ ] | The five `NEXT_PUBLIC_*` set in the Amplify console and kept in step after an apply | S |
| [ ] | Credit-exhaustion alarm (Free plan **suspends**, not bills) — TODO-14 | S |
| [ ] | Ingest-failure alert — TODO-13 | S |
| [ ] | `pg_dump` installed, then `./do.sh teardown dev` rehearsed and the sweep empty | S |

---

## 9. Demo readiness

| | Item |
|---|---|
| [ ] | Backfill complete; every connection shows a recent `success` and no run is stuck `running` |
| [ ] | Superadmin sees every connected account |
| [ ] | Restricted analyst sees one account and narrowed services |
| [ ] | No-grant user sees the empty state — not an error, not everything |
| [ ] | Account-vs-account comparison on **real** data |
| [ ] | An anomaly detected, classified, with baseline vs observed |
| [ ] | An alert fires into the in-app feed |
| [ ] | Revoking a grant changes the view on refresh |
| [ ] | Audit log shows all of the above, with the scope a superadmin read |
| [ ] | **A test sign-in code received in a real inbox on the allowed domain** |
| [ ] | `/insights` answers in live mode, and `narration.status` is `ok` or honestly says why not |
| [ ] | The mock/live badge says the right thing, and `?mock=1` recovers the app |
| [ ] | `CodeSha256` matches on **all five** functions — the job Lambdas run an older build unless the deploy named them |
| [ ] | `terraform destroy` rehearsed |

---

## Counts

Counted from the checkboxes above, not estimated — the previous version of
this table claimed 0 done for Ingest, API and Terraform while every box in
those sections was ticked, and a total (94) that matched no section sum.

| § | Area | Items | Done |
|---|---|---|---|
| 0 | Prerequisites (external) | 12 | 6 |
| 1 | Database and schema | 10 | 10 |
| 2 | Backend — core | 10 | 10 |
| 3 | Backend — connections and ingest | 11 | 11 |
| 4 | Backend — anomaly and alerts | 8 | 8 |
| 5 | Backend — API | 13 | 13 |
| 6 | Frontend | 22 | 21 |
| 7 | Infrastructure (Terraform) | 18 | 16 |
| 8 | Configuration and operations | 11 | 7 |
| 9 | Demo readiness | 14 | 0 |
| | **Total** | **129** | **102** |

To re-derive after an edit:

```bash
grep -c '^| \[x\]' docs/12-build-checklist.md   # done
grep -c '^| \[ \]' docs/12-build-checklist.md   # outstanding
```

**Backend, frontend and infrastructure are built and deployed.** What
remains is almost entirely §9 — exercising it, in a browser, against the
deployed API — plus the external prerequisites in §0 that depend on
somebody else's account, and the teardown rehearsal that needs `pg_dump`.

Treat §9 as the real outstanding work, not a formality. Across every review
pass on this project, **everything that had never been run was broken**.

## Critical path

The build path is behind us. What is left is a verification path, and it
runs in one direction:

```
./do.sh outputs dev → NEXT_PUBLIC_* in the Amplify console → sign in
  → superadmin sees every account → grant one account to an analyst
  → sign in as them → one account, narrowed services
  → revoke → refresh → gone
  → audit log shows all of it, with the scope read
```

Then the two things no test covers: a sign-in code arriving in a real
inbox, and `/insights` answering from the deployed API rather than from
the browser's mock pass.
