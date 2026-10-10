# Data flows

Five flows: ingest, scoped read, access change, anomaly detection, alerting.

---

## 1. Ingest

Runs on a schedule, once per enabled connection.

```mermaid
sequenceDiagram
    participant EB as EventBridge
    participant R as ingest/runner
    participant SM as Secrets Manager
    participant STS as STS
    participant CE as Cost Explorer API
    participant PG as PostgreSQL

    EB->>R: daily trigger
    R->>PG: SELECT enabled cloud_connections
    loop per connection
        R->>PG: INSERT ingest_runs (status=running)
        alt assume_role
            R->>STS: AssumeRole(role_arn, external_id)
            STS-->>R: temporary credentials
        else local_profile
            R->>SM: get credentials
        end
        R->>CE: GetCostAndUsage(DAILY, groupBy SERVICE)
        CE-->>R: rows
        R->>PG: UPSERT fact_cost_daily ON CONFLICT DO UPDATE
        R->>PG: UPSERT dim_account, dim_service
        R->>PG: UPDATE ingest_runs (success, rows_written)
    end
```

### Why it looks like this

- **One run row per connection per period**, written *before* fetching, so a
  crash leaves a `running` row that is visibly stuck rather than silently absent.
- **A failed account does not abort the others** (FR-17). The loop catches per
  connection and records `failed` with the error.
- **Re-fetch window.** Each run re-fetches the trailing ~7 days, not just
  yesterday, because cost data is restated as it finalises. The natural-key
  upsert makes that safe and idempotent (FR-15).
- **Credentials never persist.** `AssumeRole` returns short-lived credentials
  used for that call only.

### Granularity note

Cost Explorer supports `DAILY` and `MONTHLY`. We fetch `DAILY` and aggregate
upward in SQL (`date_trunc`), so week/month/quarter/year views come from one
ingest path rather than four.

---

## 2. Scoped read — the authorization path

Every chart in the product goes through this.

```mermaid
sequenceDiagram
    participant FE as Frontend
    participant API as api (Lambda)
    participant COG as Cognito JWKS
    participant Q as query/scoped
    participant PG as PostgreSQL

    FE->>API: GET /cost/series?account=...&grain=month<br/>Bearer JWT
    API->>COG: verify signature, issuer, audience, expiry
    COG-->>API: valid
    API->>PG: SELECT id, email, role FROM users WHERE email=claim
    PG-->>API: user row
    API->>Q: series(Principal, Filters, grain)
    Note over Q: builds WHERE and<br/>ALWAYS injects GRANT_PREDICATE
    Q->>PG: SELECT ... FROM fact_cost_daily f WHERE ... AND EXISTS(grants)
    PG-->>Q: only permitted rows
    Q-->>API: rows
    API-->>FE: JSON + as-of timestamp + metric name
```

### The two rules

1. **`Principal` is built from the verified token**, never from a request body
   or query parameter. A `user_id` in a request is ignored.
2. **The grant predicate is applied in SQL**, so unauthorized rows never leave
   the database. Filtering in the API — or worse, the frontend — would mean
   fetching data the user may not see.

### Fail-closed

No grants → the `EXISTS` subquery matches nothing → zero rows. Not an error,
not everything. This is the first test in the suite.

### Superadmin

Replaces the predicate with `TRUE` and the bypass is recorded in `audit_log`
(FR-38). An unlogged bypass is indistinguishable from a leak.

---

## 3. Access change

```mermaid
sequenceDiagram
    participant SA as Superadmin
    participant API as api
    participant AD as rbac/admin
    participant PG as PostgreSQL

    SA->>API: POST /admin/grants {email, account, service?, valid_until?}
    API->>AD: grant(actor, actor_role, GrantRequest)
    AD->>AD: require superadmin
    AD->>AD: normalize_email + domain check
    rect rgb(240,240,240)
    note right of AD: ONE transaction
    AD->>PG: SELECT user by email
    AD->>PG: INSERT access_grants
    AD->>PG: INSERT audit_log (grant.create, after={...})
    end
    PG-->>AD: commit
    AD-->>API: grant_id
```

The shaded region matters: the grant and its audit entry commit together
(FR-37). Revocation is the same shape — `UPDATE ... SET revoked_at` plus an
audit row, and it is idempotent (revoking twice is a no-op).

**Effect is immediate.** Nothing is cached, and the predicate evaluates
`now()` per query, so the next page load reflects the change.

---

## 4. Anomaly detection

```mermaid
flowchart TD
    A["EventBridge daily"] --> B["for each account x service"]
    B --> C["query/scoped: fetch daily series<br/>(system principal)"]
    C --> D["drop most recent 1-2 days<br/>(unfinalised = false positives)"]
    D --> E["rolling median + MAD"]
    E --> F{"sustained shift?"}
    F -->|"yes, persists"| G["kind = step"]
    F -->|"single point"| H["kind = spike"]
    F -->|"gradual trend"| I["kind = creep"]
    G --> J["UPSERT anomaly_findings<br/>baseline, observed, delta_abs, delta_pct"]
    H --> J
    I --> J
    J --> K["alerts: rules of type 'anomaly'"]
```

### Three decisions

**Per account × service, never the total** (FR-26). Aggregates average
anomalies away — a doubling of one small service disappears in the sum.

**Step changes, not spikes** (FR-27). Cloud cost anomalies are overwhelmingly
"something was switched on and stayed on". A spike detector on cost data
mostly surfaces billing artefacts and trains people to ignore alerts.

**Median + MAD, not mean + stddev.** Robust to the outliers we are looking
for, and explainable — we can state exactly why a point flagged, which
matters when the output is "you may be wasting money".

Findings always carry baseline and observed values (FR-30): the explanation,
not just the flag.

---

## 5. Alerting

```mermaid
sequenceDiagram
    participant EB as EventBridge
    participant EV as alerts/evaluate
    participant Q as query/scoped
    participant RB as rbac/resolve
    participant PG as PostgreSQL
    participant SNS as SNS
    participant SES as SES

    EB->>EV: scheduled
    EV->>PG: SELECT enabled alert_rules
    loop per rule
        EV->>Q: data for rule scope
        Q-->>EV: rows
        EV->>EV: threshold / forecast / digest / anomaly
        alt condition met
            EV->>PG: INSERT alert_events
            EV->>RB: does owner STILL have a grant for this scope?
            alt grant valid
                EV->>SNS: publish
                SNS->>SES: email
                EV->>PG: UPDATE alert_events SET delivered_at
            else grant revoked or expired
                EV->>PG: UPDATE alert_events SET delivery_error='scope no longer permitted'
            end
        end
    end
```

### The re-check that is easy to miss

A rule can outlive the grant that justified it. Somebody is granted an
account for two weeks, creates an alert, the grant expires — and the rule
would keep emailing them about an account they can no longer open.

So **grants are re-evaluated at send time** (FR-34), not trusted from the
rule's stored scope. The event is still recorded, with a delivery error
explaining why it was suppressed.

### Rule types

| Type | Condition |
|---|---|
| `threshold` | metric over window crosses a value |
| `forecast` | linear run-rate projects to cross before period end |
| `digest` | unconditional periodic summary |
| `anomaly` | a new `anomaly_findings` row in scope |

In-app delivery is a row in `alert_events` the UI polls — more demo-able than
email, and it works with no SES verification.

---

## 6. End-to-end latency

Worth stating plainly, since the UI must not imply real-time (NFR-10):

| Stage | Lag |
|---|---|
| AWS publishes cost data | 8–24 h |
| Monthly finalisation | up to ~a month |
| Our ingest schedule | daily |
| **Total worst case** | **~48 h** |

Every view therefore shows an as-of timestamp drawn from
`MAX(ingest_runs.finished_at)` (FR-25).
