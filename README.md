# CostHub — Cloud Cost Intelligence Hub

**One scoped view of cloud cost across AWS accounts that are not in an AWS
Organization, with per-user visibility control, anomaly detection, alerting
and narrated insights.**

Hackathon project — Team 12, The Cloud Minds.

New here? Read [`CONTEXT.md`](CONTEXT.md) first. It holds the current state,
the traps that are not visible in the code, and what is left to do. This
file is the orientation; `docs/` is the design.

---

## What it is

A small AWS-native application that pulls daily cost from each cloud account
you register, stores it as one rollup, and serves it through an API that
filters every row by who is asking.

It does five things:

| | |
|---|---|
| **Consolidates** | one dashboard across independent accounts, which Cost Explorer cannot do without an Organization |
| **Scopes** | a superadmin grants a user one account, optionally one service, optionally for a fixed window. Enforced in SQL, not in the UI |
| **Detects** | our own rolling-median and MAD detector classifies findings as `step`, `spike` or `creep`, with baseline and observed values attached |
| **Alerts** | four rule types to an in-app feed and email, with the grant re-checked before the rule is even evaluated |
| **Narrates** | `GET /insights` computes figures and lets a model on Amazon Bedrock choose the wording. The numbers are never model-generated |

Under the hood: FastAPI on Lambda behind an API Gateway HTTP API, RDS
PostgreSQL, Cognito with passwordless sign-in, a Next.js 15 frontend on
Amplify Hosting, and one Terraform root module for all of it.

---

## The two constraints that made this worth building

AWS already ships
[Cloud Intelligence Dashboards](https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/focus-dashboard.html)
(MIT-0), which aggregates multiple independent payers and offers row-level
security through QuickSight. Being honest about that is part of the
deliverable. Two facts about this situation ruled it out:

1. **The accounts are not in an AWS Organization.** They are independent
   accounts, so there is no org-wide CUR export and no payer rollup. Cost
   Explorer, Budgets and Cost Anomaly Detection are all **per-payer** —
   with independent accounts you log into each one separately. That is the
   pain being solved.
2. **Cost data is not visible to everyone.** Not every person may see every
   account's spend, so a consolidated view needs per-user row scoping, not
   just aggregation.

CID's answer to the second is QuickSight row-level security, which prices
per seat ($3-$40 per user per month on Enterprise, plus a $250/month fee
once generative features are enabled) and would put the authorisation
decision in a BI tool rather than in the query path. Its answer to the
first still assumes a payer to export from.

So this is the layer above CID, not a replacement for it. What stays open
either way:

| Gap | Why it stays open |
|---|---|
| Optimisation detail | AWS's own FAQ states FOCUS omits `lineItem/Operation` and is therefore not recommended for cost optimisation |
| Unit economics | no vendor knows what a *pipeline run*, *project* or *client* is |
| Cross-payer narration in one pane | cost investigations live in each source account's console |
| Per-seat cost | see above |

See [`docs/01-requirements.md`](docs/01-requirements.md) for scope and
[`docs/10-todo-future.md`](docs/10-todo-future.md) for what was
deliberately deferred.

---

## The central security claim

**`backend/costhub/query/scoped.py` is the only module that reads
`fact_cost_daily`, and every query in it goes through `_where()`, which
injects the grant predicate.**

```sql
EXISTS (
  SELECT 1 FROM access_grants g
  WHERE g.user_id      = %(user_id)s
    AND g.revoked_at  IS NULL
    AND g.deleted_at  IS NULL
    AND g.provider     = f.provider
    AND g.account_id   = f.account_id
    AND (g.service_name IS NULL OR g.service_name = f.service_name)
    AND now() >= g.valid_from
    AND (g.valid_until IS NULL OR now() < g.valid_until)
)
```

Get that right and the RBAC holds regardless of what the UI later does.
Four properties follow: it **fails closed** (no grants means zero rows,
never all rows), revocation takes effect on the next query because `now()`
is evaluated per query, unauthorised rows **never leave the database**, and
the whole thing is nine lines of SQL in one place.

One precision worth keeping. For a superadmin, `_where()` injects the
literal `TRUE` instead — and writes an `audit_log` row carrying the scope
that was read, throttled per actor and scope per hour. There *is* a bypass;
the control on it is the audit row, not the predicate. An unlogged bypass
is indistinguishable from a leak.

### It is enforced mechanically

`backend/tests/test_invariant.py` walks the AST of every module in the
package and fails the build on:

- a SQL literal selecting from `fact_cost_daily` outside the two-entry
  allowlist (`query/scoped.py` reads; `ingest/runner.py` writes)
- `scoped.py` having more fact queries than `_where()` calls
- any module minting its own `Principal(role="superadmin")`
- any module over 300 lines, bar one reasoned exemption

Every check has a companion test proving the check can fail. This is a test
rather than a convention because the invariant **had already silently
become false twice** — `anomaly/runner.py` and `cli.py` both grew direct
reads while five documents asserted it held.

---

## Shape in one picture

```mermaid
graph LR
    subgraph SRC["Cloud accounts, read-only"]
        A1["Account A<br/>self"]
        A2["Account B<br/>AssumeRole"]
        A3["Account C<br/>stored key"]
    end

    ING["ingest<br/>Lambda, 06:00 UTC"]
    PG[("RDS PostgreSQL<br/>daily rollup + app state")]
    SC["query/scoped.py<br/>SINGLE AUTHORISATION POINT"]
    ANO["anomaly<br/>06:30"]
    ALR["alerts<br/>07:00"]
    API["api<br/>API Gateway HTTP API"]
    FE["Next.js app<br/>on Amplify"]

    A1 --> ING
    A2 --> ING
    A3 --> ING
    ING --> PG
    PG --> SC
    SC --> ANO
    SC --> ALR
    SC --> API
    ANO --> PG
    ALR --> PG
    API --> FE
```

Three levels of this — context, container and component — are in
[`docs/02-architecture.md`](docs/02-architecture.md).

---

## Documentation

| Doc | Contents |
|---|---|
| [CONTEXT.md](CONTEXT.md) | **start here** — current state, traps, what is left |
| [01-requirements.md](docs/01-requirements.md) | functional and non-functional requirements |
| [02-architecture.md](docs/02-architecture.md) | context, container and component levels; what is deliberately absent |
| [03-data-model.md](docs/03-data-model.md) | all 14 tables, the ERD, audit conventions |
| [04-data-flow.md](docs/04-data-flow.md) | ingest, scoped read, access change, detection, alerting |
| [05-backend.md](docs/05-backend.md) | module map, the invariant, the API surface, the CLI |
| [06-frontend.md](docs/06-frontend.md) | the real Next.js app: pages, auth, mock/live, gates |
| [07-security-rbac.md](docs/07-security-rbac.md) | the grant predicate, sign-in, cross-account access, threat notes |
| [08-aws-services.md](docs/08-aws-services.md) | every AWS service used, why, and what it costs |
| [09-deployment.md](docs/09-deployment.md) | prerequisites, Terraform layout, deploy, teardown |
| [10-todo-future.md](docs/10-todo-future.md) | deferred security and functional work |
| [11-configuration.md](docs/11-configuration.md) | every config value, email setup, account-migration runbook |
| [12-build-checklist.md](docs/12-build-checklist.md) | what is built, by area |
| [13-environments-and-teardown.md](docs/13-environments-and-teardown.md) | the `ENV` switch, one-command teardown |
| [15-mock-vs-live.md](docs/15-mock-vs-live.md) | switching the app between mock data and the live API |
| [16-insights-api.md](docs/16-insights-api.md) | `GET /insights`: the contract, the model, the degradations |
| [17-connection-lifecycle.md](docs/17-connection-lifecycle.md) | credential modes, the state machine, the two-stage probe |

**`14-frontend-build-spec.md` has been deleted.** It was a 388-line
buildable spec for a Vite single-page app with nine pages and a different
route set — intent that the build diverged from almost immediately. The
frontend that exists is Next.js 15 app router, and CONTEXT.md already had
to warn readers that the doc was intent rather than fact. A spec that
describes an app nobody built is a trap, not documentation, so it is gone
and [06-frontend.md](docs/06-frontend.md) was rewritten against the real
app. Nothing in it was load-bearing: component props and the response
envelope were always in 06, and the endpoint reference is generated at
`/docs`.

---

## Quickstart

```bash
export AWS_PROFILE=costhub        # EVERY shell -- see CONTEXT.md trap 1
./do.sh up dev                    # build, apply, branding, migrate, outputs
./do.sh outputs dev               # writes frontend/.env.local from Terraform
cd frontend && npx next dev -p 3000
```

`./do.sh` with no arguments lists its commands. Port **3000**, not 3001:
Cognito's callback list has only `http://localhost:3000/auth/callback`.

**Never hardcode a live value.** `api_url` and `cognito_client_id` have both
changed mid-project when an apply replaced a resource. Always re-read them
with `./do.sh outputs dev`.

Local backend only, with no AWS at all:

```bash
cd backend
pip install -r requirements-dev.txt    # Python 3.11
cp ../.env.example .env                # set DATABASE_URL -- the local sandbox
python -m costhub.migrate
unset DATABASE_URL && python -m pytest -q
```

Unset `DATABASE_URL` before running the suite, or it creates schemas in
whichever database that variable points at.

### Operator commands against the deployed database

```bash
./do.sh cli dev status
./do.sh cli dev backfill --months 14 --account-id <account>
./do.sh cli dev detect --lookback 420 --scan-days 400
```

`./do.sh cli <env> <args>` resolves `DATABASE_URL` by reading it off the
**API Lambda's own configuration**, falling back to Terraform state only if
that comes back empty. Running `python -m costhub.cli` directly reads
`backend/.env` instead, which is the **local sandbox** — so `status` would
cheerfully report a healthy estate that nobody is looking at.

---

## Two databases, and they are not two environments

This is the single most expensive confusion in the project, and it has
already caused seeded rows to be read as live state.

| | What it is | Who reads it |
|---|---|---|
| **RDS** `costhub-dev-db` | the **deployed** database. Real cost data. Created by Terraform, password generated into Secrets Manager | every Lambda; `./do.sh cli`; `./do.sh migrate` |
| **Neon** | a **local sandbox** only, pointed at by `backend/.env`, full of `dev_seed` rows | a developer running the backend on their own machine |

Neon is not "the dev environment". The `dev` environment uses RDS, like
every other environment. See CONTEXT.md trap 8.

---

## Configuration

**One switch selects the environment:**

```
ENV = dev | staging | main
```

In Terraform it **is** the workspace, so state and environment cannot
disagree, and `terraform destroy` on `dev` physically cannot touch `main`.
Every resource name, log group, secret path and tag derives from it. Three
are declared; **`dev` is the only one that has ever been applied.**

**Design principle:** every account-specific value lives in exactly **three**
places. Nothing else contains an account id, ARN, URL or email.

| # | Where | What |
|---|---|---|
| 1 | `terraform/env/<env>.tfvars` | all infrastructure inputs, one file per environment, all gitignored |
| 2 | the `cloud_connections` table | one row per cloud account to read — written through the UI, never by Terraform |
| 3 | `frontend/.env.local` | API URL and Cognito ids, generated by `./do.sh outputs` |

Everything else — Lambda environment variables, IAM role ARNs, the database
URL — is **generated by Terraform**. Never hand-edit those; the next apply
overwrites them and the discrepancy is invisible until something breaks.

### 1. `terraform/env/<env>.tfvars` — the only files you edit by hand

```hcl
# env/dev.tfvars  (one file per ENV; dev shown)
# ---- identity of this deployment -------------------------------------
aws_account_id = "<12 digits>"      # Terraform REFUSES any other account
aws_region     = "us-east-1"        # Cost Explorer and Budgets are us-east-1 only
name_prefix    = "costhub"          # change to run two deployments side by side

# ---- who administers it ----------------------------------------------
superadmin_email     = "you@chryselys.com"
allowed_email_domain = "chryselys.com"

# ---- email (REQUIRED: email OTP does not work without SES) -----------
ses_sender_email = "noreply@yourdomain.com"

# ---- frontend --------------------------------------------------------
amplify_repository          = "https://github.com/<org>/<repo>"
amplify_basic_auth_user     = "demo"
amplify_basic_auth_password = "<set this>"   # declared; the branch has auth OFF

# ---- database --------------------------------------------------------
db_instance_class    = "db.t4g.micro"
db_allocated_storage = 20

# ---- narration -------------------------------------------------------
insights_model_id = "amazon.nova-lite-v1:0"  # keep in step with INSIGHTS_MODEL_ID

log_retention_days   = 7
allow_local_frontend = true        # false for a shared deployment
```

`aws_account_id` is the guard that matters. Terraform's
`allowed_account_ids` refuses to do anything if the credentials in the
environment resolve to a different account — not hypothetical, since the
machine this was built on has its default profile pointed at a work
account.

**`data_source_accounts` is optional and does not register anything.** It
only widens the `sts:AssumeRole` grant to specific ARNs. The runtime reads
accounts from the `cloud_connections` **table**, and the IAM grant is
unconditional and name-constrained — any role called `CostHubCostReader`,
at the root path, in any account. Assuming otherwise is what made the first
UI-added cross-account connection fail against a policy that did not exist.

### 2. Backend `.env` — local development only

Not used in deployment; Terraform supplies the Lambda environment instead.

```ini
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
APP_ENV=dev
ALLOWED_EMAIL_DOMAIN=chryselys.com
# ALLOW_DEV_AUTH=true     # accepts X-Dev-User. Terraform NEVER sets this.
```

### 3. `frontend/.env.local` — from Terraform outputs

`NEXT_PUBLIC_`, not `VITE_`, and `.env.local`, not `.env.production`. Next
only exposes a variable to browser code when its name starts with
`NEXT_PUBLIC_`, and it loads `.env.local` automatically. The old `VITE_*`
names were inert on both counts, so the app silently stayed on mock data
with nothing reporting it.

```ini
NEXT_PUBLIC_API_BASE_URL=https://<id>.execute-api.us-east-1.amazonaws.com
NEXT_PUBLIC_COGNITO_USER_POOL_ID=us-east-1_xxxxx
NEXT_PUBLIC_COGNITO_CLIENT_ID=xxxxx
NEXT_PUBLIC_COGNITO_DOMAIN=costhub-dev-<account>.auth.us-east-1.amazoncognito.com
NEXT_PUBLIC_AWS_REGION=us-east-1
NEXT_PUBLIC_USE_MOCK=false       # mock is the DEFAULT; only the literal
                                 # "false" turns it off, and only if the
                                 # API URL, client id and domain are all set
```

Do not type these — `./do.sh outputs dev` writes the file. None of them are
secrets: Next inlines every `NEXT_PUBLIC_` value into the client bundle, so
they are public by construction.

**For an Amplify build, set the same five in the Amplify console.** They
cannot be declared in Terraform: Amplify's domain is already an input to the
Cognito callback URLs and the Lambda CORS origins, so making the Amplify app
depend on their outputs is a cycle and Terraform refuses the plan.
`terraform/amplify.tf` carries a `lifecycle.ignore_changes` for exactly
those keys, because without it an apply **deletes whatever the console
holds** and the next build quietly falls back to mock data.

### Set outside Terraform, per account — cannot be automated

| Step | Who | Note |
|---|---|---|
| Enable "IAM User and Role Access to Billing Information" | **root** | without this, both Cost Explorer calls return `AccessDenied` regardless of policy |
| Enable Cost Explorer | billing access | once; up to 24h to populate |
| Activate cost allocation tags | billing access | **never retroactive** — do it day one |
| Verify the SES sender identity | you | **required** for email OTP |
| Verify each recipient address | you | while in the SES sandbox; 200/day is plenty |
| Create `CostHubCostReader` at the **root IAM path** | their IAM admin | read-only, ExternalId gated. Where nobody will create one, use `credential_mode = "secret"` — an access key entered once, held in Secrets Manager. **Not `profile`: it cannot run in Lambda at all** |
| Submit the Bedrock Anthropic use-case form | account owner | only if you want a Claude model; Nova Lite needs nothing |

Full reference and the account-migration runbook:
[`docs/11-configuration.md`](docs/11-configuration.md). Only **two** Cost
Explorer permissions are ever used — `ce:GetCostAndUsage` and
`ce:GetDimensionValues`; see
[`docs/17-connection-lifecycle.md`](docs/17-connection-lifecycle.md).

---

## Teardown

One command, and it proves completion rather than assuming it:

```bash
./do.sh teardown dev   # backup -> verify non-empty -> destroy -> tag sweep
```

**It has never been run.** It needs `pg_dump`, which is not installed on the
dev machine, and `do.sh` refuses up front rather than reaching the destroy
with an empty dump file. Install the PostgreSQL client tools and rehearse it
before teardown day. See
[`docs/13-environments-and-teardown.md`](docs/13-environments-and-teardown.md).

---

## Verification gates

Nothing here is optional padding; every security claim above depends on the
first one.

```bash
cd backend && unset DATABASE_URL && python -m pytest -q

cd ../frontend
node_modules/.bin/tsc --noEmit -p tsconfig.json   # must be silent
node_modules/.bin/next build                      # NOT while next dev is up
node_modules/.bin/next lint --file <changed files>
npm run verify:data                               # a gate, exits non-zero

cd .. && terraform -chdir=terraform validate
```

`next.config.mjs` ignores ESLint during builds but **not** TypeScript, so a
`tsc` error fails the Amplify build. `terraform plan` never reaches "No
changes" — two resources are a permanent diff (CONTEXT.md trap 7), which
hides real drift, so read plans carefully.

---

## Constraints that shaped the design

- Online for a short window only, so cost optimisation is irrelevant and
  simplicity wins
- No Docker on the dev machine, so hosted Postgres and zip-packaged Lambdas
- The deploy account refuses **anonymous Lambda invocation**, which is why
  there is an API Gateway HTTP API and no Function URL, and why the Lambda
  concurrency ceiling is 10
- Every Anthropic model in the deploy account is **refused** until its owner
  submits the Bedrock use-case form, which is why narration runs on Amazon
  Nova Lite
- Few accounts with real data, so multi-account and multi-cloud breadth is
  **frontend mock data**, labelled on screen and never a database row
- Every account in scope bills in **USD**, so no currency conversion exists
  anywhere
- Sign-in is **invite-only and passwordless**, so there is no credential
  store to breach and nothing to migrate between accounts

---

## The lesson this project keeps teaching

Across every review pass, **everything that had never been run was
broken.** A clean `terraform apply` and a passing test suite said nothing
about whether the thing answered a request — at one point the "deployed and
tested" backend could not serve a single one. Invoke it, curl it, check the
status code. And verify an agent's claim before acting on it: acting on a
confident falsehood broke a working Terraform config here.
