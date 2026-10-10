# Cloud Cost Intelligence Hub

One scoped view of cloud cost across **independent** AWS accounts, with
per-user visibility control, anomaly detection and alerting.

Hackathon project — Team 12, The Cloud Minds.

---

## The problem, stated precisely

Costs live in **separate AWS accounts that are not in an AWS Organization**.
That single fact is what makes this worth building:

- Cost Explorer, Budgets and Cost Anomaly Detection are **per-payer**. With
  independent accounts there is no consolidated view — you log into each
  account separately. That is the pain.
- Cost data is **sensitive**. Not everyone may see every account's spend,
  so a consolidated view needs per-user scoping, not just aggregation.

## What already exists, and why we still build

Being honest about this is part of the deliverable. AWS ships
[Cloud Intelligence Dashboards](https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/focus-dashboard.html)
(MIT-0), which **does** aggregate multiple independent payers and **does**
offer row-level security via QuickSight. It also carries official Azure,
GCP and OCI connectors.

We stand on that rather than compete with it. What CID does not give us:

| Gap | Why it stays open |
|---|---|
| Optimisation detail | AWS's own FAQ states FOCUS omits `lineItem/Operation` and is therefore not recommended for cost optimisation |
| Unit economics | No vendor knows what a *pipeline run*, *project* or *client* is |
| Cross-payer anomaly narration in one pane | AI cost investigations live in each source account's console |
| Per-seat cost | QuickSight Enterprise is $3–$40/user/month plus a $250/month fee once Q is enabled |

See [`docs/01-requirements.md`](docs/01-requirements.md) for scope and
[`docs/10-todo-future.md`](docs/10-todo-future.md) for what we deliberately deferred.

---

## Documentation index

| Doc | Contents |
|---|---|
| [01-requirements.md](docs/01-requirements.md) | Functional and non-functional requirements |
| [02-architecture.md](docs/02-architecture.md) | High-level, component and deployment architecture |
| [03-data-model.md](docs/03-data-model.md) | All 13 tables, ERD, audit conventions |
| [04-data-flow.md](docs/04-data-flow.md) | Ingest, query, alert and anomaly flows |
| [05-backend.md](docs/05-backend.md) | Backend modules, responsibilities, references |
| [06-frontend.md](docs/06-frontend.md) | Screens, components, references |
| [07-security-rbac.md](docs/07-security-rbac.md) | The grant predicate, auth, audit |
| [08-aws-services.md](docs/08-aws-services.md) | Every AWS service used, why, and cost |
| [09-deployment.md](docs/09-deployment.md) | Terraform, required permissions, teardown |
| [10-todo-future.md](docs/10-todo-future.md) | Deferred security and functional work |
| [11-configuration.md](docs/11-configuration.md) | Every config value, email setup, account-migration runbook |
| [12-build-checklist.md](docs/12-build-checklist.md) | Everything to be built, by area |
| [13-environments-and-teardown.md](docs/13-environments-and-teardown.md) | The `ENV` switch, and one-command teardown |
| [14-frontend-build-spec.md](docs/14-frontend-build-spec.md) | **Buildable frontend spec: 9 pages, data per page, states** |

---

## Shape in one picture

```
  AWS: personal                AWS: stemline
  (deploy target +             (data source only,
   data source)                 cross-account read role)
        │                              │
        └──────────────┬───────────────┘
                       ▼
            ingest (Lambda, scheduled)
                       ▼
            Postgres  —  daily rollup + app state
                       ▼
            query/scoped.py   ★ single authorization point
                       ▼
        ┌──────────────┼──────────────┐
     anomaly        alerts           api
                                      ▼
                            Amplify-hosted frontend
```

**The one invariant:** nothing reads the fact table except
`query/scoped.py`, and that module always applies the grant predicate.
Get that right and the RBAC holds regardless of what the UI later does.

---

## Configuration — everything you need to edit

**One switch selects the environment:**

```
ENV = dev | staging | main
```

In Terraform it *is* the workspace, so state and environment cannot
disagree, and `terraform destroy` on `dev` physically cannot touch `main`.
Every resource name, log group, secret path and tag derives from it. See
[13-environments-and-teardown.md](docs/13-environments-and-teardown.md).

**Design principle:** every account-specific value lives in exactly **three**
places. Nothing else contains an account id, ARN, URL or email. That is what
makes moving to another account a variable change rather than a hunt.

| # | Where | What |
|---|---|---|
| 1 | `terraform/env/<env>.tfvars` | all infrastructure inputs, one file per environment |
| 2 | `cloud_connections` table | one row per cloud account to read |
| 3 | `frontend/.env.<env>` | API URL + Cognito ids (generated from Terraform outputs) |

**Teardown is one command**, and it proves completion rather than assuming it:

```bash
./do.sh teardown dev   # backup → verify non-empty → destroy → tag sweep
```

Everything else — Lambda environment variables, Amplify environment
variables, IAM role ARNs — is **generated by Terraform**. Never hand-edit
those; they will be overwritten on the next apply.

### 1. `terraform/env/<env>.tfvars` — the only files you edit by hand

```hcl
# env/dev.tfvars  (one file per ENV; dev shown)
# ---- identity of this deployment -------------------------------------
aws_region   = "us-east-1"          # Cost Explorer is us-east-1 only
name_prefix  = "costhub"         # change to run two deployments side by side

# ---- who administers it ----------------------------------------------
superadmin_email     = "you@chryselys.com"
allowed_email_domain = "chryselys.com"

# ---- email (REQUIRED: email OTP does not work without SES) -----------
ses_sender_email  = "noreply@yourdomain.com"
ses_sender_region = "us-east-1"

# ---- stakeholder gate on the frontend --------------------------------
amplify_repo_url         = "https://bitbucket.org/<org>/costhub-frontend"
amplify_branch           = "main"
amplify_basic_auth_user  = "demo"
amplify_basic_auth_pass  = "<set this>"

# ---- database --------------------------------------------------------
db_instance_class    = "db.t4g.micro"
db_allocated_storage = 20

# ---- accounts to read cost data from ---------------------------------
# account_id "self" = this deployment account, read with the Lambda role
data_source_accounts = [
  { account_id = "self",         name = "personal", role_arn = null, external_id = null },
  { account_id = "881953306582", name = "stemline",
    role_arn    = "arn:aws:iam::881953306582:role/CostHubCostReader",
    external_id = "costhub-7f3a9c21" },
]

log_retention_days = 7
```

Account-specific values are **only** `superadmin_email`, `ses_sender_email`,
`amplify_repo_url`, `amplify_basic_auth_pass` and `data_source_accounts`.
`aws_region` and `name_prefix` are set once; `name_prefix` is suffixed with
`ENV` automatically, so it is not per-environment.
The rest are portable as-is.

### 2. Backend `.env` — local development only

Not used in deployment; Terraform supplies the Lambda environment instead.

```ini
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
APP_ENV=dev
SYSTEM_ACTOR=system@costhub
ALLOWED_EMAIL_DOMAIN=chryselys.com
COGNITO_USER_POOL_ID=us-east-1_xxxxx     # from terraform output
COGNITO_CLIENT_ID=xxxxx                  # from terraform output
```

### 3. `frontend/.env.production` — from Terraform outputs

```ini
VITE_API_BASE_URL=https://xxxx.lambda-url.us-east-1.on.aws
VITE_COGNITO_USER_POOL_ID=us-east-1_xxxxx
VITE_COGNITO_CLIENT_ID=xxxxx
VITE_COGNITO_DOMAIN=costhub.auth.us-east-1.amazoncognito.com
VITE_AWS_REGION=us-east-1
VITE_USE_MOCK=false                      # showcase fixtures; OFF by default
```

All five of the first values come from `terraform output`. Generate rather
than type them:

```bash
cd terraform && terraform output -json > ../frontend/tf-outputs.json
```

### Set outside Terraform (per account, cannot be automated)

| Step | Who | Note |
|---|---|---|
| Enable "IAM User and Role Access to Billing Information" | **root** | without this every cost API returns AccessDenied |
| Enable Cost Explorer | billing access | once; up to 24h to populate |
| Activate cost allocation tags | billing access | **never retroactive** — do it day one |
| Verify the SES sender identity | you | **required** for email OTP |
| Verify each recipient address | you | SES sandbox; 200/day is plenty for a demo |
| Create `CostHubCostReader` in each data-source account | their IAM admin | read-only, External ID gated |

Full reference and the account-migration runbook:
[`docs/11-configuration.md`](docs/11-configuration.md).

## Quickstart (dev)

```bash
python -m venv .venv && . .venv/Scripts/activate   # Python 3.11
pip install -r requirements-dev.txt
cp .env.example .env            # set DATABASE_URL (Neon for dev)
python -m costhub.migrate
pytest
```

No Docker required. See [09-deployment.md](docs/09-deployment.md) for the
hosted path.

## Status

| Area | State |
|---|---|
| Documentation (11 files) | complete |
| Schema (migrations 001–003) | written |
| `query/scoped.py` | written |
| `rbac/admin.py`, `audit.py`, `db.py`, `config.py` | written |
| `cloud_connections` (004), audit append-only (005) | written |
| ingest (`cost_explorer`, `dev_seed`, runner, CLI) | written |
| API — 20 endpoints, Swagger at `/docs` | written |
| `azure_cm` adapter | written, unit-tested, **unverified live** |
| anomaly detection (MAD, shape-classified) | written |
| alerts (4 rule types, FR-34) | written |
| Terraform (39 resources) + `do.sh` | written, plan clean |
| Frontend + showcase fixtures | **pending** (teammate) |

### Build order

1. `cloud_connections` + Cost Explorer adapter + backfill → real data on screen
2. API routes wired to `query/scoped` → RBAC demonstrable
3. Anomaly + alerts → the differentiated parts
4. Azure adapter → ready for the access request
5. Terraform → deploy

The frontend proceeds in parallel against the API contract in
[`docs/06-frontend.md`](docs/06-frontend.md), which is already fixed.

## Constraints that shaped the design

- Online for ~10 days only → cost optimisation is irrelevant, simplicity wins
- No Docker on the dev machine → hosted Postgres, zip-packaged Lambdas
- Deploy rights exist only in the personal account → stemline is read-only
- Personal account is on AWS's post-July-2025 **credit model**, not the
  legacy 12-month free tier
- Only two accounts with real data, one of them nearly idle → multi-account
  and Azure views are **frontend fixtures**, labelled and removable
- Every account bills in **USD** → no currency conversion anywhere
- **No passwords exist** → invite-only, email OTP every sign-in
