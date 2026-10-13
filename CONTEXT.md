# CONTEXT — read this first

Written for whoever picks this up next, human or AI, in any editor. It is
the things that are **not** derivable from the code, plus pointers to the
things that are. `docs/` has the full design; this file has the state, the
traps, and what is left.

Last updated 2026-10-13.

---

## What this is

CostHub: a multi-cloud cost analytics tool. Two constraints drove the whole
design, and both ruled out the off-the-shelf answer (AWS Cloud Intelligence
Dashboards):

1. The AWS accounts are **not in an AWS Organization** — independent
   accounts, so no org-wide CUR export and no payer rollup.
2. Cost data is **sensitive** — not everyone may see every account.

Hence the central claim: `backend/costhub/query/scoped.py` is the **only**
reader of `fact_cost_daily`, and it always injects `GRANT_PREDICATE` into
the SQL, so unauthorised rows never leave the database.
`backend/tests/test_invariant.py` enforces that mechanically with an AST
walk. If you break that invariant, a test fails — don't route around it.

Start with `docs/README.md`, then `docs/02-architecture.md`. `docs/14-frontend-build-spec.md`
describes a Vite app with nine pages; the real frontend is **Next.js 15 app
router** with a different page set. Treat that doc as intent, not fact.

## Running it

```bash
export AWS_PROFILE=costhub        # EVERY shell. See traps below.
./do.sh up dev                    # build + apply + branding + migrate + outputs
./do.sh outputs dev               # re-read live values; writes frontend/.env.local
cd frontend && npx next dev -p 3000
```

`./do.sh` with no arguments lists the commands. One environment exists:
`dev`, in AWS account **997916278551**, us-east-1.

**Never hardcode a live value.** `api_url` and `cognito_client_id` have both
changed mid-project when an apply replaced a resource. Always
`./do.sh outputs dev`.

## What is real, and what is not

| Area | State |
|---|---|
| Cognito email-OTP sign-in | **live**, proven end to end; the managed login page is branded from `branding/` — see its README |
| Backend API (all endpoints) | **live**, 207 tests passing |
| Database + migrations | **live** (RDS) |
| `/admin/users`, `/admin/audit` | **live data** |
| Cost screens (dashboard, accounts, services, compare) | see `NEXT_PUBLIC_USE_MOCK` |
| `/insights` | **has no backend endpoint at all.** Prose generated client-side. Cannot be real without Bedrock (TODO-18) |
| `/anomalies` | **live and honestly empty.** The detector ran on 105 days of real data (2026-10-13): 30 series, **0 findings**, and that is a true negative -- see "The anomaly detector" below before concluding it is broken or tuning it |
| Azure adapter | written, unit-tested against a recorded response, **never spoken to Azure** |
| `./do.sh teardown` | **never run.** Needs `pg_dump`, which is not installed |

**The governing rule on mock data:** mock exists to show what the product
looks like in use. It must never show a capability that cannot be real. An
empty real chart is fine; a fabricated one is not.

**The mock estate was audited as a FinOps practitioner would read it**
(2026-10-13, `d860a63`) and is now defensible. Two things follow from that
and will silently rot if ignored:

* **Service names in `lib/mock/catalog.ts` are EXACTLY what the cost APIs
  return** -- `Amazon Relational Database Service`, never `RDS` -- because
  `cost_explorer.py` writes the `SERVICE` dimension to `service_name`
  verbatim and live mode shows it. They are long on purpose. Charts shorten
  them with `compactServiceLabel`, which must keep working on LIVE rows, so
  do not replace it with a mock-only lookup table.
* **`npm run verify:data` is the gate, not a report.** 3,940 checks: the old
  integrity suite plus FinOps plausibility rules (category mix, weekend
  seasonality per category, control-plane magnitudes, planted-event coverage
  in both directions, budget spread, comparison-delta bounds). It exits
  non-zero. Run it after touching anything under `lib/mock/`.

## Traps — none of these are visible in the code

1. **`AWS_PROFILE=costhub` or you hit the wrong account.** The default
   profile points at a work account (881953306582). Terraform has an
   `allowed_account_ids` guard; bare `aws` commands do not.
2. **This account blocks anonymous Lambda invocation.** A Function URL with
   a textbook-correct public policy returns 403 `AccessDeniedException`;
   a hand-built throwaway function URL did the same. That is why the API is
   behind an **API Gateway HTTP API** (`terraform/apigateway.tf`), which
   invokes Lambda as a service principal. **Do not reintroduce a Function
   URL.** `lambda get-account-settings` shows `ConcurrentExecutions: 10`
   against a default of 1000 — the account is still unverified. A support
   request to lift it is worth filing.
3. **Never strip `*.dist-info` from the Lambda zip.** `do.sh` used to, which
   broke `importlib.metadata`; pydantic reads `email-validator`'s version
   while building the `EmailStr` schema, so `from fastapi import FastAPI`
   raised `PackageNotFoundError` and the entire API was dead — while the
   zip built, uploaded and applied cleanly.
4. **CORS has exactly one owner: the FastAPI app** (`CORSMiddleware`, fed by
   `CORS_ORIGINS`). API Gateway deliberately has no `cors_configuration` —
   two layers both setting `Access-Control-Allow-Origin` produce a
   duplicate header that browsers reject, which presents as "CORS is
   broken" while both layers are individually correct.
5. **Port 3000, not 3001.** Cognito's callback list has only
   `http://localhost:3000/auth/callback`; any other port gives
   `redirect_mismatch`. If something else holds 3000, free it rather than
   adding a port to Cognito.
6. **`NEXT_PUBLIC_*` cannot come from Terraform.** Declaring them in
   `aws_amplify_app.environment_variables` closes a dependency cycle
   (Amplify's domain is already an input to the Cognito callbacks and the
   Lambda CORS origins). They are set **in the Amplify console**, and
   `lifecycle.ignore_changes` in `terraform/amplify.tf` stops an apply
   deleting them. They are inlined at **build time**, so changing one needs
   a rebuild.
7. **`terraform plan` never reaches "No changes".** `aws_amplify_app.repository`
   (AWS lowercases the GitHub URL; `dev.tfvars` has mixed case) and
   `aws_amplify_branch.basic_auth_credentials` (AWS never returns it) are a
   permanent two-resource diff. It hides real drift — read plans carefully.
8. **Two databases.** `backend/.env` → **Neon**, local dev, seeded with
   `dev_seed` fake rows. Terraform output → **RDS**, deployed, real. So
   `python -m costhub.cli status` on its own reads *Neon*. For the deployed
   one:
   `DATABASE_URL="$(terraform -chdir=../terraform output -raw database_url)" python -m costhub.cli status`
9. **`do.sh` needs the system Python.** An activated virtualenv from another
   project shadows it and `import psycopg` fails. `deactivate` first.
   `do.sh` now checks and refuses up front.
10. **Set `MSYS_NO_PATHCONV=1` per command, never globally.** Git Bash
    rewrites POSIX-looking arguments for native binaries: an IAM
    `--path-prefix "/costhub/"` arrives as `C:/Program Files/Git/costhub/`.
    But exporting it shell-wide breaks `terraform -chdir`.
11. **Terraform state is a local file.** One machine, no lock server. Two
    sessions applying at once will collide. If that laptop dies the stack
    is orphaned — `terraform/terraform.tfstate.d/dev` is the only record.
12. **`terraform/env/dev.tfvars` holds a live GitHub PAT and the Amplify
    basic-auth password** in plaintext. Gitignored, but revoke the PAT when
    this project ends.
13. Amplify serves the site behind basic auth: user `demo`, password from
    `dev.tfvars`. That is the stakeholder gate, not the app's login.
14. **Never run `next build` while a `next dev` server is up.** They share
    `.next`, and the build wipes what dev is serving. Two symptoms seen:
    `Cannot find module './NNN.js'`, and
    `/_next/static/css/app/layout.css` returning 404 -- which renders every
    page as unstyled text and looks exactly like a blank screen. `touch`
    does not fix the CSS one; the watcher ignores an mtime-only change.
    Make a real edit to `src/app/globals.css`, wait for the recompile, then
    revert it. This matters in a shared checkout: your build breaks the
    OTHER session's dev server, not just yours.
15. **The demo login changed on 2026-10-13** to `admin@costhub.demo` /
    `CostHub!2026`, and the session cookie and every `localStorage` key were
    renamed `cloudlens*` -> `costhub*` with no migration. Any browser that
    used an earlier build is signed out, with its saved demo state (alert
    read marks, anomaly workflow, connection overrides, the mock/live
    override) discarded. That is expected, not a bug. `?mock=1` on any URL
    restores mock mode.

16. **This checkout is shared by several sessions at once, and that has
    already bitten.** On 2026-10-13 one session committed
    `routes/connections.py` while another had uncommitted edits in it:
    the commit swept those edits in, so `main` and `dev` imported a
    module (`ingest/stale.py`) that existed only on this disk -- a clean
    checkout could not have started the API. The Lambda was also built
    from the working tree with the other session's half-finished code in
    it. Two rules follow. Before committing a file, `git diff` it and
    check every hunk is yours. And build what you deploy from a clean
    tree of a commit (`git worktree add --detach <dir> <sha>`, then
    `./do.sh build` in there), never from this directory.
17. **A `profile` connection cannot run in Lambda.** `Chryselys-Office`
    (881953306582) is `credential_mode=profile`, `profile_name=default`.
    That works from this laptop and nowhere else: the deployed API and
    the 06:00 ingest answer "could not load profile 'default'". So that
    account's data moves only when someone runs the ingest by hand here,
    and it holds 1,274 of the 1,301 cost rows. The real fix is a
    `CostHubCostReader` role in that account and `assume_role`.

## The anomaly detector — what "0 findings" means

Our own rolling-median + MAD detector (`anomaly/mad.py`), not AWS Cost
Anomaly Detection. Run 2026-10-13 against the deployed database with
default settings: 30 series, 0 findings, `anomaly_findings` empty,
`GET /anomalies` returns `[]`. Checked independently against
`fact_cost_daily` with hand arithmetic; it is not a bug. Why:

* It scores only the **last 7 days** of each series (`scan_days=7`),
  after dropping the final 2 points, and it ignores decreases. Spend in
  the one account with real money fell off a cliff: $630 in July, $790
  in August, $335 in September, $101 so far in October. Nothing rose.
* The history *does* contain events the same thresholds flag when the
  whole range is scanned in memory -- AWS Glue on 2026-08-12/13
  ($69 then $224 in a day against a ~$0.03 median), with Athena,
  CloudWatch and S3 moving the same week. They are simply two months
  older than the scan window. Backfilling them is a product decision
  (`--scan-days 120` would do it); it was deliberately not done.

Three limits of the detector that this run exposed. None was changed --
the instruction was not to tune until something appears -- but know
them before trusting a quiet feed:

1. **A sparse series cannot be flagged at any dollar amount.** If a
   service was active on fewer than 14 of its trailing 28 days, the
   median and the MAD are both 0 and `_score` returns 0.0 by design
   ("a first charge is a new service"). Glue is in that state *today*
   (12 of 28 days). Replaying August's $421 burst after the last real
   row produces zero findings. The comment's rationale is also wrong
   for the case it catches most: Bedrock model series with weeks of
   history, not new services.
2. **"The last 7 days" is relative to each series' last row, not to
   today**, because zero-fill stops at the series' own last day. Glue's
   window was 09-30..10-06; a model last billed on 09-24 was scored on
   09-16..09-22. A charge followed by silence sits in the two dropped
   points forever.
3. `series_scanned` counts series before the `min_history` gate. "30
   scanned" was 20 scored, and 8 of those 20 could only ever score 0.

## Verification gates — run these before any commit

```bash
cd frontend
node_modules/.bin/tsc --noEmit -p tsconfig.json   # must be silent
node_modules/.bin/next build                      # must succeed -- NOT while next dev is up (trap 14)
node_modules/.bin/next lint --file <changed files>
npm run verify:data                               # 3,940 checks, exits non-zero

cd ../backend && python -m pytest tests -q        # 207 expected, ~12 min
cd .. && terraform -chdir=terraform validate
```

`next.config.mjs` ignores ESLint during builds but **not** TypeScript, so a
`tsc` error fails the Amplify build.

Push to **both** `main` and `dev` — Amplify builds `dev`. No AI attribution
trailers in commit messages.

## The lesson this project keeps teaching

Across every review pass, **everything that had never been run was broken.**
A clean `terraform apply` and a passing test suite said nothing about
whether the thing answered a request — at one point the "deployed and
tested" backend could not serve a single one. Invoke it, curl it, check the
status code. And verify an agent's claim before acting on it: acting on a
confident falsehood broke a working Terraform config here.

## What is left

Ordered.

~~1. Wire the cost screens to the real API.~~ **Done** — `cost-service.ts`
   branches on `isMock()` and the live-mode capability flags derive from it.
   Not exercised against the deployed API in a browser, so treat live mode
   as built-but-unproven until someone signs in and looks.
~~2. Fix the hardcoded data-provenance banner.~~ **Done** — the sidebar and
   header badges read the resolved mode; verified on screen reading
   "Mock dataset · no live cloud APIs".
~~3. Cut what cannot be real.~~ **Done** — `/providers` is gone and
   `/insights` carries a `Concept` badge plus a header saying "No AI model
   is called, and no endpoint backs this". Verified on screen.

~~4. Backfill real cost data.~~ **Done** — 105 days, 2026-07-01 onward,
   1,301 rows across two accounts.
~~5. Run the anomaly detector.~~ **Done** 2026-10-13: 0 findings, a true
   negative. See "The anomaly detector" above. The alerts job has not
   been run against real data.
5a. **Decide what the detector should do about sparse series** (limit 1
   above). It is the difference between a quiet feed and a blind one,
   and it needs an owner's answer, not a threshold nudge.
5b. **Give the office account a real role** (trap 17), or its data goes
   stale the day nobody runs the ingest from this laptop.
5c. **The `ingest`, `anomaly` and `alerts` Lambdas run an older build
   than `api`** unless the deploy named them. Check `CodeSha256` on all
   four before assuming a fix is live in the scheduled jobs.
6. **Update `NEXT_PUBLIC_API_BASE_URL` in the Amplify console** and redeploy
   `dev` whenever `api_url` changes.
7. **Install `pg_dump` before teardown day**, then rehearse
   `./do.sh teardown dev`. It has never been run, and it takes a backup
   before destroying anything.
8. Cleanup when done: revoke the GitHub PAT, `aws lambda remove-permission
   --function-name costhub-dev-api --statement-id FunctionURLAllowPublicAccess`,
   and tear the stack down so credits stop.

9. **Decide what to do about Google Cloud.** `ingest/sources.py` `ADAPTERS`
   is `{aws, azure}` — a GCP connection raises `NoAdapter` — yet the mock
   estate shows three Google Cloud accounts and ~20% of spend, and the
   connect dialog offers a GCP project-id field. This is the one remaining
   place the mock promises more than exists. It is a missing module, not an
   impossible one (the docstring says "one entry here and one new module"),
   so it was left in deliberately rather than cutting a quarter of the
   demo's multi-cloud story. Either write the adapter or say on screen that
   Google Cloud is a roadmap item. **Owner's call.**
10. **Delete the stale `origin/cloudlens-frontend` branch** (`fdef2ce`,
    "Add the CloudLens cost dashboard to the frontend"). Already merged into
    `main`, and it is the last thing in the repo carrying the old name.
11. `backend/costhub/ingest/dev_seed.py` invents service names as CUR
    service *codes* (`AmazonEC2`, `AmazonRDS`), not the Cost Explorer
    display names the real adapter writes. Harmless today, but locally
    seeded rows will not match live labels or the frontend mock.

Not needed for the demo: Azure, a second AWS account (needs a
`CostHubCostReader` role created *in that account* first — no change
required on this side, the IAM grant already covers any account).
