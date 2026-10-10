# TODO and future extensions

Everything here was considered and **deliberately deferred**, not missed.
That distinction is the point of this document: "we knew and chose not to"
survives review; silence does not.

---

## Security hardening

| ID | Item | Why deferred | Effort |
|---|---|---|---|
| TODO-1 | **Move the database off the public internet.** Either Lambda-in-VPC with a free S3 gateway endpoint for the ingest split, or switch to Aurora Serverless v2 + RDS Data API to remove the VPC entirely. | A NAT Gateway costs ~$32/month — more than the rest of the stack combined — for a 10-day demo. TLS is enforced and the password is strong. | M |
| TODO-2 | Restrict the database security group from open ingress to known CIDRs | Lambda outside a VPC has no fixed IP, so there is nothing to allowlist until TODO-1 lands | S |
| TODO-3 | Secrets Manager **rotation**, not just storage | rotation needs a Lambda and a tested rollback | S |
| TODO-4 | **Verify JWT signatures against Cognito JWKS** | *not actually deferred — this must ship.* Listed because it is an open finding in the DFIQ RBAC audit and must not be inherited. | **S — do it** |
| TODO-5 | Least-privilege IAM for cost reads, with key rotation on the fallback path | the `AssumeRole` path already avoids long-lived keys | S |
| TODO-6 | Rate limiting / WAF on the API | Lambda Function URL has none; would mean API Gateway | M |
| TODO-7 | CloudTrail and GuardDuty on the deploy account | cost and noise for a short-lived account | S |
| TODO-8 | Cognito MFA and token-expiry tuning | email OTP is already a second factor in practice | S |
| TODO-9 | Confirm every superadmin predicate bypass writes to `audit_log` | designed; needs a test asserting it | **S — do it** |
| TODO-10 | Enforce `audit_log` append-only via database grants | `GRANT INSERT, SELECT` only — one migration | **S — do it** |

TODO-4, TODO-9 and TODO-10 are marked **do it**: they are each under an hour
and they are what make the security claims in
[07-security-rbac.md](07-security-rbac.md) true rather than intended.

---

## Operational

| ID | Item | Note |
|---|---|---|
| TODO-11 | Tested RDS restore, not merely enabled backups | an untested backup is a hope |
| TODO-12 | Replace the Amplify branch password with Cognito-only once auth is complete | the password is a day-one gate, not the final design |
| TODO-13 | **Alert on ingest failures**, not only on cost anomalies | a silent ingest failure looks exactly like "costs went to zero" |
| TODO-14 | Credit-exhaustion alarm | on AWS's Free plan, exhausted credits **suspend** resources rather than bill — a demo that dies silently |

---

## Functional

| ID | Item | Why it is not in the demo |
|---|---|---|
| TODO-15 | **FOCUS export deep layer** (S3 + Athena + Glue) for resource-level drill-down and multi-cloud | 48h to first delivery plus bucket policies and Glue; Cost Explorer needs one permission and returns data now |
| TODO-16 | **GCP ingestion** | architecture and schema are ready (`CostSource` port, FOCUS column names); no project available. AWS maintains an official connector. |
| TODO-16b | **Azure credentials** — the adapter is **built**, not deferred | needs a subscription plus an Entra app registration with **Cost Management Reader**. Built first deliberately, so the access request is concrete: "the connector exists, we need a subscription" is an easier ask than "can we explore Azure". Unverifiable until credentials land — say so rather than implying it is live. |
| TODO-17 | **Consume AWS Cost Anomaly Detection via SNS** | free, managed, already tuned for cost data; would let us aggregate real detections across accounts and drop our own detector |
| TODO-18 | **Bedrock narration** over computed results | the model must narrate a result set it is handed, never compute the numbers — see the DFIQ chat truthfulness audit, where pages scored 13/18 by improvising metric definitions |
| TODO-19 | **Untagged / unallocatable spend panel** | one `GROUP BY` on tags; the most actionable number for the business and the precondition for any chargeback. Strongest candidate for the next thing built. |
| TODO-20 | **Unit economics** — cost per pipeline run, project, client | the real differentiator. Needs Glue `get_job_runs` DPU-hours and Athena per-query `bytes_scanned` joined to our own run metadata. No vendor can do this. |
| TODO-21 | **Per-service grants in the UI** | schema already supports it (`service_name` nullable). Deferred because partial totals do not reconcile with anyone else's view or the invoice, and that generates arguments. Ship per-account first; flag per-service on when someone actually asks. |
| TODO-22 | **Group-based grants** (`principal_type` column) | per-user grants stop scaling around 25–30 people. One column plus a branch in the predicate. |
| TODO-23 | **Microsoft OAuth** | `identities` table already makes this an insert rather than a migration. Restrict by **tenant id**, not email domain string. |
| TODO-24 | Forecast beyond linear run-rate | linear is honest and explainable at this data volume |
| TODO-25 | ~~Currency normalisation~~ | **Dropped.** Every cloud account in scope bills in **USD**, so no FX policy is needed. Re-open only if a non-USD billing account is ever added — cross-currency totals without an explicit FX policy (which rate, pinned to which date) are nonsense. |
| TODO-26 | Commitment / amortisation semantics across providers | FOCUS unifies effective cost conceptually, but per-provider mapping fidelity varies; cross-cloud comparison is approximate and must say so |

---

## Known limitations to state out loud

Not bugs. Properties of the design, worth volunteering before being asked.

| Limitation | Detail |
|---|---|
| **Not real-time** | Cost data lags 8–24h and finalises monthly; worst case ~48h end to end |
| **`LINKED_ACCOUNT` is single-valued** | in a standalone account; multi-account comes from iterating connections |
| **`GroupBy` max 2 dimensions** | Cost Explorer limit; region needs a second call |
| **No resource-level detail** | the rollup grain stops at service × region; drill-down needs TODO-15 |
| **FOCUS is not sufficient for optimisation** | AWS's own guidance: it omits `lineItem/Operation` |
| **Neon is dev-only** | real cost data in a third-party service would contradict our own argument against commercial FinOps tools |
| **Showcase data is frontend-only** | multi-account/multi-cloud views in the demo are frontend fixtures, never database rows, and are labelled as such. The app runs identically with them removed. |
| **USD only** | every account in scope bills in USD. A non-USD account would need an FX policy before any total is meaningful. |
| **Partial current period** | labelled, not hidden; comparing month-to-date against a full month otherwise reads as a 40–60% drop |
| **No HA, no multi-region** | a 10-day demo |

---

## Prepared answer: "what isn't real yet?"

Volunteering this earns more credibility than being caught by it.

> The pipeline is real and running against two live AWS accounts through a
> read-only cross-account role. The access control is real and enforced in
> SQL, not in the UI — a user with no grants gets zero rows. The anomaly
> detection runs on actual data.
>
> The multi-account and Azure views are **frontend fixtures**, clearly
> labelled, because we have two accounts today and no Azure subscription.
> They show layout at scale, not results. The app runs identically with
> them removed.
>
> The **Azure connector is written**, not stubbed — it needs a subscription
> and a Cost Management Reader role, which is the access request we are
> making next. Until then it is unit-tested against recorded responses, not
> verified live.
>
> GCP is architecture only. The database is on a public endpoint with TLS,
> which is deliberate for a 10-day demo and documented as the first
> hardening item.
>
> Nothing architecturally hard is missing.

---

## Prepared answer: "why not just deploy CID?"

> We do use it as the reference. CID is MIT-0, it aggregates independent
> payers, it has row-level security, and AWS maintains Azure, GCP and OCI
> connectors — so we are not claiming to have built that.
>
> What it does not give us: AWS's own documentation states FOCUS omits
> `lineItem/Operation` and is therefore not recommended for cost
> optimisation. It also costs $3–$40 per user per month on QuickSight
> Enterprise, plus $250/month once generative features are enabled, and it
> cannot express cost per pipeline run or per client because it does not
> know what those are.
>
> So we built the layer above it, not a replacement for it.
