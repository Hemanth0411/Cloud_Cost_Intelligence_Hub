# Data flows

Five flows: ingest, scoped read, access change, anomaly detection,
alerting.

Two more sequences live elsewhere because they belong to one subject each:
**signing in** is in [07-security-rbac.md](07-security-rbac.md), and
**registering an account then importing from it** — including the two-stage
probe — is in
[17-connection-lifecycle.md](17-connection-lifecycle.md).

---

## 1. Ingest

`cron(0 6 * * ? *)`, once per enabled connection.

```mermaid
sequenceDiagram
    autonumber
    participant EB as EventBridge
    participant R as ingest/runner
    participant ST as ingest/stale
    participant SM as Secrets Manager
    participant STS as STS
    participant CE as Cost Explorer
    participant PG as PostgreSQL

    EB->>R: daily trigger
    R->>ST: reap_stale_runs
    ST->>PG: close runs stuck in 'running'
    R->>PG: SELECT enabled, non-deleted cloud_connections

    loop per connection
        R->>PG: INSERT ingest_runs status=running, COMMIT
        alt credential_mode = secret
            R->>SM: GetSecretValue by ARN
            SM-->>R: access key pair
        else credential_mode = assume_role
            R->>STS: AssumeRole role_arn + ExternalId
            STS-->>R: temporary credentials, ~1h
        else credential_mode = self
            R->>R: the Lambda's own execution role
        end
        R->>CE: GetCostAndUsage DAILY, by SERVICE + REGION
        Note over R,CE: one call per calendar month<br/>the window touches, plus pagination
        CE-->>R: rows for the window
        R->>PG: UPSERT fact_cost_daily ON CONFLICT DO UPDATE
        R->>PG: UPSERT dim_account, dim_service
        R->>PG: UPDATE ingest_runs success + rows_written
        R->>PG: UPDATE cloud_connections last_ingest_*
    end
```

### Why it looks like this

- **The run row is committed before fetching**, so a crash leaves a
  `running` row that is visibly stuck rather than silently absent. The
  other half of that design is `reap_stale_runs`, which is what closes a
  row whose process was killed — see
  [17-connection-lifecycle.md](17-connection-lifecycle.md).
- **A failed account does not abort the others** (FR-17). The loop catches
  per connection and records `failed` with the error.
- **The window is a trailing re-fetch**, not just yesterday, because AWS
  restates cost as it finalises. The natural-key upsert makes that safe and
  idempotent (FR-15). The default is 7 days plus today, overridable by
  `INGEST_DAYS` or an `event.days`.
- **Failures are surfaced, not raised.** The handler returns `ok: false`
  with the per-connection errors, because a silent ingest failure looks
  exactly like "costs went to zero", so the schedule must report it.
- **`credential_mode = profile` cannot run here at all.** There is no AWS
  CLI configuration in a Lambda execution environment, so such a connection
  fails every scheduled run permanently.

### Granularity

Cost Explorer supports `DAILY` and `MONTHLY`. We fetch `DAILY` and
aggregate upward in SQL with `date_trunc`, so week, month, quarter and year
views come from one ingest path rather than four.

---

## 2. Scoped read — the authorisation path

Every chart in the product goes through this.

```mermaid
sequenceDiagram
    autonumber
    participant FE as Browser
    participant AGW as API Gateway HTTP API
    participant API as api Lambda
    participant JWKS as Cognito JWKS
    participant Q as query/scoped
    participant PG as PostgreSQL

    FE->>AGW: GET /cost/series with filters and grain<br/>Authorization Bearer ID token
    AGW->>API: payload format 2.0, as the<br/>apigateway.amazonaws.com principal
    API->>JWKS: fetch the signing key
    JWKS-->>API: JWK
    API->>API: verify SIGNATURE, then iss, aud, exp
    API->>API: require email_verified === true
    API->>API: check the email domain
    API->>PG: SELECT id, email, role FROM users<br/>WHERE email = claim AND deleted_at IS NULL
    PG-->>API: the user row, or refuse
    API->>Q: series(Principal, Filters, grain)
    alt ordinary user
        Note over Q: _where injects GRANT_PREDICATE
    else superadmin
        Note over Q: _where injects TRUE<br/>and writes an audit row<br/>with the scope read
    end
    Q->>PG: SELECT ... FROM fact_cost_daily f<br/>WHERE ... AND EXISTS(grants)
    PG-->>Q: only permitted rows
    Q-->>API: rows
    API-->>FE: data + as_of + metric + partial_period
```

### The two rules

1. **`Principal` is built from the verified token**, never from a request
   body or a query parameter. A `user_id` in a request is ignored.
2. **The grant predicate is applied in SQL**, so unauthorised rows never
   leave the database. Filtering in the API — or worse, the frontend —
   would mean fetching data the user may not see.

### Fail closed

No grants → the `EXISTS` subquery matches nothing → **zero rows**. Not an
error, not everything. `test_no_grants_sees_nothing` is the first test in
the suite.

Note where that lands in HTTP terms: a user with no grants gets **200 with
an empty list**, and a non-superadmin hitting an admin route gets **403**.
Both are designed states, and the frontend must render an empty state for
either — never a sign-in loop.

### Superadmin

The predicate is replaced with the literal `TRUE`, and the bypass is
recorded in `audit_log` with the scope that was read (FR-38), throttled per
actor and scope per hour. An unlogged bypass is indistinguishable from a
leak.

It is recorded in `query/scoped._note_bypass`, at the point the predicate
is actually replaced — not at authentication time, which recorded "a
superadmin signed in" and no scope at all.

---

## 3. Access change

```mermaid
sequenceDiagram
    autonumber
    participant SA as Superadmin
    participant API as api
    participant AD as rbac/admin
    participant POOL as rbac/pool
    participant COG as Cognito
    participant PG as PostgreSQL

    SA->>API: POST /admin/grants {email, account, service?, valid_until?}
    API->>AD: grant(actor, actor_role, GrantRequest)
    AD->>AD: require superadmin
    AD->>AD: normalise_email + domain check
    rect rgb(238,238,238)
    note right of AD: ONE transaction
    AD->>PG: SELECT user by email
    AD->>PG: INSERT access_grants
    AD->>PG: INSERT audit_log grant.create, after={...}
    end
    PG-->>AD: commit
    AD-->>API: grant_id

    note over SA,COG: inviting is the same shape, plus a pool write
    SA->>API: POST /admin/users {email}
    API->>AD: invite_user
    rect rgb(238,238,238)
    AD->>PG: UPSERT users (un-deletes a removed row)
    AD->>POOL: create_user(email)
    POOL->>COG: AdminCreateUser, no password, SUPPRESS
    COG-->>POOL: created | exists | re-enabled
    AD->>PG: INSERT audit_log
    end
    PG-->>AD: commit
```

The shaded regions matter: the change and its audit entry commit together
(FR-37). Revocation is the same shape — `UPDATE ... SET revoked_at` plus an
audit row — and it is idempotent, so revoking twice is a no-op.

**Inviting needs both halves.** For a while it was only one:
`invite_user` wrote the `users` row and stopped, so an invited teammate got
a database row, Cognito had never heard of them, and no code could ever be
sent. The pool write is inside the same transaction, so a pool failure
rolls the `users` row back and a failed invite leaves nothing behind.

**Effect is immediate.** Nothing is cached, and the predicate evaluates
`now()` per query, so the next page load reflects the change.

---

## 4. Anomaly detection

`cron(30 6 * * ? *)` — half an hour after ingest, so it scores what ingest
just wrote.

```mermaid
flowchart TD
    A["EventBridge, 06:30 UTC"] --> B["anomaly/runner.scan<br/>lookback 120 days"]
    B --> C["query/scoped.all_series<br/>as the SYSTEM principal"]
    C --> D["densify: insert explicit $0 days<br/>only BETWEEN a series'<br/>own first and last day"]
    D --> E["group in Python by<br/>provider x account x service"]
    E --> F["drop the last 2 points<br/>unfinalised data = false positives"]
    F --> G{"at least min_history<br/>= 14 days?"}
    G -->|no| H["skip this series"]
    G -->|yes| I["score each candidate day<br/>against the window BEFORE it"]
    I --> J{"MAD > 0?"}
    J -->|yes| K["modified z-score"]
    J -->|"no, flat series"| L["fall back to relative change"]
    J -->|"no, baseline 0:<br/>SPARSE series"| M["score against the series'<br/>own ACTIVE days"]
    K --> N{"score >= 3.5<br/>and delta big enough?"}
    L --> N
    M --> N
    N -->|no| H
    N -->|yes| O["collapse consecutive<br/>flagged days into one run"]
    O --> P{"run span and shape"}
    P -->|"< 3 days"| Q["kind = spike"]
    P -->|"still climbing"| R["kind = creep"]
    P -->|"jumped and held"| S["kind = step"]
    Q --> T["clamp score and delta_pct<br/>numeric(10,4)"]
    R --> T
    S --> T
    T --> U["UPSERT anomaly_findings<br/>refresh measurements,<br/>NEVER reset status"]
    U --> V["one audit_log row per RUN"]
```

### Four decisions

**Per account × service, never the aggregate** (FR-26). A doubling of one
small service vanishes in the account total. Scanning the sum finds nothing
and feels productive.

**Step changes first** (FR-27). Cloud cost anomalies are overwhelmingly
"something was switched on and stayed on". A spike detector on cost data
mostly surfaces billing artefacts and trains people to ignore alerts.

**Median and MAD, not mean and standard deviation.** Robust to exactly the
outliers being hunted, and explainable — we can state why a point flagged,
which matters when the output is "you may be wasting money".

**One query, grouped in Python.** Fetching each series separately would be
thousands of round-trips. The whole window comes back once, through
`query/scoped` as the system principal — a named, greppable function, not a
scattered role literal, and one audit row per run rather than per query.

**This is ours, not AWS Cost Anomaly Detection.** Consuming AWS's managed
detector is TODO-17 and would require creating the SNS topic that does not
exist. The scoring, the clamps and the sparse-series behaviour are
described in [05-backend.md](05-backend.md).

Findings always carry baseline and observed values (FR-30): the
explanation, not just the flag.

---

## 5. Alerting

`cron(0 7 * * ? *)` — after detection, so an `anomaly` rule has something
to fire on.

```mermaid
sequenceDiagram
    autonumber
    participant EB as EventBridge
    participant RN as alerts/runner
    participant RB as rbac/resolve
    participant EV as alerts/evaluate
    participant Q as query/scoped
    participant PG as PostgreSQL
    participant SES as SES

    EB->>RN: scheduled
    RN->>PG: SELECT enabled alert_rules + last fired
    loop per rule
        alt not due yet
            RN->>RN: skip
        else due
            RN->>RB: can the OWNER still see this scope?
            alt grant lapsed
                RN->>PG: INSERT alert_events, lapse notice,<br/>NO cost figures
                Note over RN: never evaluated,<br/>never delivered
            else permitted
                RN->>EV: evaluate(rule)
                EV->>Q: data for the rule scope, AS THE OWNER
                Q-->>EV: rows, already grant-filtered
                EV-->>RN: an Event, or None
                opt fired
                    RN->>PG: INSERT alert_events
                    RN->>SES: send
                    SES-->>RN: Delivery, success or failure
                    RN->>PG: UPDATE delivered_at or delivery_error
                end
            end
        end
    end
```

### The re-check that is easy to miss

A rule can outlive the grant that justified it. Somebody is granted an
account for two weeks, creates an alert, the grant expires — and the rule
would keep emailing them about an account they can no longer open.

So grants are re-evaluated **before the rule is even evaluated** (FR-34),
not trusted from the rule's stored scope. Checking at *send* time was the
original design and it was wrong in a subtle way: rules evaluate as their
owner through `query/scoped`, so a lapsed grant already yields no data and
therefore no alert — safe, but **silent**. The owner simply stops hearing
anything and concludes spend is fine.

The check therefore runs first, and records a notice carrying **no cost
figures**: the signal survives without leaking amounts into a feed its
owner is no longer entitled to read. Throttled to once a day.

### Rule types

| Type | Condition |
|---|---|
| `threshold` | the metric over the window crosses a value. The window is N **settled** days ending yesterday — anchoring on today summed an always-empty day |
| `forecast` | a linear run-rate projects to cross before the period ends |
| `digest` | an unconditional periodic summary |
| `anomaly` | a new `anomaly_findings` row in scope |

`ses.py` never raises; it returns a failed `Delivery`, which is recorded as
`delivery_error` on the event. In-app delivery is a row in `alert_events`
the UI reads — more demonstrable than email, and it works with no SES
recipient verification.

---

## 6. End-to-end latency

Worth stating plainly, since the UI must never imply real-time (NFR-10):

| Stage | Lag |
|---|---|
| AWS publishes cost data | 8-24 h |
| Monthly finalisation | up to about a month |
| Our ingest schedule | daily, 06:00 UTC |
| **Total worst case** | **~48 h** |

Every view therefore shows an as-of timestamp, drawn from
`MAX(ingest_runs.finished_at) WHERE status = 'success'` (FR-25). The
sidebar says "data as of …", never "live".

Two places treat recency as untrustworthy on purpose, for the same reason
and with different numbers:

| Consumer | How much it drops | Why |
|---|---|---|
| the anomaly detector | the last **2** points of each series | scoring unfinalised days produces an anomaly every morning |
| `GET /insights` default window | ends **3 days** ago, `insights/coverage.last_final_day()` | a window ending on an unfinalised day reads as a fall that is only missing data |

Until an ingest completes, live mode says "no data ingested yet" and every
cost screen shows an empty state. That is the correct result, not a
failure.
