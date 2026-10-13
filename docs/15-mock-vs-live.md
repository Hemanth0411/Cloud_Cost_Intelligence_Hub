# Switching between mock data and the live API

The app runs in one of two modes. This page is how you change which.

| | Mock | Live |
|---|---|---|
| Cost figures | generated in the browser | `GET /cost/*` |
| Sign-in | a password checked against `localStorage` | Amazon Cognito, real OIDC token |
| Budgets, savings, AI insights, connection health | shown | **not shown** — nothing stores them |
| What the sidebar says | `Mock dataset · no live cloud APIs` | `Live API · data as of …` |

Mock exists to show what the product looks like in use. It never shows a
capability that cannot be real: anything the API has no column for is
dropped or dashed in live mode rather than filled with a zero.

---

## 1. The in-app toggle — use this in a demo

**Settings → Data source → "Use mock data".**

The page reloads and the whole app switches. That is the entire
interaction.

- It applies to **your browser only**. Flipping it on a shared deployment
  does not change what anyone else sees.
- It **overrides the build**, so you can run the deployed live build on
  mock data without redeploying anything.
- It survives "Reset browser state" on the same page — that button
  deliberately leaves your data-source choice alone.
- To go back to whatever the build was compiled with, press
  **"Follow the build default again"**.

**If the toggle is held on mock and will not move**, the build has no API
URL, Cognito client id or Cognito domain. The card names which one is
missing. A live mode that cannot reach anything is worse than the mock it
replaces, so the switch refuses rather than producing a screen of failed
requests.

**Switching to live signs you out.** Live mode needs a real Cognito token
and a mock session is not one, so you land on the Cognito sign-in page.
That is correct, not a bug — but it means you cannot flip to live
mid-presentation without signing in, so decide before you start.

### If the app will not load at all

Add `?mock=1` to any URL:

```
http://localhost:3000/login?mock=1
https://<your-amplify-domain>/login?mock=1
```

That writes the override and sticks, so you only need it once. `?mock=0`
does the reverse.

This exists because switching to live without a Cognito session is
otherwise a one-way door: the API answers 401, the app sends you to
sign-in, and sign-in redirects to Cognito. If Cognito is unreachable —
the exact situation the toggle is for — every route bounces and the
switch on /settings is behind the bounce.

Under the hood this is one `localStorage` key, `costhub:use-mock`,
holding `"true"` or `"false"`. To set it from the console:

```js
localStorage.setItem('costhub:use-mock', 'true');  // mock
localStorage.setItem('costhub:use-mock', 'false'); // live
localStorage.removeItem('costhub:use-mock');       // follow the build
location.reload();
```

---

## 2. Locally — change the build default

`NEXT_PUBLIC_*` is compiled into the bundle, so this needs a restart.

```bash
cd frontend

# live (also refreshes the API URL and Cognito ids from terraform)
export AWS_PROFILE=costhub
./../do.sh outputs dev          # writes frontend/.env.local
npx next dev -p 3000

# mock, without touching .env.local
NEXT_PUBLIC_USE_MOCK=true npx next dev -p 3000
```

Port **3000** matters: it is the only `localhost` callback URL registered
with Cognito, so live sign-in on 3001 fails with `redirect_mismatch`.

To change the default permanently, edit `NEXT_PUBLIC_USE_MOCK` in
`frontend/.env.local` — but note that `./do.sh outputs dev` rewrites that
file, so the change does not survive the next run.

---

## 3. On Amplify — change the build default for everyone

The variables are set in the **Amplify console**, not in terraform:
putting them in `aws_amplify_app.environment_variables` closes a
dependency cycle (Amplify's domain is already an input to the Cognito
callback URLs), and terraform refuses the plan.

1. Amplify console → the app → **Hosting → Environment variables**.
2. Set `NEXT_PUBLIC_USE_MOCK` to `false` (live) or `true` (mock).
3. **Redeploy.** `Deployments → Redeploy this version`, or push to `dev`.
   The value is inlined at build time, so an existing deployment does not
   pick it up.

A `terraform apply` has wiped these before. If a deployment comes up on
mock data unexpectedly, check them first — and open the browser console,
where the app logs exactly which value it could not find:

```
[costhub] NEXT_PUBLIC_USE_MOCK=false was requested but mock data is still
in use: NEXT_PUBLIC_API_BASE_URL is not set.
```

---

## What "live" does not mean

The sidebar says **"data as of …"**, not "live". Cost data lags the
provider by 8–24 hours and is restated for days afterwards, so the
timestamp is the finish time of the last successful ingest
(`ingest_runs.finished_at`), which every API response carries as `as_of`.

Until an ingest completes, live mode says **"no data ingested yet"** and
every cost screen shows an empty state. That is the correct result, not a
failure — and it is the state this deployment is in until the first
`backfill` run finishes.
