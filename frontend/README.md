# CloudLens: Cloud Cost Intelligence Platform

AI-powered multi-cloud (AWS / Azure / GCP) cost visibility, anomaly detection and optimization.
**Hackathon prototype. Runs entirely on a deterministic mock dataset; no cloud, backend or AI APIs.**

## Run it

```bash
npm install
npm run dev            # http://localhost:3000
npm run verify:data    # ~3,900 logic checks, no build or network needed
npm run typecheck
```

## Demo credentials

| | |
|---|---|
| **Email** | `admin@cloudlens.demo` |
| **Password** | `CloudLens!2026` |

These are public, built-in demo credentials, shown on the sign-in page with a one-click "Use demo credentials" button.
You can also **register your own demo account** (`/register`).

### How authentication works (all simulated, no backend)
- Everything runs in your browser. There is no server, database or email service.
- **No password is ever stored.** Registering saves only a profile (name, email, role) in `localStorage`. A registered
  account signs in with *any* password that meets the policy (8+ characters with a letter and a number), because there
  is nothing stored to compare against. The built-in admin account is checked against the documented credentials above.
- **Forgot / reset password:** requesting a reset creates a random single-use token (15 minute expiry) and shows the link
  in a clearly labelled **"Simulated inbox: no email was sent"** panel. The reset page validates the token and the new
  password, consumes the token, and discards the password. The response is the same for unknown emails, so it does not
  reveal which addresses have accounts.
- **Protected navigation:** middleware sends visitors without the demo session cookie to `/login?next=...`; signed-in
  users are redirected away from the guest-only pages. The cookie is a demo marker, not a security boundary.
- Forms validate inline (accessible errors), show loading states, and sign out from the user menu.

## Stack

Next.js 15 (App Router) · React 19 · TypeScript (strict, no `any`) · Tailwind CSS 3 ·
shadcn/ui-style primitives (`components.json` is configured, so `npx shadcn add ...` works) ·
Recharts · lucide-react · next-themes · zod.

## Architecture

```
types/            domain.ts (fact + dimension models), analytics.ts (view models)
lib/mock/         seeded PRNG, catalog (providers/accounts/services), cost generator, dataset (Jan 2024 - Oct 2026, 52k rows)
lib/selectors/    PURE functions: scope, range, dashboard KPIs/trend/breakdowns, anomaly detection
lib/services/     async facade the UI talks to (swap for real APIs later)
hooks/            useDashboardData
components/       ui/ (button, card, badge, table, select, dialog, dropdown-menu, ...)
                  layout/ filters/ charts/ dashboard/ auth/ shared/
app/              (auth)/login   (app)/dashboard + route stubs for later phases
```

**Single source of truth:** only `DailyCost` rows are generated. Every KPI, chart, table, forecast,
budget figure and anomaly is *derived* from them, so numbers can never disagree across views.
`npm run verify:data` asserts this (about 3,900 checks: ranges x providers x accounts x services, every granularity, the anomaly engine and its config, filters, workflow rules, insight determinism and text quality, optimization estimates, CSV output, simulated auth, comparison reconciliation, and the alert engine).

Filters (range, provider, account) live in the URL, so views are shareable and back/forward works.

## Modules and routes

| Route | Module |
|---|---|
| `/login` `/register` `/forgot-password` `/reset-password` | Authentication (simulated) |
| `/dashboard` | KPIs, charts, savings, anomalies, AI summary |
| `/providers` | Provider cards: spend, health, anomalies, last sync |
| `/accounts` | Cloud accounts with simulated connect / disconnect / sync |
| `/services` | Services table with category filter, search and sorting |
| `/compare` | Current vs previous / year-ago; providers, accounts, services; head to head |
| `/anomalies` | Rule-based anomaly detection and workflow |
| `/insights` | AI insights (deterministic templates) and optimization estimates |
| `/alerts` | Alerts, read/unread, acknowledge/resolve, notification preferences |
| `/settings` | Profile, notification preferences, reset demo data |

## Cloud accounts (`/accounts`)
Every AWS, Azure and GCP account with environment, **connection status**, period spend (with change vs previous) and
**last synchronization** (relative and absolute UTC time). **Sync** runs a short simulated sync (a delayed GCP account
becomes healthy). **Disconnect** asks for confirmation, stops "syncing" and raises a high-severity alert. **Connect** opens
a provider-specific wizard (IAM role ARN / tenant + subscription / project ID) that validates the *format* only and then
steps through simulated validation. Nothing calls a cloud API and no credentials are stored. State persists locally and
flows into the dashboard's *Connected accounts* KPI, provider health, and alerts.

## Cost comparison (`/compare`)
Compare against the **previous period** (identical to the dashboard's "vs previous") or the **same period last year**,
broken down by **provider, account or service**: absolute and percentage difference, share of spend, and each entity's
share of the *total change*. Includes a daily overlay chart, grouped bars, a sortable table, and a **head-to-head** view
of any two entities. It uses the same filters and the same scoped rows as the dashboard; tests assert that totals and
every provider/account/service figure match the dashboard.

## Alerts and notifications (`/alerts`)
- Alerts are **derived** from anomalies (shared workflow, so acknowledging an alert acknowledges the anomaly), budget risk
  and connection health, with detection timestamps in UTC.
- **Read / unread**, **acknowledge**, **resolve**, **reopen**; unread counts appear on the header bell and the sidebar.
- **Preferences:** channels (in-app, email and Slack are *simulated*), categories, and a minimum severity. Alerts hidden by
  preferences are counted and not treated as unread.
- **Simulation only:** "Simulate incoming alert" and "Send test notification" add clearly labelled demo events. The UI
  never claims an email or message was sent; the delivery log says "simulated".

## Dashboard contents

- **8 KPI cards:** total spend (with % change), previous-period spend and change, month forecast, budget utilization,
  connected accounts, services in use, detected anomalies, potential savings.
- **Spending over time:** daily, weekly, monthly and yearly (Recharts area / stacked bars), provider toggles, anomaly markers.
- **Current vs previous period:** overlaid daily lines plus summary tiles.
- **Spend breakdown:** by provider (donut), account and service (ranked bars). **Top expensive services** table.
- **Savings opportunities**, **recent anomalies** (with workflow), and an **accounts table** with budget burn.
- **Filters:** date range (7D / 30D / 90D / MTD / YTD / 12M / custom), provider, account, service. Dependent filters
  stay consistent (an Azure service cannot stay selected under AWS). Everything lives in the URL.

## Intelligence features

### Anomaly detection (`/anomalies`)
- **Four rules** run on every account and service: *spike*, *unexpected drop*, *sustained increase*, *sustained decrease*.
  Each day is compared with comparable days (weekday vs weekday, weekend vs weekend) using medians, so a dev account's
  normal weekend dip is never reported as a decrease, and earlier incidents do not distort the baseline.
- **Configurable thresholds** (Detection settings dialog): sensitivity presets (conservative / balanced / sensitive) or
  custom values for every threshold, including severity cut-offs. Settings are validated, persisted locally, and re-run
  detection over the full history. A preview shows how many anomalies a configuration would find before applying it.
- **Each anomaly shows** severity, type, provider, account, service, observed cost, expected cost, absolute difference,
  percentage change and detection date.
- **Filters:** severity, status, type, plus the global date / provider / account / service filters.
- **Workflow:** investigate, acknowledge, resolve, dismiss or reopen from the table menu or the investigation dialog,
  with notes. Status changes update the dashboard KPIs, savings estimates and insights immediately.
- **Investigation dialog:** cost curve around the detection date with the expected level, account-level contribution,
  billed-usage comparison, neighbouring anomalies, suggested checks and actions.

### AI insights (`/insights`)
- Explanations are **deterministic templates** filled with numbers calculated from the dataset. No AI model is called, and the
  UI says so. Nothing asserts a root cause the data cannot show: possible causes are phrased as "things to check".
- Each insight explains **what changed**, **which account and service contributed** (with how concentrated the change is in
  time), **what to investigate next**, and **recommended actions**, with the supporting figures listed.
- Insight types: change vs previous period, anomalies, budget risk, growth trends and year-over-year, spend concentration,
  and an optimization roll-up.
- **Refresh insights** re-runs a staged analysis (visible progress), re-generates the report from the current filters and
  workflow state, types out the new summary, and reports what changed since the last run.

### Optimization opportunities
- Seven rule-based ideas (non-prod scheduling, production database commitments, compute sizing, storage tiering, ML dev
  capacity, data transfer, and preventing repeat anomalies).
- **Every figure is labelled an estimate** and shown as a range with a mid-point. Each card states the assumption it rests
  on, the data evidence that supports it (for example weekend-vs-weekday spend, day-to-day stability), what the dataset
  cannot tell us (for example missing utilization metrics), and a confidence level that reflects that.

## Calculation reference (all in `lib/selectors/` and `lib/insights/`)

| Figure | Definition |
|---|---|
| Previous period | The equal-length window immediately before the selected range. Shown as n/a if the data does not reach back far enough. |
| Forecast | Month-to-date + trailing 7-day average x days left in the month. |
| Budget utilization | Forecast / sum of monthly budgets of the accounts in scope. Not shown when a single service is selected. |
| Weekly / monthly / yearly | Fixed windows (26 weeks, 12 months, all years), independent of the date range. Incomplete periods are flagged. |
| Spike / drop | Day cost vs the median of the same kind of day (weekday/weekend) over the trailing baseline (28 days): flagged when beyond both a % threshold and N robust sigmas (MAD), and above a minimum $/day. |
| Sustained increase / decrease | 7-day median vs the median of the prior baseline window; flagged when the % and $/day thresholds are exceeded. Onset spikes are folded into the finding; repeats are suppressed for 3 weeks. |
| Severity | Critical / high / medium / low from either the % change or the $ impact inside the detection window. |
| Potential savings (estimate) | Matching spend x a stated low / mid / high saving %, normalised to 30 days. Unresolved anomaly increases add a "prevent repeat spikes" item, so resolving one changes the total. |

## What to try in the demo

- Switch range / provider / account / service and watch every widget (and the URL) update. Try **Custom** dates.
- Flip the spending chart between **Daily / Weekly / Monthly / Yearly**; hide a provider from the legend.
- Open **Anomalies**: filter by severity / status / type, sort, page, then click a row to investigate. Try *Start investigating*, add a note, *Mark resolved*, and watch the dashboard KPIs and savings estimate change.
- Open **Detection settings**, switch to *Sensitive*, press *Preview results*, then *Apply*, and see every page re-evaluate.
- Open **AI insights**, press **Refresh insights**, expand a card, and follow its *Related* chips back to a filtered dashboard.
- Click an **account row** for budget burn, projection, owner and region.
- **Export** the current view to CSV (daily trend, accounts, anomalies).
- Toggle providers in the trend chart legend; sort the accounts table; switch theme; collapse the sidebar.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Foundation: theme, shell, sidebar, header, mock auth | done |
| 2 | Data layer: types, generators, selectors, service facade | done |
| 3 | Dashboard: filters, KPIs, trend, provider/service charts, accounts table, anomalies | done |
| 3b | Full dashboard: 8 KPIs, 4 granularities, comparison, breakdowns, savings, service + custom-date filters | done |
| 6-7 | Anomaly detection engine + workflow, AI insights, optimization opportunities | done |
| 4-5 | Authentication, cloud accounts, comparison, alerts and notifications, providers and services pages | done |
| 9 | Final polish: error/404 pages, failure handling, a11y, responsive QA, honest labelling | done |


## Demo script (5 minutes)

1. **Sign in** with the demo credentials (or register). Note the "Demo data" chip and the sidebar's "no live cloud APIs".
2. **Dashboard:** try 90D, then *Custom* dates; filter by provider, account and service; flip the trend chart between
   Daily / Weekly / Monthly / Yearly; open the Export menu.
3. **Anomalies:** filter by severity, open a row, *Start investigating*, add a note, *Mark resolved*; the dashboard KPI and
   savings estimate update. In *Detection settings* choose *Sensitive*, *Preview results*, *Apply*.
4. **AI insights:** press *Refresh insights*, expand a card, follow a *Related* chip to a pre-filtered dashboard. Every
   savings figure is an estimate with its assumption shown.
5. **Accounts:** *Sync* a delayed GCP account, *Disconnect* one (confirm), then *Connect* it again with example values.
6. **Compare:** switch to "Same period last year", break down by account, use *Head to head*.
7. **Alerts:** mark read, acknowledge, *Simulate incoming alert*, change notification preferences, then *Sign out*.

## What is simulated (nothing here is real)

- **Cloud connections, syncs and account data** are mock; no AWS, Azure or GCP API is ever called.
- **"AI" insights** are deterministic templates filled with numbers from the mock data; no model is called.
- **Email and Slack notifications** are never sent. They are shown as "(simulated)" and the delivery log says so.
- **Authentication** is browser-only; no password is stored anywhere.

## Quality checks

- `npm run typecheck` and `npm run build` (strict TypeScript; ESLint is configured with `no-explicit-any` as an error).
- `npm run verify:data`: about 3,900 logic checks.
- The UI was additionally exercised end to end in Chromium (auth, filters, workflows, keyboard and focus, failure paths,
  cross-page numeric reconciliation, and a page x filter smoke matrix) and checked for horizontal overflow at 360-1024px.
  That harness stubbed Next.js routing, Recharts and lucide, so run a real `npm run build` and click through once.
