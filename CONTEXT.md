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
| Backend API (all endpoints) | **live**, 140 tests passing |
| Database + migrations | **live** (RDS) |
| `/admin/users`, `/admin/audit` | **live data** |
| Cost screens (dashboard, accounts, services, compare) | see `NEXT_PUBLIC_USE_MOCK` |
| `/insights` | **has no backend endpoint at all.** Prose generated client-side. Cannot be real without Bedrock (TODO-18) |
| `/anomalies` | endpoint exists; the MAD detector needs **≥14 days** of history (`min_history=14`, `window=28`) |
| Azure adapter | written, unit-tested against a recorded response, **never spoken to Azure** |
| `./do.sh teardown` | **never run.** Needs `pg_dump`, which is not installed |

**The governing rule on mock data:** mock exists to show what the product
looks like in use. It must never show a capability that cannot be real. An
empty real chart is fine; a fabricated one is not.

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

## Verification gates — run these before any commit

```bash
cd frontend
node_modules/.bin/tsc --noEmit -p tsconfig.json   # must be silent
node_modules/.bin/next build                      # must succeed
node_modules/.bin/next lint --file <changed files>

cd ../backend && python -m pytest tests -q        # 140 expected, ~7 min
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

Ordered. Items 1–3 are in flight under a separate brief.

1. **Wire the cost screens to the real API.** `lib/services/cost-service.ts`
   still reads `lib/mock/dataset` in both modes.
2. **Fix the hardcoded data-provenance banner** at
   `components/layout/app-sidebar.tsx:106`.
3. **Cut what cannot be real:** delete `/providers` (one provider is one
   bar), and delete or unmistakably label `/insights`.
4. **Backfill real cost data** — actionable now that Cost Explorer has
   populated: `cd backend && python -m costhub.cli backfill --months 4`
   (~4 API calls at $0.01). Until this runs the database has **zero cost
   rows** and every real chart is correctly empty.
5. **Run the anomaly and alerts Lambdas** once ≥14 days of history exist, so
   `/anomalies` and the alert feed have real rows:
   `aws lambda invoke --function-name costhub-dev-anomaly out.json`
6. **Update `NEXT_PUBLIC_API_BASE_URL` in the Amplify console** and redeploy
   `dev` whenever `api_url` changes.
7. **Install `pg_dump` before teardown day**, then rehearse
   `./do.sh teardown dev`. It has never been run, and it takes a backup
   before destroying anything.
8. Cleanup when done: revoke the GitHub PAT, `aws lambda remove-permission
   --function-name costhub-dev-api --statement-id FunctionURLAllowPublicAccess`,
   and tear the stack down so credits stop.

Not needed for the demo: Azure, a second AWS account (needs a
`CostHubCostReader` role created *in that account* first — no change
required on this side, the IAM grant already covers any account).
