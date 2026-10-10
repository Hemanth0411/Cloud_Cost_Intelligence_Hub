# AWS services used

Every service, why it is there, and what it costs. The demo window is ~10
days, so figures are given monthly and for the window.

---

## Inventory

| Service | Role | Where | Monthly | 10 days |
|---|---|---|---|---|
| **Amplify Hosting** | static frontend, CI/CD, HTTPS URL, branch password | personal | $0 (free tier) | $0 |
| **Lambda** | api + 4 jobs, zip packages | personal | $0 (free tier) | $0 |
| **EventBridge Scheduler** | triggers ingest / anomaly / alerts | personal | $0 | $0 |
| **RDS PostgreSQL** `db.t4g.micro` | app layer: rollup, grants, rules, audit | personal | ~$14 | ~$5 |
| **Secrets Manager** | DB password, external id | personal | ~$0.80 (2 secrets) | ~$0.27 |
| **Cognito** (Essentials) | auth, email OTP, invite | personal | $0 (≤10k MAU) | $0 |
| **SNS** | alert fan-out | personal | $0 | $0 |
| **SES** | alert email | personal | $0 (<62k) | $0 |
| **CloudWatch Logs** | Lambda logs, 7-day retention | personal | ~$0.50 | ~$0.17 |
| **IAM** | roles under path `/costhub/` | personal | $0 | $0 |
| **Cost Explorer API** | **the data source** | both accounts | $0.01/request | <$1 |
| **STS** | `AssumeRole` into stemline | both | $0 | $0 |
| | | **Total** | **~$16** | **~$6** |

### Non-AWS, when credentials arrive

| Service | Role | Cost |
|---|---|---|
| **Azure Cost Management Query API** | Azure cost data; adapter built, needs a subscription + Entra app registration with **Cost Management Reader** | $0 (rate-limited, no per-call charge) |

Everything in scope bills in **USD**, so no currency conversion exists
anywhere in the system (NFR-7b).

Comfortably inside the account's $100 credit.

### Deferred — not used yet

| Service | Would be for | Doc |
|---|---|---|
| S3 + Athena + Glue | FOCUS/CUR deep layer, resource drill-down | TODO-14 |
| Bedrock | narration over computed results | TODO-16 |
| AWS Cost Anomaly Detection | free managed detection, consumed via SNS | TODO-15 |
| QuickSight | not used — per-seat licensing is why we built the UI | — |
| VPC / NAT Gateway | private database | TODO-1 |
| API Gateway | throttling, WAF | TODO-6 |

---

## Why each choice

### Compute — Lambda, not EC2 / ECS / Lightsail

Every workload is a few seconds, once or twice a day; compute idles 99.99%
of the time. Also decisive: permission testing in the stemline account
showed `ecs:*`, `apprunner:*` and `lightsail:*` all denied, and while
`ec2:RunInstances` would have succeeded, `ec2:CreateSecurityGroup` is denied
and no key pair exists. Serverless sidesteps that entirely — and deployment
happens in the personal account regardless.

**Zip packages, not container images**, because there is no Docker on the dev
machine. pandas/numpy, if required, come from the AWS-managed
`AWSSDKPandas-Python312` layer.

### Database — RDS PostgreSQL

The workload is small (~9k rows/month), relational (the grant filter is a
join) and transactional (acknowledging an alert, revoking a grant, appending
audit). That is Postgres.

| Rejected | Reason |
|---|---|
| DynamoDB | no aggregation, no joins — authorization would move into application code and break NFR-1 |
| Athena + S3 | no transactions, no `UPDATE`, 1–3s floor, per-query cost on a clicked dashboard |
| Timestream | no joins; the grant filter needs one |
| Redshift | orders of magnitude oversized |
| Aurora Serverless v2 | genuinely good — scale-to-zero and the Data API would remove the VPC problem — but ~$11/mo with pause/resume latency and a second access path that breaks dev/prod parity (NFR-21). Reconsider if the private-network work in TODO-1 is done. |

**Neon** (free, hosted) is used for local development since there is no
Docker. It is dev-only: putting real cost data in a third-party service would
contradict the argument we make against commercial FinOps tools.

### Frontend — Amplify Hosting

Amplify *is* S3 + CloudFront, plus a build pipeline. Choosing it is choosing
not to wire that yourself.

Three features earn it here:
- a **free HTTPS URL** immediately, no domain required
- **branch password protection**, which is how stakeholders get access before
  Cognito is finished
- atomic deploys with one-click rollback, which matters mid-demo

Free tier — 1,000 build minutes, 15 GB served, 5 GB stored per month — does
not expire and covers this entirely.

**Amplify Hosting only.** Amplify Gen 2 generates its own CDK-managed
backend and would own resources outside our Terraform teardown.

### Auth — Cognito Essentials

Passwordless email OTP requires the **Essentials** tier and **Managed Login**
(the classic Hosted UI does not support it). Free to 10,000 MAU.

Passwordless is not only a UX choice: with no passwords there is nothing to
store or migrate, so moving to another account later means re-inviting users
from our own `users` table.

### Data source — Cost Explorer API

| | |
|---|---|
| Why not FOCUS export | 48h to first delivery, plus S3, bucket policies, Glue and Athena. CE needs **one** permission and returns data immediately. |
| Endpoint | us-east-1 only, wherever else things run |
| Cost | $0.01/request — the reason we schedule rather than poll |
| History | ~14 months |
| Limit | `GroupBy` takes at most 2 dimensions |
| Limit | `LINKED_ACCOUNT` returns one value in a standalone account, so multi-account comes from iterating connections |

AWS's own guidance notes FOCUS omits `lineItem/Operation` and is therefore
not recommended for cost **optimisation** — a reason the deep layer stays
deferred rather than rushed.

---

## Account layout

```
personal account                 stemline account (881953306582)
├── deploy target  ✅            ├── deploy target  ❌ (no IAM/ECS rights)
└── data source    ✅            └── data source    ✅ via read-only role
```

One deployment, N data sources. We never need deploy rights in stemline —
only a read-only role, which is a far smaller ask.

---

## Cost controls

1. **Budget alert at $50 and $80** on the personal account. Also completes
   one of the five credit-earning onboarding tasks.
2. **CloudWatch Logs retention set to 7 days** in Terraform. Unbounded log
   retention is the usual surprise line item.
3. **`terraform destroy` after the demo.** The database is the only standing
   cost; removing it ends billing.

### Credit model — note for this account

The personal account is ~4 months old, so it is on AWS's post-15-July-2025
**credit model**, not the legacy 12-month free tier:

- $100 credits at signup, up to $100 more for five onboarding tasks
- Free plan runs 6 months **or until credits are exhausted**

Two consequences:

- The five tasks are EC2, RDS, Lambda, Bedrock and Budgets. This project
  uses four of them, so the extra $100 unlocks as a side effect.
- **On the Free plan, exhausting credits suspends resources rather than
  billing.** For something stakeholders are clicking on, that is a demo that
  dies without warning — hence the budget alerts above.
