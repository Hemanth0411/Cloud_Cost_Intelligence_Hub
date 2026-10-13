# CostHub demo video

A 77-second demo, rendered from code with Remotion 4 so that any timing
change is one re-render away. `out/costhub.mp4`, 1920×1080, 30 fps.

## Re-render

```bash
cd demo
npm install
npx remotion render Costhub out/costhub.mp4 --gl=swangle   # no GPU here: swangle
```

Other compositions: `CosthubSilent` (same cut, no audio track) and
`Scene<Id>` for each scene on its own, so one shot can be reviewed
without re-rendering the film.

Review loop — this is how every claim below was checked:

```bash
FF=node_modules/ffmpeg-static/ffmpeg.exe
"$FF" -i out/costhub.mp4 -vf "fps=1,scale=480:-1,tile=5x4" out/contact.png
# then actually look at out/contact.png
```

## Regenerating the data on screen

Nothing in the video is typed in by hand. Three capture scripts write
`src/data/*.json`:

```bash
# the app's own dashboard figures (run FROM frontend/ so tsx sees its tsconfig)
cd frontend && NEXT_PUBLIC_USE_MOCK=true npx tsx ../demo/tools/dump-mock.ts

# the deployed database: real cost rows, ingest verdicts, audit mix
cd backend
export AWS_PROFILE=costhub
export DATABASE_URL="$(terraform -chdir=../terraform output -raw database_url)"
python ../demo/tools/dump-live.py

# the shipped grant predicate, run as five principals (transaction is rolled back)
PYTHONPATH=. python ../demo/tools/rbac-proof.py
```

Audio:

```bash
tts/venv/Scripts/python tools/make-audio.py   # synthesise the bed
bash tools/normalise-audio.sh                 # -> -14 LUFS, -1.5 dBTP
```

## How the UI got into the video, and why

The brief offered rebuilding the screens as components or capturing
stills from the running app. **This is the rebuilt-components option**,
for three reasons:

1. The dev server on :3000 was serving `main-app.js` and
   `app/layout.css` as **404** — CONTEXT.md trap 14, another session's
   `next build` clobbering a running `next dev`. With no client JS there
   is no login form to drive and no charts to photograph. Reviving it
   needs an edit inside `frontend/`, which this task may not touch.
2. The two things that have to *move* are the grant narrowing and the
   numbers falling with it. You cannot animate inside a screenshot.
3. Filtering is structural here: every figure is dumped AWS-only, so a
   Google Cloud account cannot appear by accident. With captures it
   would be a cropping discipline instead.

`tools/shoot.mjs` is the capture script, kept and working against a
healthy server (it signs in with the public demo credentials and pins
`provider=aws` on every URL). If :3000 is revived, stills can be swapped
into the product scene without touching anything else.

The colours and faces are the app's own tokens, transcribed in
`src/theme.ts` from `frontend/src/app/globals.css`.

## Voiceover

Silent, with on-screen text carrying every claim — the brief's fallback,
taken deliberately: half the audience watches muted, so the text has to
stand alone anyway, and a narrator reading it aloud adds a second place
for a claim to drift. Kokoro-82M (Apache-2.0) is installed under
`tts/` if someone wants to add one.

## What each scene claims

| # | Scene | On screen | Provenance |
|---|---|---|---|
| 1 | Hook | Deployed on Cognito, API Gateway, Lambda, RDS, Amplify, in account 997916278551 | `terraform/` + `terraform output` |
| 2 | Problem | No AWS Organization; cost data is sensitive; CID dashboards assume a payer account | `docs/01-requirements.md`, `CONTEXT.md` |
| 3 | Product | $3,479,523.12 over 12 months, 5 AWS accounts, 10 services, monthly columns, per-account bars | `tools/dump-mock.ts` → the app's own `getDashboardData`. **Captioned as audited mock, not live spend.** |
| 4 | RBAC narrowing | Same screen under two identities: 5 accounts → 1, $3.48M → $830,632.38 | Same mock dump, `accountId: 'aws-data-lake'`. Captioned as mock estate. |
| 5 | Predicate | `GRANT_PREDICATE` verbatim; rows returned as five principals: 27 / 27 / 10 / 0 / 0 | `tools/rbac-proof.py` against deployed RDS. The two test principals were inserted in a transaction and rolled back; the script re-checks the row counts afterwards and the scene prints that. |
| 6 | Real verdicts | One account OK with 6 real service names; one account failed with the real Cost Explorer denial text | `ingest_runs` on deployed RDS, `tools/dump-live.py` |
| 7 | Cost to run | Its own bill $0.00 over 27 rows / 6 services, Jul 1 – Oct 13; db.t4g.micro + 5 Lambdas; $80/month budget; $0.01 per connection test | `fact_cost_daily` (its own account), `terraform/env/dev.tfvars`, `terraform/messaging.tf`, `connections/probe.py` |
| 8 | Deploy | `./do.sh up dev` step list; 57 resources; an AST test guards the single reader | `do.sh cmd_up`, `terraform state list \| wc -l` = 57, `backend/tests/test_invariant.py` |
| 9 | Scale | Account = a row; provider = one adapter entry; ingest idempotent on the natural key; **Google Cloud not built, Azure never spoken to** | `ingest/sources.py`, `ingest/runner.py` `ON CONFLICT`, `migrations/002_facts.sql` indexes, CONTEXT.md |
| 10 | Close | Provenance line: charts are mock, measured figures are from the deployed stack | — |

## What the video deliberately does NOT show

Every one of these is a real gap, and showing it would be a promise:

- **Google Cloud.** `ADAPTERS` is `{aws, azure}`; a GCP connection
  raises `NoAdapter`. The mock estate has GCP accounts — all scenes
  filter to AWS, and scene 9 says so out loud.
- **Azure as working.** Unit-tested against a recorded response, never
  spoken to Azure. Named only in scene 9's "not built yet" card.
- **AI insights.** `/insights` has no backend endpoint; the prose is
  client-side. Not filmed at all.
- **Anomaly detection finding something.** Needs ≥14 days of history;
  the live account has about one day of near-zero spend. Not filmed.
- **Live cost figures as the big number.** Real spend is $0.00. It
  appears only where it is true, in scenes 6 and 7, with its reason.

## Verification state

- `npx tsc --noEmit` — clean.
- Backend suite on 2026-10-13: **174 passed, 2 failed** — a flaky Neon
  connection in `test_future_grant_excluded`, and
  `test_source_files_respect_the_line_limit` (`api/routes/admin.py` 404
  lines, `connections/store.py` 347, limit 300). Both pre-date this
  work. `test_only_scoped_reads_the_fact_table` — the one scene 8 cites
  — passed.
- Audio: −14.1 LUFS, −1.5 dBTP, measured with `ebur128`.
