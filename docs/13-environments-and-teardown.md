# Environments and teardown

Two day-one requirements that shape everything else:

1. **One switch** selects the environment. Nothing else is edited to move
   between `dev`, `staging` and `main`.
2. **One command** removes every resource, leaving only a verified data
   backup.

---

## 1. The single switch

```
ENV = dev | staging | main
```

Set it once per context. Every name, path, secret, log group and tag derives
from it. Nothing else in the repository names an environment.

| Context | Where `ENV` comes from |
|---|---|
| Terraform | `terraform.workspace` — the workspace **is** the environment |
| Backend (local) | `APP_ENV` in `.env` |
| Backend (Lambda) | `APP_ENV`, set by Terraform from the workspace |
| Frontend (local) | `frontend/.env.local`, written by `./do.sh outputs <env>` |
| Frontend (Amplify) | per-branch environment variables, set **in the console** — a dependency cycle keeps them out of terraform |

### Why Terraform workspaces, not `-var env=`

```hcl
locals {
  env    = terraform.workspace
  prefix = "costhub-${terraform.workspace}"
}

# refuse to deploy into the implicit workspace
resource "terraform_data" "workspace_guard" {
  lifecycle {
    precondition {
      condition     = contains(["dev","staging","main"], terraform.workspace)
      error_message = "Select a workspace: terraform workspace select dev|staging|main"
    }
  }
}
```

A workspace carries its **own state**. Because `env` is derived from the
workspace rather than passed in, state and environment cannot disagree —
there is no flag to forget. And `terraform destroy` acts only on the
selected workspace, so tearing down `dev` physically cannot touch `main`.

That safety property is why this and not a `-var`.

### Everything derives from the prefix

| Thing | Pattern |
|---|---|
| Resource names | `costhub-${env}-<role>` |
| Lambda log groups | `/aws/lambda/costhub-${env}-<fn>` |
| Secrets | `costhub/${env}/database-url` |
| Terraform outputs | `superadmin_email` is exported so `restore` can find the seeded row |
| Cognito pool | `costhub-${env}` |
| Amplify branch | `${env}` |
| Database name | `costhub` (not per-environment) |
| Tags | `Project=costhub`, `Environment=${env}`, `ManagedBy=terraform` |

### Per-environment values: one file each

Values that genuinely must differ live in exactly one file per environment,
named after it. There is nowhere else to look.

```
terraform/env/
├── dev.tfvars
├── staging.tfvars
└── main.tfvars
```

```hcl
# env/dev.tfvars
db_instance_class    = "db.t4g.micro"
db_allocated_storage = 20
log_retention_days   = 3
amplify_basic_auth_password = "<set>"
ses_sender_email     = "noreply@yourdomain.com"
superadmin_email     = "you@chryselys.com"
data_source_accounts = [
  { account_id = "self", name = "Deploy account", role_arn = null, external_id = null },
]
```

A shared environment should differ in `log_retention_days` and set
`allow_local_frontend = false`, so a deployed API does not advertise a
developer's laptop as an allowed CORS origin with `allow_credentials =
true`. Nothing else needs to differ.

`data_source_accounts` can stay empty: it only widens the
`sts:AssumeRole` grant to named ARNs, and the grant is already
name-constrained to any root-path `CostHubCostReader` in any account.
Connections themselves live in the `cloud_connections` table and are
registered through the UI.

### Usage

```bash
cd terraform
terraform workspace select dev          # or: terraform workspace new dev
terraform apply -var-file=env/dev.tfvars
```

### Backend convention

`config.py` is **almost** the only module that reads `os.environ`, and
everything else takes a `Settings` object — one place to audit, one place
to change. The exceptions are real and worth naming rather than repeating
the stronger claim: `lambda_handlers.py` reads `INGEST_DAYS` and
`ALLOWED_EMAIL_DOMAIN` directly, because a Lambda entry point runs before
`Settings` is useful, and the `insights` package reads its `INSIGHTS_*`
variables directly.

```python
class Settings(BaseSettings):
    # NOT "dev". Terraform sets APP_ENV to the workspace name, so a
    # default of "dev" meant a deployed dev environment permanently
    # satisfied one of the three dev-auth conditions.
    app_env: str = "prod"
    database_url: str
    # Never set by terraform, which is what keeps the X-Dev-User
    # bypass unreachable in any deployed environment.
    allow_dev_auth: bool = False
    ...
```

An insecure default is not a default.

### Frontend convention

One Amplify app, one branch per environment, per-branch environment
variables. Pushing to `dev` deploys dev; pushing to `main` deploys main. No
build-time environment selection logic to get wrong.

---

## 2. One-command teardown

```bash
./do.sh teardown dev
```

Four steps, and the verification steps are the point — a teardown you
cannot confirm is not a teardown.

> **This has never been run.** It needs `pg_dump`, which is not installed
> on the dev machine, and `do.sh` checks for the PostgreSQL client tools up
> front and refuses rather than reaching the destroy with an empty dump
> file. Install them and rehearse this on a throwaway apply **before**
> teardown day — everything in this project that had never been run turned
> out to be broken.

```
1. BACKUP   pg_dump app tables → backups/<env>-<utc-timestamp>.sql
2. VERIFY   refuse to continue if the dump is empty or missing users
3. DESTROY  terraform destroy on that workspace only
4. SWEEP    list anything still tagged Project=costhub,Environment=<env>
```

### Step 1 — what gets backed up

| Backed up | Not backed up |
|---|---|
| `users`, `identities` | `fact_cost_daily` |
| `access_grants` | `ingest_runs` |
| `cloud_connections` | `dim_account`, `dim_service` |
| `alert_rules` | |
| `audit_log` | |
| `anomaly_findings` | |

Facts are re-ingested from Cost Explorer, which is faster than moving them
and proves the pipeline works wherever it lands next.

Backups are written to `./backups/` (gitignored). Deliberately **not** S3 —
a backup bucket would either be inside the destroy scope, which defeats the
purpose, or need its own bootstrap outside it. Local keeps "leaving only
backup data" literally true.

### Step 2 — the guard that matters

```bash
grep -qE '^INSERT INTO (public\.)?users ' "$out" || {
  echo "ABORT: backup contains no users"; exit 1; }
```

Without this, a failed `pg_dump` plus an `-auto-approve` destroy silently
loses every grant and the entire audit trail. The abort is the whole value
of wrapping destroy in a target rather than running it by hand.

### Step 3 — the flags that make destroy succeed first time

Set on every resource from day one. Without them destroy fails halfway and
leaves debris to delete by hand.

```hcl
force_destroy           = true     # S3 — fails on non-empty buckets
skip_final_snapshot     = true     # RDS
deletion_protection     = false    # RDS
recovery_window_in_days = 0        # Secrets Manager — see below
force_delete            = true     # ECR, if ever used
deletion_protection     = "INACTIVE"   # Cognito
```

**Secrets Manager is the classic failure.** The default 30-day recovery
window means a destroy-then-recreate cycle fails with *"secret already
scheduled for deletion"*. `0` deletes immediately.

**Declare Lambda log groups explicitly.** Lambda creates
`/aws/lambda/<name>` implicitly, Terraform does not know about it, and it
survives destroy as orphaned cost plus a naming collision on the next apply.

### Step 4 — proving it worked

Every taggable resource is tagged automatically:

```hcl
provider "aws" {
  default_tags {
    tags = {
      Project     = "costhub"
      Environment = local.env
      ManagedBy   = "terraform"
    }
  }
}
```

Which makes the sweep possible:

```bash
aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=Project,Values=costhub \
                Key=Environment,Values=$ENV \
  --query 'ResourceTagMappingList[].ResourceARN' --output text
```

Empty output = teardown complete. Any ARN = something was created outside
Terraform, or a flag is missing. This is the only way to *confirm* rather
than assume.

**One class of resource the sweep has to catch, because `destroy` cannot.**
A connection in `credential_mode = "secret"` has its access key written to
Secrets Manager **by the API at runtime**, under
`costhub/<env>/connections/*`. Terraform does not know those secrets exist,
so `destroy` will not remove them and `default_tags` cannot reach them —
which is why `key_store.py` tags each one `Project` / `Environment`
itself, and why the Lambda role holds `secretsmanager:TagResource`.
Untagged, a live credential would survive a teardown with nothing to reveal
it. If the sweep lists one, delete it.

### Deliberate exceptions

Three things survive teardown on purpose. Each is account-level
configuration rather than a deployment resource, and destroying them would
mean re-doing a wait or asking another team.

| Survives | Why |
|---|---|
| **SES verified identities** | re-verification is a manual round trip; kept outside Terraform |
| **`CostHubCostReader`** in data-source accounts | we do not own those accounts |
| Account-level billing settings (IAM billing access, Cost Explorer, cost allocation tags) | root-only, and tag activation is **never retroactive** |

### The rule no flag can replace

**Nothing is created by hand. Ever.** One console-created resource and the
sweep in step 4 reports it forever, and the next apply collides with it.

---

## 3. Restore

```bash
./do.sh restore dev backups/dev-20261010T0400Z.sql
```

1. `terraform apply` the environment
2. `python -m costhub.migrate`
3. restore the dump
4. re-ingest facts
5. re-verify: SES recipients are per-account, and the cross-account role's
   trust policy must name the **current** deploy account

Step 5 is where migrations actually fail. See
[11-configuration.md](11-configuration.md).

Users need no credential restore — sign-in is passwordless, so they are
recreated with `AdminCreateUser` from the restored `users` table.

---

## Make targets

| Target | Does |
|---|---|
| `./do.sh up <env>` | workspace select, apply, migrate |
| `./do.sh teardown <env>` | backup → verify → destroy → sweep |
| `./do.sh restore <env> <file>` | apply, migrate, restore, re-ingest |
| `./do.sh export-data <env>` | backup only |
| `./do.sh sweep <env>` | tag sweep only, no changes |
| `./do.sh outputs <env>` | write `frontend/.env.local` from Terraform outputs |
| `./do.sh cli <env> <args>` | run `costhub.cli` against the **deployed** database, reading `DATABASE_URL` off the api Lambda |

`ENV` is required on every target. No default — defaulting to an
environment is how the wrong one gets destroyed.
