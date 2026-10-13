# Credits and licences

Everything in this video is either generated here, self-hosted with its
licence next to it, or a build tool that does not ship inside the file.

## Fonts — shipped in the render

| Asset | Source | Licence | Commercial use |
|---|---|---|---|
| Roboto Slab 400/600/700 | `@fontsource/roboto-slab` (Google Fonts) | **Apache-2.0** — `public/fonts/LICENSE-roboto-slab.txt` | Yes |
| Roboto 400/500/700 | `@fontsource/roboto` (Google Fonts) | **SIL OFL-1.1** — `public/fonts/LICENSE-roboto.txt` | Yes |
| Roboto Mono 400/500 | `@fontsource/roboto-mono` (Google Fonts) | **SIL OFL-1.1** — `public/fonts/LICENSE-roboto-mono.txt` | Yes |

Two of the three are OFL, not Apache — checked in each package's
`license` field and in the licence text itself. It matters for the
`.woff2` files, which ARE redistributed (they are committed here): OFL
requires the licence to travel with them, which it does, forbids selling
them on their own, and reserves the font names. Glyphs rasterised into
video frames are not font redistribution, so the mp4 itself carries no
font obligation.

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
| **`remotion` 4.0.420 and every `@remotion/*` package** | **Remotion License** (`"SEE LICENSE IN LICENSE.md"`; that file is not in the npm tarball). `@remotion/media-utils` is the one MIT exception; `@remotion/web-renderer` declares `UNLICENSED`; `@remotion/compositor-win32-x64-msvc` declares nothing. | See the warning below. |
| React 19 | MIT | |
| Remotion's bundled FFmpeg 7.1 (inside `@remotion/compositor-win32-x64-msvc`) | GPL + nonfree as configured, i.e. that binary cannot be redistributed | **This is what encoded `costhub.mp4`** (`encoder=Lavc61.19.100 libx264`). Encoding creates no obligation on the output; the binary stays in `node_modules/` and is gitignored. |
| `ffmpeg-static` (ffmpeg 6.1.1) | **GPL-3.0-or-later** | Loudness normalisation and frame extraction only. Not redistributed. |
| `puppeteer` | Apache-2.0 | Written for screenshot capture; **not used in the final render** (see README). |
| `kokoro-onnx` + Kokoro-82M | Apache-2.0 | Voiceover was attempted; the shipped cut is silent-with-text (see README). |
| numpy | `BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0` | Audio generation. |
| soundfile | BSD-3-Clause, bundling libsndfile (**LGPL-2.1**) | Audio generation. |
| `kokoro-onnx` and its chain | the package declares no licence; it pulls `phonemizer` and eSpeak NG, both **GPL-3.0** | Installed under `tts/`, gitignored, and NOT used in the shipped cut. |

### ⚠ Remotion licence — an owner decision, and it is already live

Remotion is **not** MIT. Its free licence covers individuals, non-profits
and for-profit companies **with up to three employees**; above that,
*using* Remotion requires a paid Company Licence, priced per developer
(<https://remotion.dev/license>).

**The trigger is headcount, not what the output is used for.** Chryselys
is larger than three people, so the obligation attached the moment
`remotion render` ran here — shelving the video does not discharge it,
and the hobby and evaluation tiers are for individuals and for trialling
Remotion itself, which a company demo made by an employee is not. Treat
this as owed, not pending.

Note also that the licence text is nowhere on disk: `remotion`'s
`package.json` points at a `LICENSE.md` that npm does not ship. The most
encumbered dependency in the project is the one whose terms this file
cannot quote.

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

No logo, screenshot, brand mark or stock image appears in the video —
every frame is text and CSS shapes. Company and product names that DO
appear: AWS service names exactly as the Cost Explorer API returns them,
plus Google Cloud, Azure and Terraform in the "not built yet" card and
the closing line, plus `chryselys.com` addresses from our own fixtures.
All of that is nominative use of a name to refer to the thing it names;
no mark is reproduced.

**One redaction is load-bearing.** The failed ingest in scene 6 belongs
to a real second AWS account. `tools/dump-live.py` strips the display
name and the 12-digit account id before writing `src/data/live.json`, so
neither reaches the screen or the repository. Earlier commits of that
file, made while this was being built, still contain them — the history
has not been rewritten.

### Codec patents

The deliverable is H.264 video and AAC audio. Codec *patent* licensing
(the Via LA AVC and AAC pools) is a separate question from software
licensing and is not covered by anything above. For an internal or
free-to-view demo this is the industry norm and effectively a non-issue;
if the video were ever shipped inside a paid product it would be a real
line item. Re-encoding to VP9 or AV1 would avoid the question entirely
and Remotion supports both.
