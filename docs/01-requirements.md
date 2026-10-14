# Requirements

## Scope

**In scope.** Consolidated, access-scoped cost reporting across
independent AWS accounts, with comparison, anomaly detection, alerting, and
narrated insights whose **figures are computed by us** and whose wording is
chosen by a model.

**Out of scope for the demo.** FOCUS export pipeline, resource-level
drill-down, unit economics, and live ingestion from any cloud but AWS.
Within that last one, two different situations worth keeping apart:

- **Azure** has a written, unit-tested adapter that has never spoken to
  Azure. It needs a subscription and a Cost Management Reader role.
- **Google Cloud has no adapter at all.** `ingest/sources.py` `ADAPTERS` is
  `{aws, azure}`, so a GCP connection raises `NoAdapter`, while the mock
  estate shows three Google Cloud accounts. That is the one place the demo
  promises more than exists — TODO-16.

All recorded in [10-todo-future.md](10-todo-future.md).

---

## Functional requirements

### Authentication and identity

| ID | Requirement |
|---|---|
| FR-1 | Invite-only. No self-registration. The first superadmin is created by Terraform (`aws_cognito_user`) plus migration 006; both halves are required, since a Postgres row with no pool user can never receive a code. |
| FR-2 | Only `@chryselys.com` addresses may authenticate. Enforced by a Cognito pre-signup Lambda **and** re-checked at the API boundary. |
| FR-3 | Passwordless (email OTP). **No password is ever set by this system** — not at creation, not after first sign-in: `AdminCreateUser` is called with no `TemporaryPassword`, which lands the user on `CONFIRMED` because a passwordless first-auth factor is active. Consequences: nothing to store, reset or leak, and nothing to migrate between accounts. ⚠️ **The frontend contradicts this**: its default `/login` form posts email and password to Cognito `InitiateAuth`, and the OTP hand-off is at `/login?otp=1`. Since no invited user has a password, the OTP path is the one that can complete. The register, forgot-password and reset-password screens exist but are closed off in live mode by `MockOnlyRoute`. Somebody has to decide which path is the product — see [06-frontend.md](06-frontend.md). |
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
| FR-11 | Cloud accounts are registered through the UI: provider, account id, display name, credential mode, and whatever that mode needs. Registering is followed by two verbs the operator can reach immediately — **test**, which names which of three prerequisites is missing, and **import**, which runs the ingest inline and says whether any data arrived. Both answer 200 with a verdict in the body, because "the request ran and the connection is broken" and "the request failed" are different facts. |
| FR-12 | Access is by cross-account `sts:AssumeRole` by default, and **no credential is ever stored in the database**. The fallback, for an account where nobody will create the role, is an IAM access key entered once in the UI: it is written to Secrets Manager and `cloud_connections` holds only the ARN. It is never stored in Postgres, never written to the audit log, and never returned by any endpoint. |
| FR-13 | A connection can be disabled without deleting its history, and deleting one is soft: it stops importing and leaves the cost already imported readable, because `fact_cost_daily` is keyed by provider and account rather than by connection. Re-registering the same account revives the row and picks the history back up. |
| FR-13b | **`credential_mode = 'profile'` cannot run in Lambda** and must be stated as such wherever the modes are listed. It resolves a named AWS CLI profile from the local filesystem, which does not exist in a Lambda execution environment, so such a connection fails every scheduled run permanently. |

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
| FR-38 | Superadmin bypasses are recorded in `audit_log` by `query/scoped._note_bypass`, **carrying the scope that was read** and throttled per `(actor, scope)` per hour — a dashboard issues several requests per page load. It lives in `_where`, at the point the predicate is actually replaced, not at authentication time: the earlier version recorded "a superadmin signed in" and no scope at all, so it could not answer the one question the entry exists for. Two reasoned exclusions: the system principal, which logs once per run, and `visible_services`, which returns names rather than money. |
| FR-39 | Superadmin can view audit history and full grant history including expired rows. |

### Narrated insights

| ID | Requirement |
|---|---|
| FR-46 | **Every figure on `/insights` is computed by the API**, through `query/scoped` with the caller's `Principal`, exactly as the cost screens are. No number is ever model-generated. |
| FR-47 | The backend writes the candidate sentences, and **every candidate is already true** of the figures on its card. A model on Bedrock chooses one per card and picks a lead card. It is never asked to add, subtract, rank or round anything, and nothing it writes is shown to anyone. |
| FR-48 | **Figures are mandatory; prose is optional.** A card with `text: null` is a complete, correct card. Narration may be absent for any of seven reasons, and `narration.status` / `narration.reason` say truthfully which. There is no fallback text, and the client must never fill the gap. |
| FR-49 | A narration failure must not fail the request. The caller always gets the figures. |
| FR-50 | The page states what the model does. "Wording selected by AI" is true; "written by AI" is not. |

### Mock data

Few real accounts prove the pipeline but cannot show what an estate of many
accounts across clouds looks like. Mock data fills that gap, **in the
frontend only**.

| ID | Requirement |
|---|---|
| FR-40 | A toggle switches between the live API and mock data, resolved at **runtime** so the choice costs no rebuild, and per browser so flipping it affects nobody else. `?mock=1` on any URL is the recovery path when the app will not load. |
| FR-41 | Mock data lives in the frontend and **never** enters the database, so there is no path by which synthetic data can be served as real. |
| FR-42 | Mock data matches the API response envelope, so switching is a flag rather than a code change. |
| FR-43 | It is **removable**: delete the directory and the flag, and the application functions identically. |
| FR-44 | While it is active the sidebar says so, unmissably, and the badge reads the **resolved** mode rather than the build default. |
| FR-45 | Access control is demonstrated on **real** data only. Mock data shows layout and scale, never authorisation behaviour. |
| FR-45b | **Mock must never show a capability that cannot be real.** Anything the API has no column for is dropped or dashed in live mode rather than filled with a zero. An empty real chart is fine; a fabricated one is not. ⚠️ The mock estate's three Google Cloud accounts currently violate this, because there is no GCP adapter — TODO-16. |
| FR-45c | A switch to live is **refused** when the build has no API URL, Cognito client id or Cognito domain, and the refusal says which is missing. A live mode that cannot reach anything is worse than the mock it replaced; silently handing back mock after someone asked for live is worse still. |

---

## Non-functional requirements

### Security

| ID | Requirement |
|---|---|
| NFR-1 | **Single enforcement point.** Exactly one module reads the fact table, and every query in it goes through `_where()`, which injects the grant predicate — or, for a superadmin, the literal `TRUE` **plus an audit row carrying the scope read**. Enforced by `tests/test_invariant.py`, which also fails the build on a module minting its own superadmin `Principal`. It had already drifted twice while the docs asserted it. |
| NFR-2 | Fail closed everywhere. Absence of permission denies. |
| NFR-3 | No credentials in the frontend, in source, or in environment files committed to git. Secrets Manager only. The one credential a user may type — the `secret`-mode access key pair — is POSTed once, written to Secrets Manager under a dedicated prefix, and **never** stored in Postgres, written to the audit log, or returned by any endpoint. That last one includes a 422 body: pydantic echoes the whole parent object on a `missing` error, so `api/main.py` scrubs both fields out of validation errors. |
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
| NFR-13 | Running cost ceiling ~$15/month, dominated by RDS, which is the only standing cost. |
| NFR-14 | Full teardown via a single command, with no manual cleanup — and it **proves** completion with a tag sweep rather than assuming it. ⚠️ **Never run**: it needs `pg_dump`, which is not installed. Two things the sweep must catch because `destroy` cannot: a secret the API created at runtime under `costhub/<env>/connections/*`, and the duplicate public-access statement the console added to the api function while the Function URL 403 was being diagnosed. |
| NFR-15 | Account-portable: redeploy to any account by changing variables, plus a data restore step. |
| NFR-16 | No resource created by hand. One console-created resource breaks clean teardown. |

### Maintainability

| ID | Requirement |
|---|---|
| NFR-17 | Three swap points behind protocols: `CostSource`, `Detector`, `Notifier`. Adding a provider or channel touches one file. |
| NFR-18 | Source files ≤300 lines, enforced by `tests/test_invariant.py`. `query/scoped.py` is a reasoned exemption: splitting it to satisfy a line count would trade the NFR-1 security property for a style one. |
| NFR-19 | Audit columns on every table that records a human action. `schema_migrations` and `audit_log` carry none by design (one is bookkeeping, the other *is* the trail); `ingest_runs`, the two dimensions, `alert_events` and `anomaly_findings` omit `deleted_at` because nothing soft-deletes them; `insight_narrations` carries only `created_at` and `expires_at`, because it is a cache with a TTL. The original "no exceptions" was false for more than half of the 14 tables. |
| NFR-20 | Fact column names follow FOCUS so the FOCUS adapter needs no translation layer. |
| NFR-21 | Local development and deployment run identical code — plain Postgres over TCP, no second access path. The **database** differs (a Neon sandbox locally, RDS everywhere else), which is why `./do.sh cli` exists: it points `DATABASE_URL` at the deployed database by reading it off the api Lambda, so an operator command cannot silently answer from seeded rows. |

### Observability

| ID | Requirement |
|---|---|
| NFR-22 | Every ingest run recorded with status, row count and error. |
| NFR-23 | Ingest failures alert, not just cost anomalies. |

---

## Acceptance criteria for the demo

1. Superadmin signs in and sees every connected account.
2. A restricted user signs in and sees **one** account and only granted
   services — same build, same URL, different data.
3. A new user with no grants sees an empty state: **not** an error, and not
   everything.
4. Account-vs-account comparison renders from **real** cost data in
   independent accounts.
5. An anomaly is detected, classified, and explained with baseline vs
   observed.
6. An alert rule fires into the in-app feed.
7. Revoking a grant changes what the user sees on refresh.
8. The audit log shows all of the above, including **which scope** a
   superadmin read.
9. `/insights` answers from the API with computed figures, and
   `narration.status` is either `ok` or honestly says why there is no
   prose.
10. `terraform destroy` removes everything, and the tag sweep comes back
    empty.

These are acceptance criteria, not a description. Every one of them is
currently unticked in
[12-build-checklist.md](12-build-checklist.md) §9, because none has been
walked through against the deployed API in a browser.
