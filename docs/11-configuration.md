# Configuration and account migration

Full variable reference, email setup, and the runbook for moving the whole
deployment from one AWS account to another.

See the [README](../README.md#configuration--everything-you-need-to-edit)
for the short version.

---

## The three-places rule

Every account-specific value lives in one of three places. Nothing else in
the repository contains an account id, ARN, URL or email address.

```
terraform/env/<env>.tfvars   ──apply──▶  Lambda env vars      (generated)
                                         IAM roles / ARNs     (generated)
                                         terraform output ───▶ frontend/.env.local
                                                               (./do.sh outputs)

Amplify console              ──────────▶ the five NEXT_PUBLIC_* a build needs
                                         (a dependency cycle keeps them out
                                          of terraform -- see below)

cloud_connections table      ──────────▶ which accounts to read (runtime data)
```

**The `.tfvars` files are gitignored, all three of them.** They hold
`amplify_basic_auth_password`, so only `terraform/env/dev.tfvars.example`
is committed. On a fresh clone, copy it three times — `dev.tfvars`,
`staging.tfvars`, `main.tfvars` — before running anything; `./do.sh`
refuses an environment whose file is missing rather than applying a
half-configured stack.

Consequences:

- Moving accounts = edit `terraform.tfvars`, apply, restore data.
- Never hand-edit a Lambda or Amplify environment variable — the next apply
  overwrites it, and the discrepancy is invisible until something breaks.
- No `terraform` file hardcodes the deploy account id; it comes from
  `data.aws_caller_identity.current` (NFR-15).

---

## Variable reference

### Identity of the deployment

| Variable | Default | Portable? | Notes |
|---|---|---|---|
| `aws_region` | `us-east-1` | yes | **Cost Explorer and Budgets are us-east-1 only**, regardless of where anything else runs |
| `name_prefix` | `costhub` | yes | prefixes every resource; change it to run two deployments in one account |

### Administration

| Variable | Portable? | Notes |
|---|---|---|
| `aws_account_id` | **no** | the 12-digit account this environment may deploy into. Terraform refuses to run against any other (`allowed_account_ids`), which is what stops a misdirected profile building the stack in the wrong account. Validated as 12 digits. |
| `allow_local_frontend` | yes (`true`) | whether `http://localhost:3000` is an allowed CORS origin on the deployed API. Set it **false** for a shared deployment — it was unconditional, so a shared URL advertised a developer laptop as an allowed origin with `allow_credentials = true`. Port **3000**, because the frontend is Next (`next dev`); 5173 was the previous Vite frontend's port and there is no Vite app here. |
| `insights_model_id` | yes (`amazon.nova-lite-v1:0`) | the one Bedrock model `GET /insights` may invoke. The IAM grant is a single foundation-model ARN built from this, so it must be kept in step with `INSIGHTS_MODEL_ID` on the api function — change only one and every call is denied, which the endpoint reports as `access_denied`. |
| `superadmin_email` | **no** | the first superadmin. Needs BOTH halves: `aws_cognito_user` (cognito.tf) creates the pool user, `migrations/006` creates the row. Also the budget-notification recipient. Must be in `allowed_email_domain`. |
| `allowed_email_domain` | yes | `chryselys.com`. Enforced in the Cognito pre-signup Lambda **and** re-checked at the API boundary |

### Email — required, not optional

| Variable | Portable? | Notes |
|---|---|---|
| `ses_sender_email` | **no** | the verified SES identity OTPs are sent from |

**Email OTP does not work without SES.** Cognito's built-in sender (the
`no-reply@verificationemail.com` / 50-per-day option) does not support the
email-OTP factor — SES configuration is a prerequisite of passwordless
sign-in, alongside the Essentials feature plan.

#### Choosing a sender identity

Since login depends on delivery, this matters more than it looks.

| Option | Deliverability | Setup |
|---|---|---|
| **A domain you own** — verify the *domain*, enable DKIM (3 CNAME records), send from `noreply@yourdomain.com` | good | ~10 min with DNS access |
| `chryselys.com` | best | needs DNS access and IT approval; likely refused from a personal AWS account |
| A consumer address (`@gmail.com`, `@outlook.com`) | **poor — see below** | 2 min |

**Why a consumer address is risky.** SES will verify an individual address,
so sending works mechanically. But the From-header domain is `gmail.com`,
whose SPF does not authorise AWS SES, and SES signs DKIM as `amazonses.com`.
Recipients on Microsoft 365 or Google Workspace see SPF fail and DKIM
misaligned, so DMARC fails and the message is junked or rejected. The
failure mode is "nobody can log in", with no error anywhere.

If a consumer address is the only option: verify it, **and test delivery to a
real `@chryselys.com` inbox on day one.** If it lands in junk, switch to a
domain you control.

#### Sandbox vs production access

SES starts in sandbox: you may only send **to verified addresses**, 200
messages/day at 1/sec.

For a demo of ~10 people this is a feature, not a limitation — verify each
teammate's address and skip the production-access request (~24h approval)
entirely. 200/day far exceeds a handful of logins and alerts.

### Frontend hosting

| Variable | Portable? | Notes |
|---|---|---|
| `amplify_repository` | **no** | git repo Amplify builds from |
| *(branch name)* | — | derived from the workspace (`amplify.tf`), not a variable |
| `amplify_basic_auth_user` / `amplify_basic_auth_password` | **no** | **declared but not in effect.** `enable_basic_auth = false` on the branch — it was the stakeholder gate from before Cognito worked, and two password prompts to reach one demo is one too many. Still declared so it can be put back; to do that, set `enable_basic_auth = true` and restore `basic_auth_credentials` in `terraform/amplify.tf` |

### Database

| Variable | Default | Notes |
|---|---|---|
| `db_instance_class` | `db.t4g.micro` | ~$14/month; the only standing cost |
| `db_allocated_storage` | `20` (GB) | far more than needed |

The password is generated by Terraform into Secrets Manager with
`recovery_window_in_days = 0`, never set by hand.

### Data sources — optional, and not where accounts are registered

```hcl
# Optional. Defaults to []. This does NOT register anything.
data_source_accounts = [
  { account_id = "self", name = "Deploy account", role_arn = null, external_id = null },
  { account_id = "<12 digits>", name = "Another account",
    role_arn    = "arn:aws:iam::<12 digits>:role/CostHubCostReader",
    external_id = "<a uuid you generate>" },
]
```

**Terraform does not write these to the database, and it does not need to
contain anything.** `var.data_source_accounts` is consumed only by `iam.tf`,
and only to add specific role ARNs to the `sts:AssumeRole` grant.

That grant was once `count`-gated on this variable, and the runtime reads
roles from the `cloud_connections` **table** — connections are added
through the UI, not tfvars — so the first account registered that way
failed with `AccessDenied` against a policy that did not exist. The grant
is now **unconditional and name-constrained** instead: any role called
`CostHubCostReader`, at the root IAM path, in any account. It cannot assume
arbitrary roles, and it does not depend on tfvars being kept in step with
the database.

So in practice you can leave this empty and register accounts in the UI,
which is also how you get the two-stage probe and an inline import. See
[17-connection-lifecycle.md](17-connection-lifecycle.md).

`account_id = "self"` means the deploy account, read with the Lambda's own
execution role — no `AssumeRole`, nothing to configure in another account.

### Narration

| Variable | Where | Default | Notes |
|---|---|---|---|
| `insights_model_id` | tfvars / `iam.tf` | `amazon.nova-lite-v1:0` | scopes the IAM grant to one foundation-model ARN |
| `INSIGHTS_MODEL_ID` | Lambda env | the code default, the same value | what the API actually calls. **Change both or every call is denied** |
| `INSIGHTS_ENABLED` | Lambda env | `true` | `0`/`false`/`no`/`off` returns figures with `narration.status = "off"` |
| `INSIGHTS_BEDROCK_TIMEOUT_S` | Lambda env | `5` | read timeout, clamped to 1-10 so no setting can outlive the 29s request |

A model served only through an **inference profile**, as Claude is in this
region, needs the profile ARN *and* each destination region's
foundation-model ARN listed — one ARN will not be enough. Nova Lite is
on-demand, so one ARN is. And every Anthropic model in the deploy account
is refused until its owner submits the Anthropic use-case form in the
Bedrock console; see [16-insights-api.md](16-insights-api.md).

### Operational

| Variable | Default | Notes |
|---|---|---|
| `log_retention_days` | `7` | unbounded log retention is the usual surprise line item |

---

## Prerequisites for deploying into any account

Run through this once per account. Steps 2, 3 and 5 all have waiting
periods, and all are free — do them first.

### In the deploy account

| # | Step | Who | Wait |
|---|---|---|---|
| 1 | Enable **"IAM User and Role Access to Billing Information"** (Account settings) | **root only** | none |
| 2 | Enable **Cost Explorer** | billing access | up to 24h |
| 3 | **Activate cost allocation tags** | billing access | **never retroactive** |
| 4 | Set a **Budget** at 50% / 80% of credits | billing access | none |
| 5 | **Verify the SES sender identity**, and each recipient while in sandbox | you | minutes |
| 6 | Confirm deploy permissions, or be root | — | — |

Step 1 is the gate people lose a day to: with it off, a correct IAM policy
still returns `AccessDenied` on every cost API.

Step 4 matters more than it sounds on a new account. AWS replaced the
12-month free tier on **15 July 2025** with a credit model — $100 at signup,
up to $100 more for five onboarding tasks — and on the Free plan,
**exhausting credits suspends resources rather than billing you**. For
something stakeholders are clicking on, that is a demo that dies without
warning.

### In each data-source account

Needs two different people, so start early.

| # | Step | Who |
|---|---|---|
| 1 | Enable "IAM User and Role Access to Billing Information" | **root** |
| 2 | Confirm Cost Explorer is enabled | billing access |
| 3 | Create role `CostHubCostReader`, **at the root IAM path** | IAM admin |

**Only two Cost Explorer permissions are ever used** — verified against the
code, which calls `get_cost_and_usage` and `get_dimension_values` and
nothing else:

```json
// permissions -- read-only, two actions
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
the only valid value. Step 1 is not optional and is not an IAM permission:
without it **both** of those calls return `AccessDenied` however perfect
the policy.

The role must sit at the **root** IAM path, named exactly
`CostHubCostReader`. Our own policy grants that ARN shape, so a role
created under a path is denied by *us* before their trust policy is
consulted.

This role is **deliberately outside our Terraform** — we do not own that
account, and it must survive our teardown.

**If nobody there will create a role**, use `credential_mode = "secret"`
instead: an access key entered once in the connect dialog, written to
Secrets Manager, with only the ARN stored in the database. Do **not** use
`credential_mode = "profile"` for anything that has to run on the schedule
— it cannot work in Lambda at all. The full comparison is in
[17-connection-lifecycle.md](17-connection-lifecycle.md).

What you must hand the other account's admin: your **deploy account id** and
the **External ID** you chose.

### For Azure, when credentials arrive

| # | Step |
|---|---|
| 1 | A subscription, or an EA/MCA billing account |
| 2 | An **app registration** in Entra ID → tenant id, client id, client secret |
| 3 | **Cost Management Reader** on that service principal, at subscription or billing-account scope |
| 4 | Store the client secret in Secrets Manager; add a `cloud_connections` row with `provider = 'azure'` |

Azure has no cross-cloud equivalent of `AssumeRole`, so a long-lived secret
is unavoidable here. Rotation is TODO-3.

---

## Migrating to another account

### What changes, and what does not

| | Changes | Why |
|---|---|---|
| `superadmin_email` | maybe | only if a different person administers it |
| `ses_sender_email` | **yes** | identities are per-account; re-verify |
| `amplify_basic_auth_password` | **yes** | rotate on migration |
| `data_source_accounts` | **yes** | new External ID, new trust policy |
| Everything else in tfvars | no | portable as-is |
| Lambda / Amplify env vars | regenerated | never hand-edited |
| `frontend/.env.local` | regenerated | by `./do.sh outputs <env>` |
| the five `NEXT_PUBLIC_*` in the Amplify console | **by hand** | a terraform apply cannot set them; see the cycle above |
| Fact data | **not migrated** | re-ingested from Cost Explorer |
| Users, grants, rules, audit | **migrated** | `pg_dump` / restore |

### Runbook

```bash
# ---- 1. prerequisites in the NEW account -----------------------------
#    the six steps above. Cost Explorer needs up to 24h, so start here.

# ---- 2. new trust policy in each data-source account -----------------
#    the role's trust policy names the OLD account id -- the IAM admin
#    must update it to the new one, or AssumeRole fails.

# ---- 3. export app data from the OLD deployment ----------------------
./do.sh export-data <env>
#   pg_dump: users, identities, access_grants,
#            cloud_connections, alert_rules, audit_log
#   NOT fact_cost_daily, NOT ingest_runs -- re-ingested

# ---- 4. tear down the OLD deployment ---------------------------------
cd terraform
terraform destroy -var-file=old.tfvars

# ---- 5. deploy to the NEW account ------------------------------------
export AWS_PROFILE=new-account
terraform apply -target=aws_db_instance.main -var-file=new.tfvars
cd .. && DATABASE_URL=<new> python -m costhub.migrate
cd terraform && terraform apply -var-file=new.tfvars

# ---- 6. restore app data ---------------------------------------------
./do.sh restore

# ---- 7. refresh frontend config --------------------------------------
terraform output -json > ../frontend/tf-outputs.json
#    ./do.sh outputs <env>  writes frontend/.env.local
#    then set the five NEXT_PUBLIC_* in the Amplify console and
#    redeploy -- they are inlined at BUILD time

# ---- 8. re-ingest and re-verify --------------------------------------
cd backend && python -m costhub.cli backfill --months 14
```

### Step 2 is the one that bites

The cross-account role's trust policy names the **old** deploy account id.
It is in an account you do not control and is not in your Terraform, so
nothing in the apply will tell you it is wrong — `AssumeRole` simply fails at
the first ingest. Get it updated **before** step 5.

### The step nobody plans for

**`terraform destroy` deletes your data.** Steps 3 and 6 are not optional,
and `export-data` must be verified to actually contain rows before step 4
runs. A destroy with an empty dump loses every grant and the whole audit
trail.

### Users migrate without credentials

A payoff from the passwordless choice. Cognito users cannot be exported with
passwords — but there are no passwords. Users are recreated with
`AdminCreateUser` from our own `users` table, and they sign in with a fresh
OTP. Nothing to export, nothing to reset.

The one thing to re-verify: **SES recipient verification is per-account**.
Everyone who received email in the old account must be re-verified in the
new one, or nobody can log in. This is the most likely post-migration
failure, and the symptom is a code that never arrives.

---

## Pre-flight

See [12-build-checklist.md](12-build-checklist.md) § Demo readiness.

Two items there are specific to a **migration** rather than a first deploy,
and are the most likely failures:

- the cross-account role's trust policy still names the **old** account
- SES recipient verification is per-account and must be redone
