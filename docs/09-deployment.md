# Deployment

One Terraform root module, applied to the personal account. Stemline is a
data source only.

---

## Prerequisites

### In the deploy account (personal — you are root)

| # | Step | Note |
|---|---|---|
| 1 | Enable **"IAM User and Role Access to Billing Information"** | Account settings; root only |
| 2 | Enable **Cost Explorer** | once; up to 24h to populate |
| 3 | Activate **cost allocation tags** | **never retroactive** — do this on day one or the history is lost |
| 4 | Set a **Budget** at $50 / $80 | also earns credit task |
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
├── database.tf      RDS instance, subnet group, parameter group, SG
├── lambda.tf        5 functions + Function URL
├── schedule.tf      EventBridge rules
├── cognito.tf       user pool, client, Managed Login domain, pre-signup
├── amplify.tf       app, branch, basic auth
├── messaging.tf     SNS topic, SES identity
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
make export-data   # pg_dump users, identities, access_grants,
                   # cloud_connections, alert_rules, audit_log
make import-data   # restore into the new account's fresh database
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
aws lambda invoke --function-name costhub-ingest /dev/stdout
```

Step 1 is targeted because Lambda's environment needs the DB endpoint, which
does not exist until the instance does.

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
| SNS | `CreateTopic`, `Subscribe`, `DeleteTopic`, `GetTopicAttributes`, `SetTopicAttributes` |
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
- [ ] Budget alerts at $50 / $80 active
- [ ] SES sender verified, or recipients verified if still sandboxed
- [ ] Both connections ingesting; `ingest_runs` shows `success`
- [ ] Superadmin and restricted analyst accounts both invited and tested
- [ ] A no-grant user exists, to demonstrate the empty state
- [ ] Planted anomalies present in the real data window, or dev_seed if sparse
- [ ] Showcase fixtures labelled, toggle defaulting to OFF
- [ ] `as_of` timestamp visible on every chart
- [ ] `terraform destroy` rehearsed on a throwaway apply
