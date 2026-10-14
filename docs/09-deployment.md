# Deployment

One Terraform root module, applied to the deploy account. Every other cloud
account is a data source only, reached read-only.

One environment exists: `dev`, in a single AWS account, us-east-1.
`staging` and `main` are supported by the code and have never been applied.

---

## Prerequisites

### On the machine you deploy from

| Tool | Why | Note |
|---|---|---|
| Terraform | the whole deployment | `required_version >= 1.5`; `.terraform.lock.hcl` **is committed**, so the provider version is pinned — do not delete it to "fix" an init |
| AWS CLI v2 | `do.sh` probes what the tagging API cannot see | must be authenticated to the deploy account |
| Python 3.11+ | the Lambda bundle and the CLI | |
| **PostgreSQL client tools** (`pg_dump`, `psql`) | **`teardown`, `export-data` and `restore`** | **not** bundled with the AWS CLI or Git for Windows. `winget install PostgreSQL.PostgreSQL.17`, then put `…\PostgreSQL\17\bin` on PATH |

`pg_dump` is the one that bites. Teardown takes a backup *before* it
destroys anything, so without the client tools that step cannot run —
`do.sh` now checks for both up front and refuses rather than reaching the
destroy with an empty dump file. The client also has to be at least as
new as the server, so a Postgres 17 database needs a 17 client.

### In the deploy account (you are root)

| # | Step | Note |
|---|---|---|
| 1 | Enable **"IAM User and Role Access to Billing Information"** | Account settings; root only |
| 2 | Enable **Cost Explorer** | once; up to 24h to populate |
| 3 | Activate **cost allocation tags** | **never retroactive** — do this on day one or the history is lost |
| 4 | *(Terraform creates the Budget — no manual step)* | thresholds are 50% / 80% of `budget_limit_usd` |
| 5 | Verify an **SES** sender identity | **required** — email OTP does not work without SES. Also verify each recipient while in sandbox (200/day, no approval needed) |

Steps 2, 3 and 5 all have waiting periods and are all free. Do them first.

Step 1 is the gate people lose a day to: with it off, a correct IAM policy
still returns `AccessDenied` on every cost API. Sender-identity choice and
the DMARC trap are in [11-configuration.md](11-configuration.md).

### In each data-source account

Requires someone with root and someone with IAM access:

| # | Step | Who |
|---|---|---|
| 1 | Enable "IAM User and Role Access to Billing Information" | **root** |
| 2 | Confirm Cost Explorer is enabled | billing access |
| 3 | Create role `CostHubCostReader`, **at the root IAM path** | IAM access |

Role specification. **Only two Cost Explorer permissions are ever used** —
verified against the code, which calls `get_cost_and_usage` and
`get_dimension_values` and nothing else:

```json
// permissions
{ "Effect": "Allow",
  "Action": ["ce:GetCostAndUsage", "ce:GetDimensionValues"],
  "Resource": "*" }

// trust policy
{ "Effect": "Allow",
  "Principal": { "AWS": "arn:aws:iam::<DEPLOY_ACCOUNT_ID>:root" },
  "Action": "sts:AssumeRole",
  "Condition": { "StringEquals": { "sts:ExternalId": "<EXTERNAL_ID>" } } }
```

Cost Explorer has no resource-level permissions, so `"Resource": "*"` is
the only valid value. `AWSBillingReadOnlyAccess` is the managed-policy
alternative — far broader than two actions, but sometimes an easier
approval.

**The role name and path are both load-bearing.** Our own policy grants
`arn:aws:iam::*:role/CostHubCostReader` — exactly that name, at the root
path. A role created under a path has the ARN
`...:role/<path>/CostHubCostReader`, which is a valid ARN, so STS evaluates
it and answers `AccessDenied` — and it is **our** policy denying it, before
their trust policy is consulted. The connection probe detects that case and
says so.

This role is **deliberately outside our Terraform**: we do not own that
account, and it must survive our teardown.

**If nobody in that account will create a role**, use
`credential_mode = "secret"` instead: an access key entered once in the
browser, written to Secrets Manager, with only the ARN stored. Do **not**
reach for `credential_mode = "profile"` — it cannot run in Lambda at all.
See [17-connection-lifecycle.md](17-connection-lifecycle.md).

---

## Terraform layout

```
terraform/
├── main.tf          providers, locals, the workspace guard,
│                    allowed_account_ids, default_tags
├── variables.tf     region, name_prefix, schedules, db sizing,
│                    insights_model_id, allow_local_frontend
├── iam.tf           the shared Lambda role + four separate policies:
│                    base, assume-cost-roles, insights-bedrock,
│                    connection-secrets
├── network.tf       security group for the database
├── database.tf      RDS instance, subnet group, parameter group, AZ filter
├── lambda.tf        4 app functions + presignup, from one zip. NO Function URL
├── apigateway.tf    the HTTP API, integration, $default route and stage,
│                    throttling, and the service-principal permission
├── schedule.tf      EventBridge rules for ingest, anomaly, alerts
├── cognito.tf       user pool, client, Managed Login domain, superadmin user
├── amplify.tf       app, branch, the co-owned environment_variables map
├── messaging.tf     budget + the composed SES identity ARN
│                    (neither the identity nor any topic is managed here)
├── secrets.tf       the generated database password and its secret
├── logs.tf          explicit log groups with retention
└── outputs.tf       frontend URL, API URL, pool id, DB endpoint, tags
```

`presignup` is deliberately a **separate** resource from the four app
functions: the user pool needs that function's ARN while the others need
the pool's id, so keeping them in one `for_each` is a dependency cycle.
Splitting it is also honest, since the trigger needs none of the pool's
configuration.

Single root module, **local state**. An S3 backend has a bootstrap
chicken-and-egg that is not worth it for a 10-day project — but never commit
`terraform.tfstate`; it contains secrets.

---

## Teardown — designed in, not bolted on

`terraform destroy` must work first time, every time. These flags are what
make that true; without them destroy fails halfway and leaves debris to
delete by hand.

```hcl
# S3 — destroy fails on a non-empty bucket
force_destroy = true

# RDS — both required
skip_final_snapshot = true
deletion_protection = false

# Secrets Manager — THE classic failure
recovery_window_in_days = 0
# default is 30 days, so a destroy/recreate cycle fails with
# "secret already scheduled for deletion"

# ECR (if ever used)
force_delete = true

# Cognito
deletion_protection = "INACTIVE"
```

**Declare Lambda log groups explicitly.** Lambda creates
`/aws/lambda/<name>` implicitly; Terraform does not know about it, so it
survives destroy as orphaned cost and a naming collision on re-apply.

```hcl
resource "aws_cloudwatch_log_group" "fn" {
  name              = "/aws/lambda/${local.prefix}-${each.key}"
  retention_in_days = 7
}
```

### The rule that matters more than any flag

**Nothing is created by hand. Ever.** One console-created resource and
`destroy` leaves debris, and the next apply collides with it. This is the
single most common reason teardown fails.

---

## Account portability

| Requirement | How |
|---|---|
| No hardcoded account ids | `data.aws_caller_identity.current` |
| Coexisting deployments | `name_prefix` variable on every resource |
| Switch target account | change the AWS profile and `terraform apply` |
| Remove the old one | `terraform destroy` against the old profile |

### The step nobody plans for

**`terraform destroy` deletes the data too.** Migration therefore needs an
explicit data step:

```bash
./do.sh export-data <env>   # pg_dump users, identities, access_grants,
                   # cloud_connections, alert_rules, audit_log
./do.sh restore   # restore into the new account's fresh database
```

Facts are **not** migrated — they are re-ingested from Cost Explorer, which
is faster than moving them and proves the pipeline works in the new account.

A payoff from the auth choice: because sign-in is **passwordless**, there are
no credentials to migrate. Cognito users cannot be exported with passwords,
but email OTP means users are recreated with `AdminCreateUser` straight from
our own `users` table.

---

## Deploy sequence

### First: make sure you are pointed at the right account

`aws_account_id` in each `.tfvars` is the account that environment is
allowed to deploy into. Terraform's `allowed_account_ids` enforces it and
`do.sh check_account` says the same thing one step earlier, in one line.

This is not hypothetical. The machine this was built on has its **default
profile pointed at a work account**, so without the guard `./do.sh up dev`
would have begun creating the whole stack there and failed partway through
on a permission denial. Use a named profile for the deploy account:

```bash
aws configure --profile costhub          # once
export AWS_PROFILE=costhub               # every shell
aws sts get-caller-identity              # confirm before anything else
```

**One command.** `do.sh up` is the deploy; the steps below are what it does,
not things to run by hand.

```bash
# 0. once per clone: the three gitignored tfvars
cp terraform/env/dev.tfvars.example terraform/env/dev.tfvars
cp terraform/env/dev.tfvars.example terraform/env/staging.tfvars
cp terraform/env/dev.tfvars.example terraform/env/main.tfvars
$EDITOR terraform/env/dev.tfvars        # superadmin_email, ses_sender_email
terraform -chdir=terraform init

# 1. deploy
./do.sh up dev
```

`up` runs, in order: `build` (Linux wheels for the Lambda runtime) →
`terraform apply` → `ensure_login_branding` → `migrate` → `outputs`.

```bash
# 2. point it at an account to read -- or do this in the UI, which is
#    the normal path and gives you the two-stage probe and an inline import
./do.sh cli dev add-connection \
  --provider aws --account-id self --name "Deploy account"

# 3. first ingest, and then score what it wrote
./do.sh cli dev backfill --months 14 --account-id <account>
./do.sh cli dev detect --lookback 420 --scan-days 400
```

Step 3 uses a wide `--scan-days` on purpose: the detector's defaults score
only the last 7 days, which finds nothing in freshly imported back history.

`./do.sh cli` is what points `DATABASE_URL` at the **deployed** database.
Running `python -m costhub.cli` directly reads `backend/.env`, which is the
local Neon sandbox.

### What this does NOT need

- **No targeted apply.** An earlier version of this page said to run
  `terraform apply -target=aws_db_instance.main` first, "because Lambda's
  environment needs the DB endpoint". It does, and Terraform works that
  out on its own: `local.database_url` references
  `aws_db_instance.main.address`, so the graph already orders them. One
  apply is enough.
- **No `bootstrap-admin`.** `migrations/006` seeds the superadmin row and
  `aws_cognito_user.superadmin` creates the pool user, both from
  `superadmin_email`. The CLI command still exists for promoting someone
  later.

### The database is RDS. Neon is not an environment

`backend/.env` points at Neon, and that is **a local development sandbox,
nothing more** — it is full of `dev_seed` rows. Every environment, `dev`
included, uses RDS: the stack creates `aws_db_instance.main` and composes
`DATABASE_URL` from it with a Terraform-generated password (`secrets.tf`).
Nothing deployed ever reads the Neon URL.

On a `db.t4g.micro` with 20 GB that is roughly $0.5/day — the one line item
in this stack that is not free, and it stops when you tear down.

Conflating the two has already caused someone to read 1,428 seeded rows as
live state. To talk to the deployed database, go through `do.sh`:

```bash
./do.sh cli dev status
```

`./do.sh cli <env> <args>` resolves `DATABASE_URL` by reading it off the
**API Lambda's own configuration** (`aws lambda
get-function-configuration --function-name costhub-<env>-api`), falling
back to Terraform state only if that comes back empty. Reading it from the
Lambda means the CLI agrees with whatever the deployed API is actually
using, and needs no Terraform state at all. CONTEXT.md trap 8.

### If the API returns 403 and Terraform says everything applied

**Do not reach for a Lambda Function URL.** There is no longer one, and
adding one back will not work: this account blocks **anonymous Lambda
invocation**. A Function URL with a textbook-correct public resource policy
returned `403 AccessDeniedException` to every request with no invocation
recorded in CloudWatch, and a hand-built throwaway function URL did the
same — so it was never this stack's configuration. The evidence is written
up in the header comment of `terraform/apigateway.tf`.

The API is reached through the HTTP API, which invokes the function as the
`apigateway.amazonaws.com` **service principal**. If a 403 comes back now,
check that permission before anything else:

```bash
aws lambda get-policy --function-name costhub-dev-api
# expect a statement AllowAPIGatewayInvoke with
# Principal apigateway.amazonaws.com and a SourceArn ending /*/*
```

One piece of cleanup is **not** in Terraform. While the 403 was being
diagnosed, the console added a duplicate public-access statement. Terraform
does not know about it, so clear it by hand:

```bash
aws lambda remove-permission --function-name costhub-dev-api \
  --statement-id FunctionURLAllowPublicAccess --region us-east-1
```

If the API returns 500 on every request and the browser reports a CORS
error, that is a different failure with the same symptom — see
[05-backend.md](05-backend.md) on the middleware order, and CONTEXT.md trap
3 on `*.dist-info`.

---

## Deployment permissions

Not needed when you are root in the deploy account. This is the list **if**
someone insists on deploying into an account where you are not.

| Service | Actions |
|---|---|
| IAM | `CreateRole`, `DeleteRole`, `GetRole`, `TagRole`, `AttachRolePolicy`, `DetachRolePolicy`, `PutRolePolicy`, `DeleteRolePolicy`, **`PassRole`** |
| Lambda | `CreateFunction`, `DeleteFunction`, `GetFunction`, `UpdateFunctionCode`, `UpdateFunctionConfiguration`, `AddPermission`, `TagResource` |
| API Gateway v2 | `CreateApi`, `DeleteApi`, `GetApi`, `CreateIntegration`, `CreateRoute`, `CreateStage`, `UpdateStage`, `TagResource` |
| RDS | `CreateDBInstance`, `DeleteDBInstance`, `DescribeDBInstances`, `ModifyDBInstance`, `CreateDBSubnetGroup`, `CreateDBParameterGroup`, `ModifyDBParameterGroup`, `AddTagsToResource` |
| EC2 (networking) | `DescribeVpcs`, `DescribeSubnets`, `DescribeSecurityGroups`, `CreateSecurityGroup`, `AuthorizeSecurityGroupIngress`, `RevokeSecurityGroupIngress`, `DeleteSecurityGroup`, `CreateTags` |
| Secrets Manager | `CreateSecret`, `PutSecretValue`, `GetSecretValue`, `DescribeSecret`, `DeleteSecret`, `TagResource` |
| Amplify | `CreateApp`, `CreateBranch`, `UpdateApp`, `UpdateBranch`, `DeleteApp`, `DeleteBranch`, `CreateDeployment`, `StartDeployment`, `GetApp`, `ListApps` |
| EventBridge | `PutRule`, `PutTargets`, `DeleteRule`, `RemoveTargets`, `DescribeRule` |
| CloudWatch Logs | `CreateLogGroup`, `DeleteLogGroup`, `PutRetentionPolicy`, `DescribeLogGroups` |
| SES | `VerifyEmailIdentity`, `SendEmail`, `GetIdentityVerificationAttributes` |
| Cognito | `CreateUserPool`, `CreateUserPoolClient`, `CreateUserPoolDomain`, `UpdateUserPool`, `DeleteUserPool`, `AdminCreateUser`, `SetUserPoolMfaConfig` |
| STS | `GetCallerIdentity` |

**How to actually ask.** Itemising 60 actions will stall in review. Ask for
**`PowerUserAccess`** (covers everything except IAM) **plus** a small policy
allowing `CreateRole` / `PassRole` / `AttachRolePolicy` **restricted to the
path `/costhub/`**. Path-scoped role creation is a much easier approval,
because it provably cannot touch anything else.

Without `iam:CreateRole` and `iam:PassRole` you cannot deploy at all — a
Lambda function requires an execution role.

---

## Environments

Every environment is the same code against the same shape of
infrastructure. Only the Terraform workspace differs, and from it every
resource name, log group, secret path and tag (NFR-21).

| | Local development | A deployed environment |
|---|---|---|
| Database | **Neon sandbox**, `backend/.env`, `dev_seed` rows | **RDS** `costhub-<env>-db`, real cost data |
| API | `uvicorn costhub.api.main:app --reload` | the api Lambda behind the HTTP API |
| Frontend | `npx next dev -p 3000` | the Amplify branch named after the workspace |
| Jobs | run by hand through `./do.sh cli <env> …` | EventBridge, 06:00 / 06:30 / 07:00 UTC |
| Auth | Cognito, or the `X-Dev-User` header if `ALLOW_DEV_AUTH` is set | Cognito only — Terraform never sets that variable |

Neon is on the **left-hand** column only. It is not the `dev` environment;
`dev` uses RDS. See
[13-environments-and-teardown.md](13-environments-and-teardown.md).

---

## Demo-day checklist

- [ ] `./do.sh outputs dev` run, and `NEXT_PUBLIC_*` matching it in the
      Amplify console — an apply has wiped those before
- [ ] `NEXT_PUBLIC_USE_MOCK` set deliberately, and the sidebar badge
      checked on screen to confirm which mode is live
- [ ] Budget alerts active (50% / 80% of `budget_limit_usd`)
- [ ] SES sender verified, and each recipient verified if still sandboxed
- [ ] A test code received in a real inbox on the allowed domain
- [ ] Every connection ingesting; `/admin/connections` shows a recent
      success and `/admin/ingest-runs` has no stuck `running` row
- [ ] `CodeSha256` checked on **all five** functions — the job Lambdas run
      an older build than `api` unless the deploy named them
- [ ] Superadmin and a restricted analyst both invited and signed in
- [ ] A no-grant user exists, to demonstrate the empty state
- [ ] Anomaly findings present in the window being shown; after a backfill
      that needs a wide `--scan-days`, since the default scores 7 days
- [ ] `as_of` visible on every chart
- [ ] `pg_dump` installed and `./do.sh teardown` rehearsed — it has
      **never been run**
