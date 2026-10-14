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
| TODO-4 | ~~Verify JWT signatures against Cognito JWKS~~ | **Done** (`api/deps.py:_verify` — signature before claims, `require: [exp, iss, aud]`). | S |
| TODO-5 | **Narrow the `ce:` grant on our own Lambda role.** It allows 8 actions — `GetCostAndUsage`, `GetCostForecast`, `GetDimensionValues`, `GetTags`, `GetAnomalies`, `GetAnomalyMonitors`, `GetAnomalySubscriptions`, `ListCostAllocationTags` — and the code calls exactly **two**: `GetCostAndUsage` (`ingest/cost_explorer.py`) and `GetDimensionValues` (`connections/probe.py`). Six have no caller, and the role is shared by all five functions. Also: rotation for the `secret` credential mode. | read-only and harmless, but it is not least privilege | S |
| TODO-6 | **WAF on the API.** Rate limiting is **done**: the API Gateway `$default` stage sets `throttling_burst_limit = 20` and `throttling_rate_limit = 50`, which a Function URL could not do and which matters at an account concurrency ceiling of 10. A WAF is the remaining half | the gateway landed for a different reason — the account refuses anonymous Lambda invocation — and brought throttling with it | M |
| TODO-7 | CloudTrail and GuardDuty on the deploy account | cost and noise for a short-lived account | S |
| TODO-8 | Cognito MFA and token-expiry tuning | email OTP is already a second factor in practice | S |
| TODO-9 | Superadmin bypass audit | **Done, and it moved.** It is now `query/scoped._note_bypass`, called from `_where` at the point the predicate is actually replaced, carrying the **scope** that was read — not `api/deps.py`, which recorded "a superadmin signed in" and no scope at all. Throttled per `(actor, scope)` per hour. Two deliberate exclusions, both reasoned in the code: the system principal, which logs once per run, and `visible_services`, which returns names rather than money. A new module minting its own superadmin `Principal` now fails `test_invariant.py`. Still open: **no test asserts the audit row itself.** | M |
| TODO-10 | ~~Enforce `audit_log` append-only~~ | **Done** as `migrations/005_audit_append_only.sql`, via statement triggers rather than the GRANT originally imagined. Still open: `TRUNCATE` is not blocked. | S |

TODO-4, TODO-9 and TODO-10 are now **done**, which is what makes the
security claims in [07-security-rbac.md](07-security-rbac.md) true rather
than intended. What remains open on that list is TODO-1/2 (the public
database), TODO-3 (rotation), TODO-5 (an over-broad `ce:` grant), the WAF
half of TODO-6, TODO-7, TODO-8, and a test for the bypass audit row.

---

## Operational

| ID | Item | Note |
|---|---|---|
| TODO-11 | Tested RDS restore, not merely enabled backups | an untested backup is a hope |
| TODO-12 | ~~Replace the Amplify branch password with Cognito-only~~ | **Done.** `enable_basic_auth = false`; Cognito works and two password prompts to reach one demo is one too many. Note what that did and did not change: the password only ever covered the Amplify-hosted frontend, and the API behind it was a public endpoint guarded by the JWT the whole time. The variables are still declared so it can be put back |
| TODO-13 | **Alert on ingest failures**, not only on cost anomalies | a silent ingest failure looks exactly like "costs went to zero" |
| TODO-14 | Credit-exhaustion alarm | on AWS's Free plan, exhausted credits **suspend** resources rather than bill — a demo that dies silently |

---

## Functional

| ID | Item | Why it is not in the demo |
|---|---|---|
| TODO-15 | **FOCUS export deep layer** (S3 + Athena + Glue) for resource-level drill-down and multi-cloud | 48h to first delivery plus bucket policies and Glue; Cost Explorer needs two permissions and returns data now |
| TODO-16 | **GCP ingestion — the one place the demo promises more than exists.** `ingest/sources.py` `ADAPTERS` is `{aws, azure}`, so a GCP connection raises `NoAdapter` and imports nothing, while the mock estate shows three Google Cloud accounts and the connect dialog offers a GCP project-id field | the port and the schema are ready; it is a missing module, not an impossible one — one entry in `ADAPTERS` and one new file. Left in deliberately rather than cutting a quarter of the multi-cloud story. **Owner's call: write the adapter, or say on screen that Google Cloud is a roadmap item.** |
| TODO-16b | **Azure credentials** — the adapter is **written and unit-tested**, not deferred | needs a subscription plus an Entra app registration with **Cost Management Reader**. Built first deliberately, so the access request is concrete: "the connector exists, we need a subscription" is an easier ask than "can we explore Azure". Unverifiable until credentials land — say so rather than implying it is live. |
| TODO-17 | **Consume AWS Cost Anomaly Detection via SNS** | free, managed, already tuned for cost data; would let us aggregate real detections across accounts and drop our own detector. Creates the topic too — an earlier version shipped an unused one, which is why there is none now |
| TODO-18 | ~~**Bedrock narration** over computed results~~ | **Done**, and done in the stricter form the warning implied. `GET /insights` computes every figure through `query/scoped`; the backend writes the candidate sentences, all already true, and the model on Bedrock only **chooses** among them and picks a lead card. It is never asked to add, subtract, rank or round anything, and nothing it writes is shown to anyone — an invalid choice leaves a card with `text: null` rather than a wrong sentence. The model is `amazon.nova-lite-v1:0`, because every Anthropic model in this account is refused until its owner submits the Bedrock use-case form. See [16-insights-api.md](16-insights-api.md) |
| TODO-19 | **Untagged / unallocatable spend panel** | one `GROUP BY` on tags; the most actionable number for the business and the precondition for any chargeback. Strongest candidate for the next thing built. |
| TODO-20 | **Unit economics** — cost per pipeline run, project, client | the real differentiator. Needs Glue `get_job_runs` DPU-hours and Athena per-query `bytes_scanned` joined to our own run metadata. No vendor can do this. |
| TODO-21 | **Per-service grants in the UI** | schema already supports it (`service_name` nullable). Deferred because partial totals do not reconcile with anyone else's view or the invoice, and that generates arguments. Ship per-account first; flag per-service on when someone actually asks. |
| TODO-22 | **Group-based grants** (`principal_type` column) | per-user grants stop scaling around 25–30 people. One column plus a branch in the predicate. |
| TODO-23 | **Microsoft OAuth** | `identities` table already makes this an insert rather than a migration. Restrict by **tenant id**, not email domain string. |
| TODO-24 | Forecast beyond linear run-rate | linear is honest and explainable at this data volume |
| TODO-25 | ~~Currency normalisation~~ | **Dropped.** Every cloud account in scope bills in **USD**, so no FX policy is needed. Re-open only if a non-USD billing account is ever added — cross-currency totals without an explicit FX policy (which rate, pinned to which date) are nonsense. |
| TODO-26 | Commitment / amortisation semantics across providers | FOCUS unifies effective cost conceptually, but per-provider mapping fidelity varies; cross-cloud comparison is approximate and must say so |
| TODO-27 | **Separate inline credits and discounts from usage.** `charge_category` is derived in `ingest/cost_explorer.py` from the `SERVICE` value, which catches `Tax` and explicit `Refund` rows. Credits and discounts mostly arrive as **negative amounts attached to the real service name**, so they are still labelled `Usage` and still net against that service's spend — FR-23 is only partly satisfied | needs a second Cost Explorer call grouped by `RECORD_TYPE`: the `GroupBy` ceiling of 2 is already spent on `SERVICE` + `REGION`, so it cannot come from the existing one |

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
| **Neon is a local sandbox, not an environment** | `backend/.env` points at it and it holds `dev_seed` rows. Every environment, `dev` included, uses RDS. Real cost data in a third-party service would contradict our own argument against commercial FinOps tools. Conflating the two has already caused seeded rows to be read as live state |
| **No GCP adapter** | `ADAPTERS` is `{aws, azure}`; a GCP connection raises `NoAdapter`. The mock estate shows Google Cloud accounts anyway — TODO-16 |
| **Mock data is frontend-only** | the multi-account and multi-cloud views in the demo are mock data in the browser, never database rows, and the sidebar says which mode is live. Nothing shown on mock is a capability that cannot be real — except the Google Cloud accounts, above |
| **USD only** | every account in scope bills in USD. A non-USD account would need an FX policy before any total is meaningful. |
| **Partial current period** | labelled, not hidden; comparing month-to-date against a full month otherwise reads as a 40–60% drop |
| **No HA, no multi-region** | a 10-day demo |

---

## Prepared answer: "what isn't real yet?"

Volunteering this earns more credibility than being caught by it.

> The pipeline is real and running against live AWS accounts. The access
> control is real and enforced in SQL, not in the UI — a user with no
> grants gets zero rows, and a test fails the build if a second module
> ever reads the fact table. The anomaly detection is ours, not AWS Cost
> Anomaly Detection, and it runs on actual data.
>
> `/insights` is real too, and worth being precise about: the figures are
> computed by the API through the same scoped reader as every chart. A
> model on Bedrock chooses which of several sentences we wrote to show.
> **No number on that page is model-generated.**
>
> The multi-account and multi-cloud breadth is **mock data in the
> browser**, and the sidebar says so while it is on. It shows layout at
> scale, not results. It never becomes a database row.
>
> The **Azure connector is written**, not stubbed — it needs a
> subscription and a Cost Management Reader role, which is the access
> request we are making next. Until then it is unit-tested against
> recorded responses and has never spoken to Azure, and the connection
> probe says exactly that rather than guessing.
>
> **Google Cloud has no adapter at all** — the mock estate shows three GCP
> accounts and a real GCP connection would raise `NoAdapter` and import
> nothing. That is the one place the demo currently promises more than
> exists, and it is a missing module rather than a missing design.
>
> The database is on a public endpoint with TLS enforced, which is
> deliberate for a short-lived demo and is the first hardening item on
> the list.

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
