# CostHub demo video

A 65-second demo, rendered from code with Remotion 4 so that any
timing change is one re-render away. `out/costhub.mp4`, 1920×1080,
30 fps, 100 BPM, cuts on the beat.

## Re-render

```bash
cd demo
npm install
npm run render     # remotion render Costhub out/costhub.mp4 --gl=swangle --timeout=60000 --concurrency=4
```

Three things about rendering on this machine, all learned the hard way:

* **`--gl=swangle`** because there is no GPU.
* **`--timeout=60000`.** The default 30s `delayRender` budget is not
  enough for the font load under software rendering; the first full
  render died at frame 904 after six minutes.
* **Chrome comes from `remotion.config.ts`, not from Remotion's
  download.** Remotion's own fetch of `chrome-headless-shell-win64.zip`
  extracts 2 of its 290 entries here -- no `.exe` -- then reports
  success and renders nothing. The config points at the installed
  Chrome; override with `REMOTION_BROWSER`.

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

Narrated with **Kokoro-82M** (Apache-2.0) on CPU, via the venv in
`tts/`. One line per scene, in `src/data/narration.json` beside the
scene timings.

```bash
tts/venv/Scripts/python tools/make-voice.py      # synthesise + duck + mix
bash tools/normalise-audio.sh                    # -> -14 LUFS, -1.5 dBTP
```

`make-voice.py` measures every line against its scene window and
**fails** if one overruns, rather than letting it be read over the next
scene's first beat. Three lines did on the first pass and were shortened.
It also ducks the bed 11 dB under the voice with 0.28s ramps, so the
music neither fights the narration nor disappears between lines.

The narration is held to the same rule as the captions: each line says
what its scene shows and no more, including "mock data, not live spend"
and "Google Cloud is not built yet". Someone who listens without reading
is told the same truths. On-screen text still carries every claim on its
own, because half the room will watch muted.

Measured in the finished file: speech present in all ten scene windows
at 1.6-2.7x the between-line level, 23.8s of speech across 64.8s,
-14.5 LUFS integrated.

## What each scene claims

| # | Scene | On screen | Provenance |
|---|---|---|---|
| 1 | What it is | One dashboard for accounts that were never in an Organization; the AWS stack it runs on | `terraform/` |
| 2 | Why | Before: every account reported on its own, no single view, all-or-nothing access. Now: one place, by account/service/period, granted per account | `docs/01-requirements.md`, `CONTEXT.md` |
| 3 | What you see | Monthly columns and per-account bars, with the app's real period set (day/month/quarter/year) | `tools/dump-mock.ts` → the app's own `getDashboardData`. **Captioned as sample data, not live spend.** |
| 4 | Who sees what | The same screen under two identities: five accounts, then one. "Narrowing is done in the database query, not the screen" | Same mock dump; the grant is the one `mockGrants()` actually records for that user. Captioned as sample estate. |
| 5 | And it is real | A live account's own service names; a second account that cannot be read yet, with the real message saying which switch is off | `ingest_runs` on deployed RDS via `tools/dump-live.py`. The second account's name and 12-digit id are stripped at capture time. |
| 6 | Running it | `./do.sh up dev`; its own running cost shows up in the same dashboard; no servers; another environment is one more file | `do.sh cmd_up`, `terraform/`. **No dollar figure** — see the note in the scene source. |
| 7 | Roadmap | Azure (written, never run), Google Cloud (not built), other per-account sources, alerts that reach people | `ingest/sources.py`, `CONTEXT.md`. Marked "not built yet" in the eyebrow, on every card and in the caption. |
| 8 | Close | Provenance line: charts are a sample estate, the account and connection are the real deployment | — |

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

## Where the live scenes get scoped

`tools/dump-live.py` reads `fact_cost_daily` **for `account_id = 'self'`
only**. A second, real AWS account was connected on 2026-10-13 and now
ingests successfully, which put about $1.8k of somebody else's spend —
service by service — into the same table. None of that belongs in a
video, and the deployment's own account is also the only one whose bill
can honestly be narrated as "it bills itself".

The one row kept from the other account is the historical failed ingest
in scene 6, selected by `error ILIKE '%Cost Explorer access denied%'`
because that is the two-stage verdict the scene is about. Its display
name and 12-digit id are stripped before anything is written to disk.

## Verification state

- `npx tsc --noEmit` — clean.
- Backend suite on 2026-10-13: **174 passed, 2 failed** — a flaky Neon
  connection in `test_future_grant_excluded`, and
  `test_source_files_respect_the_line_limit` (`api/routes/admin.py` 404
  lines, `connections/store.py` 347, limit 300). Both pre-date this
  work. `test_only_scoped_reads_the_fact_table` — the one scene 8 cites
  — passed.
- Audio: −14.1 LUFS, −1.5 dBTP, measured with `ebur128`.
- Three review passes ran against the rendered file: honesty (13
  findings), craft (17, frame-cited), licensing (10). The honesty and
  licensing findings are all applied or recorded; of the craft findings,
  the dip-to-black at every cut, the frozen-frame pacing, the un-animated
  identity swap, the SQL overflowing its card and the mid-tween frames
  that asserted false counts are fixed. Left alone: the 4-up card
  baselines, the small type at 480px, and the top-heavy composition.
