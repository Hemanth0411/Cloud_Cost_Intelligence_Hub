# Requirements

## Scope

**In scope.** Consolidated, access-scoped cost reporting across two
independent AWS accounts, with comparison, anomaly detection and alerting.

**Out of scope for the demo.** Azure/GCP live ingestion (architecture
supports it; no subscriptions available), FOCUS export pipeline,
resource-level drill-down, unit economics, AI narration. All recorded in
[10-todo-future.md](10-todo-future.md).

---

## Functional requirements

### Authentication and identity

| ID | Requirement |
|---|---|
| FR-1 | Invite-only. No self-registration. The first superadmin is created by Terraform (`aws_cognito_user`) plus migration 006; both halves are required, since a Postgres row with no pool user can never receive a code. |
| FR-2 | Only `@chryselys.com` addresses may authenticate. Enforced by a Cognito pre-signup Lambda **and** re-checked at the API boundary. |
| FR-3 | Passwordless (email OTP). **No password exists at all** — not set at creation, not after first sign-in. Every sign-in is email → fresh code → tokens. Consequences: no register screen, no forgot-password screen, and nothing to migrate between accounts. |
| FR-4 | One user = one email. Multiple login methods (Cognito, later Microsoft) map to one internal user id via an `identities` table. |

### Access control

| ID | Requirement |
|---|---|
| FR-5 | A superadmin grants a user access to a specific **account**, optionally narrowed to a specific **service**. |
| FR-6 | Grants may be indefinite or **time-bounded** (`valid_from` / `valid_until`). |
| FR-7 | Revocation takes effect on the next query. Nothing is cached. |
| FR-8 | A user with no grants sees **zero** rows — never all rows. Fail closed. |
| FR-9 | Filter dropdowns contain only what the user may see, so scoping is visible, not merely claimed. |
| FR-10 | Expired and revoked grants are retained and flagged, never deleted. |

### Account connections

| ID | Requirement |
|---|---|
| FR-11 | Cloud accounts are registered through the UI: provider, account id, display name, role ARN, external id. |
| FR-12 | No credential is ever entered into, or stored by, the frontend. Access is by cross-account `sts:AssumeRole`. |
| FR-13 | A connection can be disabled without deleting its history. |

### Ingestion

| ID | Requirement |
|---|---|
| FR-14 | Fetch daily cost per account × service × region × charge category. |
| FR-15 | Re-ingestion is **idempotent** — the same period fetched twice yields the same rows. Cost data is restated as it finalises, so recent days are re-fetched routinely. |
| FR-16 | Every write belongs to exactly one recorded `ingest_run` with status and row count. |
| FR-17 | A failed account does not abort the others. |

### Reporting

| ID | Requirement |
|---|---|
| FR-18 | Cost over time at day / week / month / quarter / year. |
| FR-19 | Breakdown by provider, account, service, region, charge category. |
| FR-20 | Cascading filters: provider → account → service. |
| FR-21 | Comparison in three modes: period vs period, account vs account, service vs service. |
| FR-22 | Deltas shown as **both** absolute currency and percent. Percent alone is noise on small numbers. |
| FR-23 | `Tax` and `Credit` rows excluded from service comparisons unless explicitly included. |
| FR-24 | Incomplete current periods labelled as partial, or excluded. A month-to-date compared against a full month otherwise shows a false 40–60% drop. |
| FR-25 | Every view states which cost measure it uses (`effective_cost` or `billed_cost`) and an as-of timestamp. |

### Anomaly detection

| ID | Requirement |
|---|---|
| FR-26 | Detection runs per **account × service**, never on the aggregate total — aggregates average anomalies away. |
| FR-27 | Classify findings as `step`, `spike` or `creep`. Cloud cost anomalies are overwhelmingly step changes. |
| FR-28 | Exclude the most recent 1–2 days; unfinalised data produces false positives. |
| FR-29 | Findings can be acknowledged or dismissed, with who and when recorded. |
| FR-30 | Every finding carries baseline, observed, absolute and percent delta — the explanation, not just the flag. |

### Alerting

| ID | Requirement |
|---|---|
| FR-31 | Four rule types: `threshold`, `forecast`, `digest`, `anomaly`. |
| FR-32 | Rules are scoped to provider / account / service, or all. |
| FR-33 | Delivery to in-app feed and email. |
| FR-34 | **Grants are re-checked at send time.** A rule can outlive the grant that justified it; nobody may be emailed about an account they can no longer see. |
| FR-35 | Firing history is retained with observed and expected values. |

### Audit

| ID | Requirement |
|---|---|
| FR-36 | Every access change writes an append-only `audit_log` row with actor, action, before and after. |
| FR-37 | The audit entry commits in the **same transaction** as the change it describes. |
| FR-38 | Superadmin bypasses are recorded in `audit_log` by `api/deps.py:_audit_bypass`, throttled to one row per actor per hour — a dashboard issues several requests per page load. This was asserted in a code comment and implemented nowhere. |
| FR-39 | Superadmin can view audit history and full grant history including expired rows. |

### Showcase fixtures

Two real accounts prove the pipeline but cannot show what many accounts
across two clouds look like. Fixtures fill that gap, in the frontend only.

| ID | Requirement |
|---|---|
| FR-40 | A UI toggle switches between real data and showcase fixtures, **off by default**. |
| FR-41 | Fixtures live in the frontend and **never** enter the database, so there is no path by which synthetic data can be served as real. |
| FR-42 | Fixtures match the API response envelope exactly, so switching is a flag rather than a code change. |
| FR-43 | Fixtures are **removable**: delete the directory and the flag, and the application functions identically. |
| FR-44 | While fixtures are active an unmissable banner is shown. |
| FR-45 | Access control is demonstrated on **real** data only. Fixtures show layout and scale, never authorization behaviour. |

---

## Non-functional requirements

### Security

| ID | Requirement |
|---|---|
| NFR-1 | **Single enforcement point.** Exactly one module reads the fact table, and it always applies the grant predicate. Enforced by `tests/test_invariant.py` — it had already drifted twice while the docs asserted it. |
| NFR-2 | Fail closed everywhere. Absence of permission denies. |
| NFR-3 | No credentials in the frontend, in source, or in environment files committed to git. Secrets Manager only. |
| NFR-4 | `audit_log` is append-only, enforced by **statement triggers** that RAISE on UPDATE/DELETE (`migrations/005`), not by convention. The accompanying `REVOKE ... FROM PUBLIC` is belt-and-braces only — Postgres grants nothing to PUBLIC by default and the app connects as the table owner. `TRUNCATE` is **not** blocked: the test suite truncates `audit_log` between tests, which is the proof. |
| NFR-5 | Cross-account access is read-only, single-purpose and revocable by deleting one role. |
| NFR-6 | TLS enforced on database connections (`rds.force_ssl = 1`); encryption at rest enabled. |

### Correctness

| ID | Requirement |
|---|---|
| NFR-7 | Money is `numeric(18,6)` in SQL and `Decimal` in Python, end to end — including `compare()`'s deltas, which briefly cast to float. Percent deltas stay float: a display ratio, not money. |
| NFR-7b | **All accounts in scope bill in USD.** `currency` is still stored per row, but no FX conversion is implemented. A non-USD account must not be added without an explicit FX policy first. |
| NFR-8 | All timestamps are `timestamptz`, stored UTC, displayed local. |
| NFR-9 | Fact table has a natural-key unique constraint so upserts are idempotent. |
| NFR-10 | Cost data lags 8–24h and finalises monthly. The UI must never imply real-time. |

### Performance

| ID | Requirement |
|---|---|
| NFR-11 | Dashboard queries under ~1s. Achieved by querying a daily rollup, not line items. |
| NFR-12 | Rollup grain keeps monthly volume in the tens of thousands of rows. |

### Cost and lifecycle

| ID | Requirement |
|---|---|
| NFR-13 | Running cost ceiling ~$15/month; demo window ~10 days. |
| NFR-14 | Full teardown via a single `terraform destroy`, with no manual cleanup. |
| NFR-15 | Account-portable: redeploy to any account by changing variables, plus a data restore step. |
| NFR-16 | No resource created by hand. One console-created resource breaks clean teardown. |

### Maintainability

| ID | Requirement |
|---|---|
| NFR-17 | Three swap points behind protocols: `CostSource`, `Detector`, `Notifier`. Adding a provider or channel touches one file. |
| NFR-18 | Source files ≤300 lines, enforced by `tests/test_invariant.py`. `query/scoped.py` is a reasoned exemption: splitting it to satisfy a line count would trade the NFR-1 security property for a style one. |
| NFR-19 | Audit columns on every table that records a human action. `schema_migrations` and `audit_log` carry none by design (one is bookkeeping, the other *is* the trail); `ingest_runs`, the two dimensions, `alert_events` and `anomaly_findings` omit `deleted_at` because nothing soft-deletes them. The original "no exceptions" was false for 7 of 13 tables. |
| NFR-20 | Fact column names follow FOCUS so the FOCUS adapter needs no translation layer. |
| NFR-21 | Local development and deployment run identical code — plain Postgres over TCP, no second access path. |

### Observability

| ID | Requirement |
|---|---|
| NFR-22 | Every ingest run recorded with status, row count and error. |
| NFR-23 | Ingest failures alert, not just cost anomalies. |

---

## Acceptance criteria for the demo

1. Superadmin logs in, sees both accounts.
2. Restricted user logs in, sees **one** account and only granted services — same dashboard, different data.
3. A new user with no grants sees an empty state, not an error and not everything.
4. Account-vs-account comparison renders from **real** cost data in two independent accounts.
5. A planted anomaly is detected, classified and explained with baseline vs observed.
6. An alert rule fires into the in-app feed.
7. Revoking a grant changes what the user sees on refresh.
8. `terraform destroy` removes everything.
