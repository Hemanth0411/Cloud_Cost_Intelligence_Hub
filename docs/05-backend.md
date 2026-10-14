# Backend

Python 3.11. FastAPI behind an API Gateway HTTP API via Mangum, `psycopg` 3
with plain SQL. One zip, five Lambda handlers.

**Not a Lambda Function URL.** The URL is gone — this account blocks
anonymous Lambda invocation, so the API is reached through
`terraform/apigateway.tf`. Payload format 2.0 is identical, so Mangum and
the application code did not change. `lambda_handlers.py` still has
`(Function URL)` in two docstrings; that is a stale comment in the code, not
a live configuration. See [02-architecture.md](02-architecture.md) for the
evidence.

---

## Module map

```
costhub/
├── config.py            Settings from the environment (.env in dev)
├── db.py                connections, fetch_all / fetch_one / execute
├── migrate.py           applies migrations/*.sql once each
├── audit.py             append-only audit_log writer, takes a cursor
├── cli.py               operator commands: connections, grants, ingest, backfill
├── cli_jobs.py          the job commands: detect, alerts, status (split for NFR-18)
├── lambda_handlers.py   the five Lambda entry points
│
├── rbac/
│   ├── admin.py         invite, grant, revoke, list_grants      [superadmin]
│   ├── resolve.py       effective grants for a user, now
│   ├── pool.py          Cognito pool writes: create / enable / disable
│   └── users.py         remove a user, change a role
│
├── connections/
│   ├── store.py         cloud_connections CRUD, the three-outcome upsert
│   ├── edits.py         patch, enable/disable, soft delete
│   ├── credentials.py   self / assume_role / profile / secret -> boto3
│   │                    session.  `profile` CANNOT run in Lambda
│   ├── key_store.py     the access key in Secrets Manager; owns the prefix
│   ├── probe.py         the two-stage connection test
│   └── account_dim.py   keeps dim_account in step with a connection
│
├── query/
│   └── scoped.py      ★ THE ONLY READER OF fact_cost_daily
│
├── ingest/
│   ├── ports.py         CostRow, the CostSource protocol
│   ├── sources.py       provider -> adapter; ADAPTERS is {aws, azure}
│   ├── errors.py        ExpectedIngestError: configuration, not a defect
│   ├── cost_explorer.py AWS Cost Explorer adapter
│   ├── azure_cm.py      Azure Cost Management adapter (never run live)
│   ├── azure_parse.py   pure response parsing, no I/O
│   ├── dev_seed.py      generated rows -- local only, never the demo
│   ├── report.py        result formatting, no I/O
│   ├── stale.py         closes ingest_runs whose process died
│   └── runner.py        orchestration + ingest_runs lineage
│
├── anomaly/
│   ├── ports.py         the Detector protocol, Finding
│   ├── mad.py           rolling median + MAD, step/spike/creep classifier
│   ├── ceilings.py      the two numeric clamps the schema requires
│   └── runner.py        per account x service scan
│
├── alerts/
│   ├── ports.py         the Notifier protocol
│   ├── evaluate.py      threshold / forecast / digest / anomaly
│   ├── inapp.py         writes alert_events
│   ├── ses.py           email (never raises; returns a failed Delivery)
│   └── runner.py        orchestration + the FR-34 access re-check
│
├── insights/
│   ├── facts.py         the figures, computed through query/scoped
│   ├── cards.py         the card shapes
│   ├── frames.py        the candidate sentences, all already true
│   ├── narrate.py       the prompt and the one Bedrock call
│   ├── service.py       the order things happen in, and every degradation
│   ├── cache.py         stored choices, the call budget, the ledger
│   ├── coverage.py      the last day whose cost is final
│   └── fmt.py           display formatting
│
└── api/
    ├── main.py          app, CORS, the 500-inside-CORS fix, the 422 scrub
    ├── deps.py          JWT verify -> Principal; the only construction site
    ├── envelope.py      as_of / metric / currency / partial_period
    ├── connection_keys.py  reads the two credential fields, once
    └── routes/
        ├── cost.py              series, breakdown, compare
        ├── meta.py              scoped accounts and services, /meta/me
        ├── anomalies.py         list, scan now, acknowledge
        ├── alerts.py            rule CRUD, in-app feed
        ├── admin.py             users, grants, audit, ingest-runs
        ├── user_edits.py        remove a user, set a role  (mounted by admin)
        ├── connections.py       register, list, enable, test
        ├── connection_edits.py  patch, delete    (mounted by connections)
        ├── connection_import.py import now       (mounted by connections)
        └── insights.py          computed insights, with optional narration
```

`focus_export.py` does not exist — it is TODO-15. Everything else above is
written.

Three route modules are mounted by their parents rather than by `main.py`,
so the paths do not change: `user_edits` under `admin`, and
`connection_edits` and `connection_import` under `connections`. They were
split out on the 300-line limit, not because they are a different concern.

### `config.py` is almost the only reader of `os.environ`

`lambda_handlers.py` reads `INGEST_DAYS` and `ALLOWED_EMAIL_DOMAIN`
directly, because a Lambda entry point runs before `Settings` is useful,
and `insights/narrate.py` and `insights/service.py` read `INSIGHTS_*`
directly. The claim that `config.py` is the **only** reader was false and
is not repaired by repeating it.

### Two settings defaults that are security properties

`app_env` defaults to `"prod"`, not `"dev"`. And `allow_dev_auth` defaults
to false and is **never set by Terraform**. Both exist because the
`X-Dev-User` header bypass needs all three of `allow_dev_auth`, `app_env ==
"dev"` and no configured Cognito pool — and with `app_env` defaulting to
`"dev"` while Terraform sets `APP_ENV` to the workspace name, a deployed
`dev` environment satisfied one condition permanently, leaving only the
pool id between a public endpoint and a full superadmin bypass. An insecure
default is not a default.

---

## `query/scoped.py` ★

The security boundary. Everything else is plumbing.

| Export | Purpose |
|---|---|
| `GRANT_PREDICATE` | the SQL `EXISTS` clause, as a module constant so it is reviewable in isolation |
| `SUPERADMIN_BYPASS` | the literal `TRUE` that replaces it for a superadmin |
| `Principal` | `user_id`, `email`, `role`; built from the verified token only |
| `system_principal()` | the one sanctioned superadmin, for background jobs |
| `Filters` | date range, provider/account/service, metric, tax-and-credits toggle |
| `series(principal, filters, grain)` | cost over time (FR-18) |
| `by_dimension(principal, filters, dimension, limit)` | breakdown (FR-19) |
| `compare(principal, current, previous, dimension)` | period over period, absolute **and** percent delta (FR-21, FR-22) |
| `all_series(principal, start, end)` | every daily series, densified — for detection |
| `visible_accounts(principal)` | scoped dropdown contents (FR-9) |
| `visible_services(principal, provider, account)` | scoped dropdown contents |

### What the invariant actually says

Every fact query in this module goes through `_where()`, and `_where()`
injects **one of two things**: `GRANT_PREDICATE` for an ordinary user, or
`SUPERADMIN_BYPASS` — the literal `TRUE` — for a superadmin, in which case
it also writes an audit row. Stating it as "always injects GRANT_PREDICATE"
is a useful shorthand that is not quite true, and the bypass is the half
worth being precise about.

### The bypass audit lives here, not in `deps.py`

`_note_bypass` is called from `_where`, at the point the predicate is
actually replaced, carrying the scope that was read. It used to be logged
at authentication time instead, which recorded "a superadmin signed in" —
true of a superadmin who only ever opened the settings page — and recorded
no scope at all, so the audit trail could not answer the one question it
exists for: *which accounts did they look at.*

Throttled per `(actor, scope)` per hour, so a dashboard refresh does not
bury the log while reading a *different* account still shows up. The system
principal is excluded: background jobs are supposed to see everything, and
they log once per run.

`visible_services` passes `audit_bypass=False`, and the reason is worth
knowing. It returns service **names** and no figures, but the audit entry
says `entity_type='fact_cost_daily'` with the scope read — i.e. it claims a
superadmin looked at cost data. The grant dialog calls it every time the
operator changes the account in a dropdown, so clicking through ten
accounts manufactured ten bypass records before anyone had been granted
anything, and the audit screen headlines that count as evidence. An audit
log that overstates is as hard to trust as one that understates. The grant
predicate is still applied; only the note is suppressed.

### Why no ORM

The grant predicate decides who sees whose spend. Written as SQL it can be
read, reviewed and diffed directly. Generated by an ORM it would have to be
inferred from query logs. For the one piece of code that must be obviously
correct, explicit SQL is the safer choice.

### Injection safety

`GROUP BY` targets and time grains are interpolated into SQL, so they come
from the `DIMENSIONS` and `GRAINS` allowlists — never from caller input.
Every value is a bound parameter.

### Densification, and why it is in the reader

`all_series` inserts explicit zero rows for days a series has no data,
because both ingest adapters drop zero rows and the detector does index
arithmetic that assumes one index is one day. A weekday-only service
produced a "28-day window" spanning 38 calendar days, and
`exclude_recent_days` then dropped the last two *points*, possibly a week
old, instead of the last two days.

It fills only **between** a series' own first and last day. The first-day
guard stops a service that started last week acquiring months of fabricated
zeroes. The last-day guard matters more: without it a service that was
switched off reads as a long run of real $0 days, so the detector treats
"deleted" as "dropped to zero" — both a false anomaly and a way to drag a
baseline down so the next genuine charge looks like a step change. A gap at
the end of a window is missing data, not a measurement.

### Decimal all the way through

`compare()` builds its deltas as `Decimal`, because float64 is coarser than
the six decimal places `numeric(18,6)` carries, so `delta_abs` could be
wrong in the sub-cent digits it claims to report (NFR-7). Percent stays a
float — it is a ratio for display, not money — and is `None` rather than
infinity when there is nothing to compare against.

### Tests

`tests/test_scoped.py` covers fail-closed first, then account scoping,
`service_name IS NULL` semantics, per-service narrowing, expired, future
and revoked grants, the superadmin bypass, an unknown dimension, and the
tax-and-credits default.

`tests/test_invariant.py` is the one that enforces the architecture rather
than the behaviour. Four checks, each with a companion test that proves the
check can fail:

| Check | Fails the build when |
|---|---|
| single reader | any module outside `{query/scoped.py, ingest/runner.py}` has a SQL literal selecting from `fact_cost_daily` |
| predicate coverage | `scoped.py` has more `FROM fact_cost_daily f` than `_where(principal, f…)` calls |
| no fabricated superadmins | any module outside `scoped.py` constructs `Principal(role="superadmin")` |
| file size | any module over 300 lines, except the reasoned `SIZE_EXEMPT` entry |

The size exemption is `query/scoped.py` alone, and a further test asserts
the exemption is **still needed** — so an exemption cannot outlive its
reason. Splitting that file to satisfy a line count would trade the NFR-1
security property for a style one, and would defeat the single-reader check
above.

---

## `ingest/`

```python
class CostSource(Protocol):
    name: str
    def fetch(self, *, account_id, start, end) -> Iterable[CostRow]: ...
```

`CostRow` field names follow FOCUS, so a FOCUS-export adapter later needs
no translation layer (NFR-20).

| Adapter | Source | State |
|---|---|---|
| `cost_explorer` | `ce:GetCostAndUsage`, `DAILY`, grouped by `SERVICE` + `REGION` | built, running |
| `azure_cm` | Azure Cost Management Query API | built, **never run against Azure** |
| `dev_seed` | generated rows, so the backend can be built with no AWS credentials | built, local only |
| GCP | — | **no adapter.** `ADAPTERS` is `{aws, azure}` |
| `focus_export` | Athena over a FOCUS export | TODO-15 |

Adding a provider is one new class plus one entry in `sources.py` (NFR-17);
`runner.py`, the CLI and the Lambda handler never change. A connection
naming a provider with no adapter raises `NoAdapter`, which is an
`ExpectedIngestError` — so the run reports it clearly instead of stopping
the other accounts.

### Two different things called "mock"

Conflating them is how a demo ends up proving nothing.

| | Purpose | Lives in |
|---|---|---|
| `dev_seed` | lets the backend be developed with no AWS credentials | this module, and only a local database |
| The mock estate | shows what many accounts across clouds *look like* | **the frontend only** — [15-mock-vs-live.md](15-mock-vs-live.md) |

The mock estate never enters the database. There is no path by which it can
be served as real, and removing it is deleting a directory rather than a
migration plus a data cleanup.

`dev_seed` invents service names as CUR service *codes* (`AmazonEC2`,
`AmazonRDS`), not the Cost Explorer display names the real adapter writes
(`Amazon Elastic Compute Cloud - Compute`). Harmless today, but locally
seeded rows will not match live labels or the frontend mock.

### Cost Explorer specifics

- The endpoint is **us-east-1 only**, wherever else the code runs.
- `GroupBy` accepts at most **2** dimensions, so `SERVICE` + `REGION` is the
  limit and charge category has to come from elsewhere.
- `End` is **exclusive**.
- Each call costs $0.01, which is why ingest is scheduled rather than
  polled.
- Roughly 14 months of daily history is available by default.
- `LINKED_ACCOUNT` returns a single value in a standalone account, so
  multi-account coverage comes from iterating connections, not grouping.

**Charge category is derived, not returned.** Cost Explorer has no
charge-category dimension: grouping by `SERVICE` returns `Tax` and `Refund`
*as service values*. Hardcoding `"Usage"` therefore made the downstream `NOT
IN ('Tax','Credit')` filter match nothing, so breakdowns showed a Tax row
while claiming to exclude it and the detector scanned Tax as if it were a
service. `NON_USAGE_SERVICES` maps the values that can actually appear in a
`SERVICE` grouping.

**The limitation that follows, stated rather than implied.** Discounts and
credits mostly arrive as **negative amounts attached to the real service
name**, not as a separate service, so they are still labelled `Usage` and
still net against that service's spend. Separating them needs a second CE
call grouped by `RECORD_TYPE` — the `GroupBy` ceiling of 2 is why it cannot
come from this one. FR-23 is therefore only partly satisfied: `Tax` and
explicit `Refund` rows are excluded, inline credits are not. TODO-27.

**`AmortizedCost` is checked for presence, not truthiness.** `Decimal("0")`
is falsy, and a zero `AmortizedCost` is exactly what a Reserved Instance or
Savings Plan upfront looks like on the day it is charged — so the old `or
billed` wrote the whole upfront into `effective_cost`, the one-day spike
amortisation exists to remove, which then surfaced as a spike finding.

**How many calls a window is.** `_monthly_windows` splits a range into
calendar-month chunks, so the count is the number of months the range
*touches*, not its length. `default_window(days)` returns `[today - days,
today + 1)`, which is `days + 1` dates — so `days=7` is two months on the
1st to the 7th of any month, and `days=31` always touches two and sometimes
three. "A week is one call" is false for a quarter of every month;
`tests/test_stale_runs.py` pins the counts through that function.

---

## `anomaly/`

```python
class Detector(Protocol):
    name: str
    def detect(self, series: list[tuple[date, Decimal]]) -> list[Finding]: ...
```

**This is our own detector, not AWS Cost Anomaly Detection.** Rolling
median plus median absolute deviation (`mad.py`), scored against the window
*preceding* each candidate day. Deliberately not Prophet or an ML model:
the output is "you may be wasting money", and "6.2 MADs above the 28-day
median, sustained for 9 days" is a sentence someone can argue with. A model
score is not. Prophet is also a painful dependency inside a Lambda zip.

Why median and MAD rather than mean and standard deviation: the outliers
being hunted would inflate both, so a real anomaly partly hides itself.

### Three shapes, in the order that matters

| Kind | What it means | Why it is first |
|---|---|---|
| `step` | something was switched on and left on | the common, expensive case, and the one a naive spike detector misses entirely |
| `spike` | one bad day | often a billing artefact |
| `creep` | a slow drift that never trips a single-day threshold | invisible to any per-day rule |

`_classify` compares the start of a flagged run against its end, because
the question is not steepness — it is the operator's next action. A jump to
a new plateau means "something was switched on, go find it"; a continuing
climb means "something is growing".

Consecutive flagged days are collapsed into one finding, tolerating gaps up
to `merge_gap_days`. Without that, a step change reports once per day for
as long as it persists, which trains people to ignore the feed; and a
rising series flags intermittently, because the trailing median climbs with
it, so strict consecutive-only grouping emits a new finding every time the
gap reopens.

### Sparse series are scored against their own active days

A service billed on 12 of 28 days has more zero days than non-zero ones
once the series is densified, so the median lands on zero however large the
charges are — and the score returned 0.0, making such a series unflaggable
*at any amount*. The fix scores the sparse case against the series' **own
active days**, ignoring the densified zeros: a gap is missing data, not a
measurement of nothing.

That keeps the recurring-charge behaviour the 0.0 was protecting while
restoring the one case it hid. Measured on real data, before and after
(CONTEXT.md, "The anomaly detector", holds the full table):

| Series | Active-day median | Observed | Before | After |
|---|---|---|---|---|
| AWS Glue, 2026-08-12 | ~$0.03 | $224.05 | 0.0 | flags |
| AWS Support, monthly | $500 | $500 | 0.0 | does not |
| a first-ever charge | no active days | any | 0.0 | does not |

A genuinely first-ever charge is a **new service**, not an anomaly.
Detecting those is a separate feature with a different message.

### The two clamps are schema constraints, not statistics

`ceilings.py` holds them, away from the arithmetic, because that is what
they are. `anomaly_findings.score` and `delta_pct` are both
`numeric(10,4)`, and a sparse series divides by an active-day MAD of a
fraction of a cent, so both can reach the millions on perfectly real data.

Unclamped, one overflowing finding raised `numeric field overflow` from
inside the per-series loop — the insert happens there, not at the end — and
took the **whole scan** down. So one absurd percentage cost every other
finding in the run. Clamping rather than widening the columns is
deliberate: past a certain point "definitely anomalous" is the entire
content of the number, and ordering among absurd values is not information
worth a migration.

### Two limits worth knowing before trusting a quiet feed

1. **"The last 7 days" is relative to each series' last row, not to
   today**, because zero-fill stops at the series' own last day. A charge
   followed by silence sits in the two dropped points forever.
2. `series_scanned` counts series **before** the `min_history` gate, so the
   number it reports overstates what was actually scored.

Findings are upserted on `(provider, account_id, service_name,
detected_for_date, method)`: measurements are refreshed on re-run, but
**status is not**. Once somebody has acknowledged or dismissed a finding, a
nightly job must not quietly mark it new again.

---

## `alerts/`

```python
class Notifier(Protocol):
    channel: str
    def send(self, event: Event, *, recipients: list[str]) -> Delivery: ...
```

Two notifiers: `inapp` (a row in `alert_events` the UI reads) and `ses`
(email, which never raises — it returns a failed `Delivery`).

**There is no SNS notifier and no SNS topic.** One was deployed for a while
as a landing point for TODO-17; nothing published to it, so it was two
resources, a dead IAM action, a dead Lambda environment variable and a
subscription-confirmation email in support of a feature that does not
exist.

`evaluate.py` holds the four rule types. The non-obvious requirement is
FR-34: `rbac.resolve` is called **before the rule is evaluated**, because a
rule can outlive the grant that justified it. See
[04-data-flow.md](04-data-flow.md) for why checking at *send* time was
subtly wrong.

---

## `insights/`

`GET /insights` is real, and it has a backend. The figures are computed by
`insights/facts.py` through `query/scoped` with the caller's `Principal`,
exactly as the cost screens are. **A model on Amazon Bedrock only chooses
the wording.**

The contract, stated as the code enforces it:

- `frames.py` writes the candidate sentences. Every candidate is already
  true of the figures on that card.
- `narrate.py` shows the model each card's figures and its numbered
  candidates, and asks two things: which candidate reads best per card, and
  which card to lead with. It answers with card ids and integers.
- It is never asked to add, subtract, rank or round anything, and **nothing
  it writes is shown to anyone.** The worst a bad answer can do is leave a
  card without a sentence.
- `frames.select` keeps only valid choices — card ids we issued, integers
  in range. An invalid choice leaves no sentence rather than a wrong one.

So this module is not a control and does not need to be. A card with `text:
null` is a complete, correct card.

**The model is `amazon.nova-lite-v1:0`**, and that was not the first
choice: every Anthropic model in the deploy account is refused until its
owner submits the Anthropic use-case form in the Bedrock console. Nova
Micro is cheaper and also works, but in four runs it chose the first
candidate most of the time and led with the same card every time —
position bias rather than judgment. The IAM grant is a **single foundation
model ARN**, not `bedrock:*`; `terraform/iam.tf` and `INSIGHTS_MODEL_ID`
must be changed together or every call is denied.

Narration degrades in seven places and **none of them can fail the
request**: no cache, breaker open after a recent failure, daily call budget
reached, another request already in flight, a Bedrock error, an unreachable
Bedrock, or an answer with no valid choice. Each sets
`narration.status` / `narration.reason` truthfully. There is no fallback
text.

Timeouts are bounded well inside the request: 2s to connect, a read timeout
of `INSIGHTS_BEDROCK_TIMEOUT_S` (default 5, clamped to 10), and **one
attempt in total** — `total_max_attempts: 1`, not `max_attempts: 1`, which
is the number of *retries* and so meant two calls and up to twice the
timeout. botocore's defaults are 60s and several attempts, which would
outlive the request.

Full reference: [16-insights-api.md](16-insights-api.md).

---

## `api/`

`deps.py` is the only place a `Principal` is constructed:

1. verify the JWT **signature** against the pool's JWKS
2. verify issuer, audience and expiry, with `require: [exp, iss, aud]`
3. require `email_verified` to be **exactly** true — absent is rejected
4. verify the email domain
5. look up the user; reject soft-deleted and `disabled`
6. return `Principal(user_id, email, role)`

Step 1 is called out because verifying claims but **not** the signature is
the classic failure here, and it is an open finding in the DFIQ RBAC audit.
`_verify` does the signature first and will not proceed without it.

Step 3 is stricter than it looks and the strictness is the point. Cognito's
`email` attribute is mutable, so a user who can change their own can set it
to a known superadmin's address and re-authenticate. Changing it flips
`email_verified` to false — but the attack is carried out with whatever
token the attacker can obtain, and one simply *lacking* the claim went
straight through an earlier lenient branch. A missing claim means
"unproven", and unproven is what this must refuse. There is also no
fallback to `username` or `cognito:username`: the pool is
`username_attributes = ["email"]`, so for a real user those claims hold the
email — which is what made the fallback look free — but they carry no
verification status at all.

### Two things `main.py` does that are not obvious

**An unhandled 500 must still carry CORS headers, and the order of
`add_middleware` is the whole fix.** Starlette's `ServerErrorMiddleware`
sits outside user middleware, so the response it synthesises for an
uncaught exception never passes through `CORSMiddleware`; the browser
rejects it for a missing `Access-Control-Allow-Origin` and `fetch` rejects
— indistinguishable, client-side, from the API being unreachable. Genuine
server faults were being reported to the operator as a CORS
misconfiguration. An `@app.exception_handler(Exception)` does **not** fix
it, which is worth recording because it looks like it should: Starlette
routes that handler to `ServerErrorMiddleware` itself, the outermost layer.
`add_middleware` prepends, so `_UnhandledErrors` must be registered
**before** `CORSMiddleware` to end up inside it. Swapping the two lines
silently reverts the fix.

**A 422 must not echo a credential back, and by default it does.** FastAPI's
built-in handler returns `exc.errors()` verbatim, and pydantic v2 puts the
offending `input` in every entry — for a `missing` error that input is the
*whole parent object*, so `POST /admin/connections` carrying an access key
but missing `display_name` answered 422 with the entire body, key included.
Nothing was stored and nothing was logged; it came straight back out of the
validator before any route ran. The handler blanks `access_key_id` and
`secret_access_key` wherever they appear and passes everything else
through, because the point of a 422 is to say which field was wrong.

Also: `allow_origins` is never `origins or ["*"]`. An unset `CORS_ORIGINS`
used to serve a wildcard **with credentials enabled**; no origins
configured means no cross-origin access, which is the safe reading of
"unconfigured".

### Routes

32 operations: 31 on the routers plus the unauthenticated `/health`.
Every cost response carries `as_of` and `metric` so no chart is ambiguous
(FR-25). To re-derive rather than trust this number:

```bash
grep -rhoE '@router\.(get|post|delete|patch|put)\('   backend/costhub/api/routes/*.py | wc -l
```

| Method | Path | Access |
|---|---|---|
| `GET` | `/health` | public — reports env, database and auth mode |
| `GET` | `/cost/series` | user |
| `GET` | `/cost/breakdown` | user |
| `GET` | `/cost/compare` | user |
| `GET` | `/meta/accounts` | user — scoped |
| `GET` | `/meta/services` | user — scoped |
| `GET` | `/meta/me` | user |
| `GET` | `/insights` | user |
| `GET` | `/anomalies` | user |
| `POST` | `/anomalies/scan` | **superadmin** |
| `POST` | `/anomalies/{id}/ack` | user |
| `GET` `POST` | `/alerts/rules` | user |
| `DELETE` | `/alerts/rules/{id}` | user |
| `GET` | `/alerts/feed` | user |
| `POST` | `/alerts/feed/{id}/read` | user |
| `GET` `POST` | `/admin/users` | **superadmin** |
| `DELETE` | `/admin/users/{id}` | **superadmin** |
| `POST` | `/admin/users/{id}/role` | **superadmin** |
| `GET` `POST` | `/admin/grants` | **superadmin** |
| `DELETE` | `/admin/grants/{id}` | **superadmin** |
| `GET` | `/admin/audit` | **superadmin** |
| `GET` | `/admin/ingest-runs` | **superadmin** |
| `GET` `POST` | `/admin/connections` | **superadmin** |
| `PATCH` `DELETE` | `/admin/connections/{id}` | **superadmin** |
| `POST` | `/admin/connections/{id}/enabled` | **superadmin** |
| `POST` | `/admin/connections/{id}/test` | **superadmin** |
| `POST` | `/admin/connections/{id}/import` | **superadmin** |

Swagger UI at `/docs`, ReDoc at `/redoc`, the schema at `/openapi.json`.

`test` and `import` answer **200 with a verdict in the body** rather than a
4xx: "the request ran and the connection is broken" and "the request
failed" are different facts and the operator needs to tell them apart. See
[17-connection-lifecycle.md](17-connection-lifecycle.md).

---

## The operator CLI

`python -m costhub.cli` and `cli_jobs`. Against the **deployed** database,
go through `do.sh`:

```bash
./do.sh cli dev status
./do.sh cli dev backfill --months 14 --account-id <id>
./do.sh cli dev detect --lookback 420 --scan-days 400
```

`./do.sh cli <env> <args>` resolves `DATABASE_URL` by reading it off the
**API Lambda's own configuration** (`aws lambda
get-function-configuration`), falling back to Terraform state only if that
is empty. Without it you get `backend/.env`, which is the Neon sandbox full
of `dev_seed` rows — so `status` cheerfully reports a healthy estate that
nobody is looking at. That is CONTEXT.md trap 8.

Detection defaults score only the last 7 days, which finds nothing in
freshly imported back history — hence the wide `--scan-days` above after a
backfill.

---

## References

| Library | Version | Use |
|---|---|---|
| [`psycopg`](https://www.psycopg.org/psycopg3/docs/) | 3.2 | Postgres driver (`[binary]`, no build step) |
| [`fastapi`](https://fastapi.tiangolo.com/) | 0.115 | the API |
| [`mangum`](https://mangum.io/) | — | ASGI adapter for Lambda; payload format 2.0 |
| [`pydantic`](https://docs.pydantic.dev/) / `pydantic-settings` | 2.9 / 2.6 | models, env config |
| [`boto3`](https://boto3.amazonaws.com/v1/documentation/api/latest/reference/services/ce.html) | 1.35 | `ce`, `sts`, `secretsmanager`, `ses`, `cognito-idp`, `bedrock-runtime` |
| [`pyjwt`](https://pyjwt.readthedocs.io/) | — | JWT verification against JWKS |
| [`httpx`](https://www.python-httpx.org/) | — | the Azure adapter's transport |
| [`pytest`](https://docs.pytest.org/) | 8.3 | tests |

**Lambda packaging:** zip, not container images — no Docker on the dev
machine. `do.sh build` installs with `pip --platform
manylinux2014_x86_64`.

**Never strip `*.dist-info` from the zip.** `do.sh` used to, which broke
`importlib.metadata`: pydantic reads `email-validator`'s version while
building the `EmailStr` schema, so `from fastapi import FastAPI` raised
`PackageNotFoundError` and the entire API was dead — while the zip built,
uploaded and applied cleanly.

### SQL we borrow

Cost dashboard SQL is lifted from these rather than written from scratch:

- [`turbot/tailpipe-mod-aws-cost-and-usage-insights`](https://github.com/turbot/tailpipe-mod-aws-cost-and-usage-insights) — Apache-2.0
- [AWS CUR Query Library](https://www.wellarchitectedlabs.com/cost-optimization/cur_queries/) — AWS-published

Note the Powerpipe licence split: the CLIs are AGPL-3.0, but the **mods** —
the dashboard and SQL definitions — are Apache-2.0, which is what makes
reuse clean here.

---

## Conventions

- Source files ≤300 lines (NFR-18), enforced by `test_invariant.py`
- `from __future__ import annotations` in every module
- Money as `Decimal` in Python and `numeric` in SQL — never float
- `audit.log()` takes a **cursor**, not a connection, so the entry shares
  the caller's transaction
- Protocols for the three swap points; no inheritance hierarchies
- Audit columns on every table that records a human action; `created_by`
  always supplied explicitly
