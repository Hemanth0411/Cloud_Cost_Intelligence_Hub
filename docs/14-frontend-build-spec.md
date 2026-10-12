# Frontend build spec

A buildable specification: how many pages, what each one needs, where its
data comes from, and which states it must handle.

**What this document fixes:** structure, data, behaviour, states.
**What it deliberately leaves open:** colour, typography, spacing, layout
polish, iconography, motion. Those are design decisions, not spec.

Component props and the API envelope are in
[06-frontend.md](06-frontend.md). Endpoint reference is live at
`http://127.0.0.1:8099/docs` (Swagger).

---

## Setup

```bash
npm create vite@latest frontend -- --template react-ts
cd frontend && npm i @tanstack/react-query react-router-dom recharts \
  react-hook-form zod date-fns
```

`.env.development`

```ini
VITE_API_BASE_URL=http://127.0.0.1:8099
VITE_DEV_USER=hemanth.reddy@chryselys.com
VITE_USE_MOCK=false
```

### Auth during development

Cognito does not exist yet. The API accepts a header instead:

```
X-Dev-User: someone@chryselys.com
```

Put it in the shared fetch wrapper. When Cognito lands, that one wrapper
swaps to `Authorization: Bearer <jwt>` and nothing else changes.

Three users already exist to develop against:

| Email | Sees |
|---|---|
| `hemanth.reddy@chryselys.com` | superadmin — 2 accounts, 7 services |
| `analyst@chryselys.com` | 1 account, **only AWSGlue** |
| `nobody@chryselys.com` | nothing — for the empty state |

Switching between them must visibly change the whole UI. That is the
feature, not a side effect.

---

## Page inventory — 9 pages

| # | Route | Page | Access |
|---|---|---|---|
| 1 | `/login` | Sign in | public |
| 2 | `/` | Dashboard | any user |
| 3 | `/explore` | Explorer | any user |
| 4 | `/compare` | Comparison | any user |
| 5 | `/anomalies` | Anomalies | any user |
| 6 | `/alerts` | Alerts | any user |
| 7 | `/admin/users` | Users & grants | superadmin |
| 8 | `/admin/connections` | Cloud accounts | superadmin |
| 9 | `/admin/audit` | Audit log | superadmin |

Admin pages are **hidden** from non-superadmins, not merely disabled. The
API returns 403 regardless, so the UI is convenience, not security.

---

## 1. `/login`

One email field, one code field. **No password field, no register link, no
forgot-password link** — none of those exist in this system.

| Step | UI |
|---|---|
| 1 | Email input → "Send code" |
| 2 | 6-digit code input → "Sign in" |
| 3 | Redirect to `/` |

During development: a user picker (the three emails above) instead of the
code step. Label it clearly as a dev affordance.

States: idle, sending, code-sent, verifying, error (invalid code, expired
code, unknown user).

---

## 2. `/` Dashboard

**Purpose:** what happened, at a glance.

| Block | Data |
|---|---|
| 4 KPI tiles | `/cost/series` for this month and last month |
| Trend chart (daily, 30d) | `/cost/series?grain=day` |
| Top 5 services | `/cost/breakdown?dimension=service&limit=5` |
| Open anomalies count + 3 most recent | `/anomalies?status=new&limit=3` |
| Unread alerts count | `/alerts/feed?unread_only=true` |

KPI tiles: **This month**, **vs last month** (absolute *and* percent),
**Accounts visible**, **Open anomalies**.

Must show `as_of` and the metric name somewhere on the page.

---

## 3. `/explore` Explorer

**Purpose:** slice the data.

Controls, left to right:

1. Provider select — from `/meta/accounts` (distinct providers)
2. Account select — from `/meta/accounts`
3. Service select — from `/meta/services?provider=&account_id=`, **disabled
   until an account is chosen**
4. Date range picker
5. Time grain: day / week / month / quarter / year
6. Metric: effective / billed
7. "Include tax & credits" toggle (default off)

Below: a time-series chart, then a breakdown table with a dimension
selector (provider / account / service / region / charge category).

**Cascading rule:** changing provider resets account and service; changing
account resets service.

```
GET /cost/series?start&end&grain&provider&account_id&service&metric&include_tax_and_credits
GET /cost/breakdown?start&end&dimension&...same filters...&limit
```

---

## 4. `/compare` Comparison

**Purpose:** what changed.

One page, one dimension selector — not three separate screens.

| Mode | How |
|---|---|
| Period vs period | two date ranges, same filters |
| Account vs account | `dimension=account`, one period |
| Service vs service | `dimension=service`, one period, scoped to one account |

```
GET /cost/compare?current_start&current_end&dimension
                 [&previous_start&previous_end]
```

Omit the previous window and the API defaults to the immediately preceding
window of equal length.

Table columns: **key, current, previous, Δ absolute, Δ percent**. Sorted by
absolute delta descending — biggest mover first, regardless of sign.

Three required behaviours:

- **Show both deltas.** `$2 → $6` is `+200%` and `+$4`; only one of those
  is worth acting on.
- **`delta_pct` is `null` when previous was zero.** Render "new", not
  `Infinity` or `NaN`.
- **If `partial_period` is true, badge it.** Otherwise a month-to-date
  against a full month reads as a 40–60% drop and the page looks broken.

---

## 5. `/anomalies`

**Purpose:** what looks wrong, and why.

```
GET  /anomalies?status=new|acknowledged|dismissed&limit
POST /anomalies/{id}/ack?status=acknowledged|dismissed
```

Each card shows: account, service, date, **kind** (`step` / `spike` /
`creep`), baseline vs observed, Δ absolute, Δ percent, and Acknowledge /
Dismiss actions.

A tiny sparkline of the surrounding period helps a lot here — it comes from
`/cost/series` filtered to that account and service.

Kind matters and should be visually distinct: `step` is something switched
on and left on (the common, expensive case), `spike` is one bad day,
`creep` is a slow drift.

Note: detection is not implemented yet, so this page will be empty until it
is. Build it against the shape, and use showcase fixtures to lay it out.

---

## 6. `/alerts`

Two halves.

**Rule builder** (`GET`/`POST`/`DELETE /alerts/rules`)

| Field | Options |
|---|---|
| name | text |
| type | `threshold` / `forecast` / `digest` / `anomaly` |
| scope | provider, account, service — each optional, null = all |
| metric | effective / billed |
| comparator + threshold | `gt` / `gte` / `lt` / `lte` + number (threshold & forecast only) |
| window_days | 1–365 |
| frequency | immediate / daily / weekly / monthly |
| channels | inapp, email |

Comparator and threshold only apply to `threshold` and `forecast`. Hide
them for `digest` and `anomaly`.

**Feed** (`GET /alerts/feed`, `POST /alerts/feed/{id}/read`)

Rule name, fired-at, observed vs expected, read/unread. A `delivery_error`
means the alert fired but was **not** sent — most often because the
recipient's grant had expired. Show that, don't hide it.

---

## 7. `/admin/users`

```
GET  /admin/users
POST /admin/users              {email, display_name}
GET  /admin/grants?email=
POST /admin/grants             {email, provider, account_id, service_name?, valid_until?, reason?}
DELETE /admin/grants/{id}?reason=
```

Users table: email, role, status, created. Invite = one email field.

Grants table: user, provider, account, service (or "all services"),
valid-from, valid-until (or "indefinite"), **is_active**, granted-by,
reason.

Four rules:

- Account options come from `/meta/accounts`, never free text — a typo
  creates a grant that silently matches nothing.
- Service blank means **all services** in that account. Say so in the UI.
- Expired and revoked grants stay listed, visibly struck through. "Why
  could X see this in March" is a real question with a real answer.
- Revoke asks for a reason and takes effect on the next request.

---

## 8. `/admin/connections`

```
GET  /admin/connections
POST /admin/connections
POST /admin/connections/{id}/enabled?value=true|false
GET  /admin/ingest-runs
```

Fields: provider, account id (`self` = the deploy account), display name,
credential mode, role ARN, external id, enabled.

**There is no secret field, and there must never be one.** Access works by
cross-account role assumption; the form collects a role ARN and an external
id. If a design has a password or key input here, the design is wrong.

Show `last_ingest_at` / `last_ingest_status` per connection, and surface
failures from `/admin/ingest-runs` — a silent ingest failure looks exactly
like "costs went to zero".

---

## 9. `/admin/audit`

```
GET /admin/audit?entity_type=&limit=
```

Append-only. Columns: when, actor, action, entity, before → after diff.
`before` and `after` are JSON; render as a readable diff, not raw JSON.

### Money on the wire

Amounts are `Decimal` in Python and arrive as **JSON numbers**, because
FastAPI's encoder converts `Decimal` through `float`. So:

```json
{ "usage_date": "2026-03-01", "cost": 123.45 }
```

Read them as numbers — no parsing needed. Two consequences worth knowing:

- **Do not re-sum a long series client-side and expect the total to match
  a KPI tile.** Every total the API reports is summed in SQL over exact
  numerics; adding hundreds of floats in JS accumulates a different
  error. If you need a total, ask for it.
- **Format for display, do not round for storage.** Use
  `Intl.NumberFormat` with `style: "currency"`. All accounts are USD
  (`currency` is on every row anyway — read it rather than hardcoding
  `$`, so a non-USD account later shows up as wrong-looking rather than
  silently mislabelled).

`delta_pct` is `null`, not `0` or `Infinity`, when a baseline is zero.
Render that as "new" or "—", never "0%".

Actions seen so far: `user.invite`, `grant.create`, `grant.revoke`,
`connection.create`, `connection.update`, `connection.enable`,
`connection.disable`.

---

## Showcase fixtures (the mock toggle)

Two real accounts prove the pipeline but cannot show what many accounts
across two clouds look like. Fixtures fill that gap — **frontend only**.

```
src/fixtures/showcase/   series.json, breakdown.json, compare.json,
                         accounts.json, anomalies.json, feed.json
```

```ts
const data = USE_MOCK ? mockSeries : await api.get('/cost/series', params)
```

Six requirements:

1. Off by default.
2. Fixtures match the API envelope **exactly** — same keys, same shapes.
3. An unmissable banner while active.
4. Removable: delete the directory and the flag; the app works identically.
5. Cover multiple providers (`aws`, `azure`) and 5–8 accounts — that is the
   whole point.
6. **Never used to demonstrate access control.** RBAC is shown on real data
   with real grants. Fixtures show layout and scale only.

---

## States every data view must handle

| State | Requirement |
|---|---|
| Loading | skeleton, not a spinner over stale numbers |
| Empty — no grants | "No accounts have been shared with you yet." Never an error, never all data. |
| Empty — grants but no data in range | "No cost recorded for this period." Different message from the above. |
| Error 401 | redirect to `/login` |
| Error 403 | "You do not have access to this." |
| Error 5xx | retry affordance |
| Partial period | badge on the affected period |

The two empty states are different situations and must read differently.
Conflating them makes a permissions problem look like a data problem.

---

## Non-negotiables

1. **Never fetch an unscoped list.** All options come from `/meta/*`.
2. **Never filter for authorization in the browser.** The API returns only
   permitted rows; the UI must not add or remove rows for access reasons.
3. **Every chart states its metric and `as_of`.** `effective_cost` and
   `billed_cost` give different numbers.
4. **Both deltas, always.**
5. **Label partial periods.**
6. **No credential input anywhere.**
7. `localStorage` holds UI preferences only — never cost data, never
   permissions.

---

## Suggested build order

1. Fetch wrapper with the `X-Dev-User` header + React Query setup
2. `FilterBar` with cascading scoped selects ← unblocks everything
3. `/explore` — chart + breakdown table
4. `/` Dashboard — reuses the above
5. `/compare`
6. `/admin/users` + `/admin/connections`
7. `/anomalies`, `/alerts`
8. `/login`
9. Showcase fixtures + toggle

Step 2 first: it is the demo's proof of access control, and every other
page depends on it.
