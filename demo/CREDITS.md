# Credits and licences

Everything in this video is either generated here, self-hosted with its
licence next to it, or a build tool that does not ship inside the file.

## Fonts — shipped in the render

| Asset | Source | Licence | Commercial use |
|---|---|---|---|
| Roboto Slab 400/600/700 | `@fontsource/roboto-slab` (Google Fonts) | Apache-2.0 — `public/fonts/LICENSE-roboto-slab.txt` | Yes |
| Roboto 400/500/700 | `@fontsource/roboto` (Google Fonts) | Apache-2.0 — `public/fonts/LICENSE-roboto.txt` | Yes |
| Roboto Mono 400/500 | `@fontsource/roboto-mono` (Google Fonts) | Apache-2.0 — `public/fonts/LICENSE-roboto-mono.txt` | Yes |

Self-hosted as `.woff2` under `public/fonts/`, loaded through
`FontFace` + `delayRender` so no frame can render in a fallback face.
These are the app's own faces (`frontend/tailwind.config.ts`:
`font-slab` / `font-sans`), not a new identity.

## Audio — generated here, owned outright

| Asset | How | Licence |
|---|---|---|
| `public/audio/bed-raw.wav` | `tools/make-audio.py` — numpy sine drone, pulse, filtered-noise brush, one mark per scene cut | Ours. No third-party sample, loop or stem. |
| `public/audio/bed.wav` | the above through `tools/normalise-audio.sh` | Ours |

**No Mixkit track was used, deliberately.** The brief suggested one;
synthesising the bed was chosen instead because (a) it removes the
licence question entirely rather than recording an answer to it, and
(b) the tempo is then *known* — 100 BPM, declared in
`src/data/timing.json`, which the scene durations are derived from, so
cuts land on the beat by construction instead of by ear. Sound effects
are the same generator, as the brief asked.

Measured output: **−14.1 LUFS integrated, −1.5 dBTP** (`ebur128`).

## Tooling — used to build, not shipped inside the video

| Tool | Licence | Note |
|---|---|---|
| **Remotion 4.0.420** | **Remotion Company Licence may be required** | See the warning below. |
| React 19, `@remotion/cli` | MIT / see Remotion above | |
| `ffmpeg-static` (ffmpeg binary) | ffmpeg is LGPL/GPL; this build ships its own `ffmpeg.exe.LICENSE` | Used for loudness normalisation and frame extraction. Not redistributed as part of the video. |
| `puppeteer` | Apache-2.0 | Written for screenshot capture; **not used in the final render** (see README). |
| `kokoro-onnx` + Kokoro-82M | Apache-2.0 | Voiceover was attempted; the shipped cut is silent-with-text (see README). |
| numpy, soundfile | BSD-3-Clause / BSD-3-Clause | Audio generation. |

### ⚠ Remotion licence — an owner decision, not a technical one

Remotion is **not** MIT. Its free licence covers individuals and
companies **up to three employees**; above that, rendering with it
requires a paid Remotion Company Licence
(<https://remotion.dev/license>). Chryselys is larger than three
people, so **this video was rendered under a licence the company
probably needs to buy before the output is used commercially** — a
hackathon or internal demo may fall inside their hobby/evaluation
terms, but that is a reading of their terms, not a certainty.

Options if that is unwelcome: buy the company licence, or re-render the
same scenes with a permissively licensed renderer. Nothing in `src/`
depends on Remotion beyond `useCurrentFrame`, `spring`, `Sequence` and
`AbsoluteFill`; the animation maths in `src/anim.ts` is plain functions
of time and would port.

## Data on screen

| Scene | Source | Licence/consent |
|---|---|---|
| Product, RBAC narrowing | `frontend/src/lib/mock/*` via `tools/dump-mock.ts` | Our own fixture data |
| Predicate text, row counts | `backend/costhub/query/scoped.py`, run against our own RDS by `tools/rbac-proof.py` | Our own code and database |
| Real service names, ingest verdicts, cost totals | our own AWS account 997916278551 via `tools/dump-live.py` | Our own account |

No third-party logo, screenshot, brand mark or stock image appears in
the video. The only company names on screen are AWS service names as
the Cost Explorer API returns them, and `chryselys.com` e-mail
addresses from our own fixtures.
