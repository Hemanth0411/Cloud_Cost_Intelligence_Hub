# Deployment

One Terraform root module, applied to the personal account. Stemline is a
data source only.

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

### In the deploy account (personal — you are root)

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

### In each data-source account (stemline)

Requires someone with root and someone with IAM access:

| # | Step | Who |
|---|---|---|
| 1 | Enable "IAM User and Role Access to Billing Information" | **root** |
| 2 | Confirm Cost Explorer is enabled | billing access |
| 3 | Create role `CostHubCostReader` | IAM access |

Role specification:

```json
// permissions
{ "Effect": "Allow",
  "Action": ["ce:GetCostAndUsage","ce:GetCostForecast",
             "ce:GetDimensionValues","ce:GetTags","ce:GetAnomalies"],
  "Resource": "*" }

// trust policy
{ "Effect": "Allow",
  "Principal": { "AWS": "arn:aws:iam::<DEPLOY_ACCOUNT_ID>:root" },
  "Action": "sts:AssumeRole",
  "Condition": { "StringEquals": { "sts:ExternalId": "<EXTERNAL_ID>" } } }
```

`AWSBillingReadOnlyAccess` is the managed-policy alternative — broader, but
an easier approval.

This role is **deliberately outside our Terraform**: we do not own that
account, and it must survive our teardown.

> **Verified state as of 2026-10-07** in account `881953306582`: every cost
> API is denied (`ce:*`, `budgets:*`, `bcm-data-exports:*`, `cur:*`), and the
> denials read *"no identity-based policy allows"* — an implicit deny, so no
> SCP is blocking it. Adding the role is sufficient; no org-level change needed.

---

## Terraform layout

```
terraform/
├── main.tf          providers, locals
├── variables.tf     region, name_prefix, account ids, external id
├── iam.tf           Lambda execution roles under path /costhub/
├── network.tf       security group for the database
├── database.tf      RDS instance, subnet group, parameter group, AZ filter
├── lambda.tf        5 functions + Function URL
├── schedule.tf      EventBridge rules
├── cognito.tf       user pool, client, Managed Login domain, superadmin user
├── amplify.tf       app, branch, basic auth
├── messaging.tf     budget + the SES identity ARN (neither the identity nor any topic is managed here)
├── secrets.tf       Secrets Manager entries
├── logs.tf          explicit log groups with retention
└── outputs.tf       frontend URL, API URL, pool id, DB endpoint
```

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

```bash
# 1. database first — Lambda needs its endpoint
cd terraform
terraform init
terraform apply -target=aws_db_instance.main

# 2. migrations (from the laptop, DB is publicly reachable)
cd ..
DATABASE_URL=... python -m costhub.migrate

# 3. everything else
cd terraform && terraform apply

# 4. seed the superadmin and connections
python -m costhub.cli bootstrap-admin --email you@chryselys.com
python -m costhub.cli add-connection --account-id ... --role-arn ...

# 5. frontend
#    Amplify builds on push to the connected branch

# 6. first ingest
aws lambda invoke --function-name costhub-dev-ingest /dev/stdout
```

Step 1 is targeted because Lambda's environment needs the DB endpoint, which
does not exist until the instance does.

### If the API returns 403 and Terraform says everything applied

A Function URL with `authorization_type = "NONE"` still needs a
resource-based policy allowing `lambda:InvokeFunctionUrl`. The console
adds one when you create a URL by hand; Terraform does not. Without it
the config plans and applies perfectly and the URL serves 403 to
everything.

`aws_lambda_permission.api_url` in `lambda.tf` is that policy. If a 403
ever comes back, check it exists before looking anywhere else:

```bash
aws lambda get-policy --function-name costhub-dev-api
```

---

## Deployment permissions

Not needed in the personal account (root). This is the list **if** someone
insists on deploying into a work account.

| Service | Actions |
|---|---|
| IAM | `CreateRole`, `DeleteRole`, `GetRole`, `TagRole`, `AttachRolePolicy`, `DetachRolePolicy`, `PutRolePolicy`, `DeleteRolePolicy`, **`PassRole`** |
| Lambda | `CreateFunction`, `DeleteFunction`, `GetFunction`, `UpdateFunctionCode`, `UpdateFunctionConfiguration`, `AddPermission`, `CreateFunctionUrlConfig`, `TagResource` |
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

| | dev | demo |
|---|---|---|
| Database | Neon free tier | RDS `db.t4g.micro` |
| Frontend | local dev server | Amplify branch |
| Jobs | invoked manually | EventBridge |
| Auth | Cognito (shared pool) | Cognito |
| Access gate | — | Amplify branch password |

Identical code; only `DATABASE_URL` and the job trigger differ (NFR-21).

---

## Demo-day checklist

- [ ] Amplify branch password set and shared with stakeholders
- [ ] Budget alerts active (50% / 80% of `budget_limit_usd`)
- [ ] SES sender verified, or recipients verified if still sandboxed
- [ ] Both connections ingesting; `ingest_runs` shows `success`
- [ ] Superadmin and restricted analyst accounts both invited and tested
- [ ] A no-grant user exists, to demonstrate the empty state
- [ ] Planted anomalies present in the real data window, or dev_seed if sparse
- [ ] Showcase fixtures labelled, toggle defaulting to OFF
- [ ] `as_of` timestamp visible on every chart
- [ ] `terraform destroy` rehearsed on a throwaway apply
