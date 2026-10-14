# AWS services used

Every service, why it is there, and what it costs. Figures are monthly, for
a single-environment deployment at this volume.

---

## Inventory

| Service | Role | Monthly | Note |
|---|---|---|---|
| **Amplify Hosting** | the frontend: build, CDN, HTTPS URL | $0 | free tier; `WEB_COMPUTE` platform for Next SSR |
| **Lambda** | api + 4 jobs, one zip, five handlers | $0 | free tier. Account concurrency ceiling is **10** |
| **API Gateway** (HTTP API) | the only way in to the api function | ~$0 | $1.00 per million requests; nowhere near it |
| **EventBridge** (rules, not the Scheduler service) | triggers ingest, anomaly, alerts | $0 | three rules |
| **RDS PostgreSQL** `db.t4g.micro` | app layer: rollup, grants, rules, findings, audit | ~$14 | **the only standing cost**; roughly $0.5/day |
| **Secrets Manager** | the database URL, plus one secret per `secret`-mode connection | ~$0.40 each | $0.40 per secret per month |
| **Cognito** (ESSENTIALS) | auth, email OTP, invite-only | $0 | free to 10k MAU; ESSENTIALS is required for passwordless |
| **SES** | sign-in codes and alert email | $0 | well under the free allowance |
| **Bedrock** | `amazon.nova-lite-v1:0`, wording for `/insights` | cents | $0.06 per million input tokens, $0.24 per million output |
| **CloudWatch Logs** | Lambda logs, 7-day retention | ~$0.50 | retention set in Terraform |
| **Budgets** | alarm at 50% and 80% of `budget_limit_usd` | $0 | created by Terraform |
| **IAM** | roles under path `/costhub/` | $0 | |
| **Cost Explorer API** | **the data source** | $0.01/request | <$1 at this call volume |
| **STS** | `AssumeRole` into a data-source account | $0 | |
| | **Total** | **~$16** | dominated by RDS |

### Non-AWS

| Service | Role | Cost |
|---|---|---|
| **Azure Cost Management Query API** | Azure cost data. The adapter is built and **has never spoken to Azure**; it needs a subscription and an Entra app registration with **Cost Management Reader** | $0, rate-limited, no per-call charge |
| **Neon** | a **local development sandbox only**, pointed at by `backend/.env`, full of `dev_seed` rows. Not an environment, and nothing deployed ever reads it | $0, free tier |

Everything in scope bills in **USD**, so no currency conversion exists
anywhere in the system (NFR-7b).

### Deferred — not used

| Service | Would be for | Doc |
|---|---|---|
| S3 + Athena + Glue | a FOCUS/CUR deep layer and resource drill-down | TODO-15 |
| AWS Cost Anomaly Detection | free managed detection, consumed over SNS — which would create the topic, since there is none today | TODO-17 |
| SNS | nothing. A topic existed for a while with no publisher and was removed | TODO-17 |
| VPC / NAT Gateway | a private database | TODO-1 |
| WAF | the API Gateway has throttling but no WAF | TODO-6 |
| QuickSight | not used — per-seat licensing is why we built the UI | — |

---

## Why each choice

### Compute — Lambda, not EC2, ECS or Lightsail

Every workload is a few seconds, once or twice a day; compute idles
essentially all of the time. Permission testing in a work account also
showed `ecs:*`, `apprunner:*` and `lightsail:*` all denied, and while
`ec2:RunInstances` would have succeeded, `ec2:CreateSecurityGroup` is
denied and no key pair exists. Serverless sidesteps that entirely.

**Zip packages, not container images**, because there is no Docker on the
dev machine. `do.sh build` installs with `pip --platform
manylinux2014_x86_64`.

**One zip, five handlers**, and therefore **one shared execution role.**
That is worth knowing before reasoning about blast radius: the Bedrock
grant and the Secrets Manager write grant are held by the job functions
too, even though only the API uses them.

### The API edge — API Gateway HTTP API, not a Lambda Function URL

Not a preference. **This account blocks anonymous Lambda invocation.** A
Function URL with a textbook-correct public resource policy — `Principal
"*"`, `lambda:InvokeFunctionUrl`, condition `FunctionUrlAuthType = NONE`,
`AuthType` set to `NONE`, function Active — returned `403
AccessDeniedException` to every request, with **no invocation recorded in
CloudWatch**: the requests never reached the function. A brand-new
throwaway function, created by hand with the CLI and given its own public
permission, returned the same 403, which proves it was never this stack's
configuration.

`lambda get-account-settings` reports `ConcurrentExecutions = 10` against a
normal default of 1000, which is the unverified-new-account posture.
IAM-authorised invocation is unaffected — `aws lambda invoke` returns 200.

API Gateway works because the invocation is no longer anonymous: it calls
the function as the `apigateway.amazonaws.com` **service principal**,
authorised by a resource policy scoped to that one API's execution ARN.
Nothing public invokes Lambda any more.

Three things fall out of the choice:

- **The application did not change.** Payload format 2.0 is the same event
  shape a Function URL sends, so Mangum sees an identical payload.
- **Throttling became possible** — `throttling_burst_limit = 20`,
  `throttling_rate_limit = 50` on the default stage. This matters at a
  concurrency ceiling of 10, where an unthrottled public endpoint could
  exhaust the account with one loop. That was TODO-6's first half.
- **One catch-all `$default` route**, because the FastAPI app owns its own
  routing table; declaring routes here would mean maintaining it twice and
  getting a gateway 404 for a path the app serves.

And one trap: **the gateway deliberately declares no `cors_configuration`.**
The FastAPI app owns CORS. Two layers both setting
`Access-Control-Allow-Origin` produce a duplicated header that browsers
reject, which presents as "CORS is broken" while both layers are
individually correct.

A support request to lift the account restriction is worth filing in
parallel — it would also raise the concurrency ceiling — but it is not on
the critical path now this exists.

### Database — RDS PostgreSQL

The workload is small, relational (the grant filter is a join) and
transactional (acknowledging a finding, revoking a grant, appending audit).
That is Postgres.

| Rejected | Reason |
|---|---|
| DynamoDB | no aggregation, no joins — authorisation would move into application code and break NFR-1 |
| Athena + S3 | no transactions, no `UPDATE`, a 1-3s floor, per-query cost on a clicked dashboard |
| Timestream | no joins; the grant filter needs one |
| Redshift | orders of magnitude oversized |
| Aurora Serverless v2 | genuinely good — scale-to-zero and the Data API would remove the VPC problem — but ~$11/mo with pause/resume latency, and a second access path that breaks dev/prod parity (NFR-21). Reconsider if TODO-1 is done |

**It is publicly reachable, with TLS enforced.** Lambda runs outside a VPC
because the jobs need the internet (Cost Explorer) *and* the database;
putting Lambda in a VPC to reach a private database would require a NAT
Gateway at roughly $32/month, more than the rest of the stack combined.
`rds.force_ssl = 1` is set through a custom parameter group — the default
group cannot be modified — and the password is generated by Terraform into
Secrets Manager. TODO-1 and TODO-2.

**Neon is the local sandbox, not an environment.** Every environment,
`dev` included, uses RDS. Real cost data in a third-party service would
contradict the argument this project makes against commercial FinOps
tools, so Neon only ever holds `dev_seed` rows. Conflating the two has
already caused someone to read seeded rows as live state — CONTEXT.md trap
8.

### Frontend — Amplify Hosting

Amplify *is* S3 plus CloudFront, plus a build pipeline. Choosing it is
choosing not to wire that yourself. A free HTTPS URL immediately with no
domain required, and atomic deploys with one-click rollback, which matters
mid-demo. The free tier — 1,000 build minutes, 15 GB served, 5 GB stored
per month — does not expire.

Two configuration points that are not defaults:

- **`platform = "WEB_COMPUTE"`**, not `WEB`. The app is Next.js 15 app
  router and needs server rendering; `WEB` is static-only and an Amplify
  build of a Next app on it either fails or serves a broken tree.
- **No SPA rewrite rule.** The `/<*>` → `/index.html` 404-200 rule is right
  for a Vite single-page app and actively wrong here — Next owns its own
  routing, and Amplify applies the correct Next rules itself on
  `WEB_COMPUTE`.

Branch basic auth is **off**; it was the stakeholder gate from before
Cognito worked. See [07-security-rbac.md](07-security-rbac.md) for what
that does and does not change.

**Amplify Hosting only.** Amplify Gen 2 generates its own CDK-managed
backend and would own resources outside this teardown.

### Auth — Cognito ESSENTIALS

Passwordless email OTP requires the **ESSENTIALS** tier and **Managed Login
v2**; the classic Hosted UI cannot do it. Free to 10,000 MAU.

Passwordless is not only a UX choice: with no passwords there is nothing to
store or migrate, so moving to another account later means re-inviting users
from our own `users` table. Email OTP also needs **SES** — Cognito's
built-in sender does not support that factor — which makes SES a
prerequisite rather than a nice-to-have.

### Narration — Bedrock, one model, by ARN

`GET /insights` computes every figure itself and asks a model only to
choose among sentences the backend already wrote. See
[16-insights-api.md](16-insights-api.md).

**The model is `amazon.nova-lite-v1:0`, and that was not the first choice.**
Every Anthropic model in the deploy account is refused until its owner
submits the Anthropic use-case form in the Bedrock console — an attestation
only the account owner can make. Appearing in `list-foundation-models`
proves nothing; they all do. Nova Micro is cheaper and also works, but
showed position bias rather than judgment. Prices from the AWS Pricing API:
Nova Lite $0.06 per million input tokens and $0.24 per million output; Nova
Micro $0.035 and $0.14.

The IAM grant is **one foundation-model ARN**, not `bedrock:*` and not
`"*"`. The Converse API is authorised by `bedrock:InvokeModel`; there is no
separate action. Changing the model means changing it in **both** places —
`insights_model_id` in `terraform/iam.tf` and `INSIGHTS_MODEL_ID` on the
API function — or every call is denied, which the endpoint reports as
`access_denied`.

### Data source — Cost Explorer API

| | |
|---|---|
| Why not a FOCUS export | 48h to first delivery, plus S3, bucket policies, Glue and Athena. CE needs two permissions and returns data immediately |
| Endpoint | us-east-1 only, wherever else things run |
| Cost | $0.01 per request — the reason we schedule rather than poll |
| History | roughly 14 months |
| Limit | `GroupBy` takes at most **2** dimensions |
| Limit | `End` is exclusive |
| Limit | `LINKED_ACCOUNT` returns one value in a standalone account, so multi-account comes from iterating connections |
| Limit | there is no charge-category dimension; `Tax` and `Refund` arrive *as service values*, and inline credits as negative amounts on the real service name |

**Only two permissions are ever used**, verified against the code:
`ce:GetCostAndUsage` (`ingest/cost_explorer.py`) and
`ce:GetDimensionValues` (`connections/probe.py`). Nothing in the package
calls any other `ce:` operation — but our own Lambda role currently grants
eight. Narrowing it is TODO-5.

AWS's own guidance notes FOCUS omits `lineItem/Operation` and is therefore
not recommended for cost **optimisation** — a reason the deep layer stays
deferred rather than rushed.

---

## Account layout

```
deploy account                      a data-source account
├── deploy target  yes              ├── deploy target  no
└── data source    yes, mode=self   └── data source    yes, via a read-only
                                        role or a stored key
```

One deployment, N data sources. We never need deploy rights in a
data-source account — only a read-only role, which is a far smaller ask, or
a read-only access key where nobody will create one.

---

## Cost controls

1. **Budget alert at 50% and 80%** of `budget_limit_usd` (default 80, so
   $40 and $64), notifying `superadmin_email`. Created by Terraform.
2. **CloudWatch Logs retention set to 7 days.** Unbounded log retention is
   the usual surprise line item.
3. **API Gateway throttling** at 20 burst / 50 per second, which an
   unthrottled public endpoint could not have.
4. **`terraform destroy` after the demo.** The database is the only standing
   cost; removing it ends billing. Note that teardown needs `pg_dump` and
   **has never been run**.

### Credit model — note for a new account

A recently created account is on AWS's post-15-July-2025 **credit model**,
not the legacy 12-month free tier:

- $100 credits at signup, up to $100 more for five onboarding tasks
- the Free plan runs 6 months **or until credits are exhausted**

Two consequences:

- The five tasks are EC2, RDS, Lambda, Bedrock and Budgets. This project
  now uses **four** of them, so the extra $100 unlocks as a side effect.
- **On the Free plan, exhausting credits suspends resources rather than
  billing you.** For something stakeholders are clicking on, that is a demo
  that dies without warning — hence the budget alerts above, and TODO-14.
