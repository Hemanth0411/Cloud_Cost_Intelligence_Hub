"""Narration, and the mix it sits in.

Kokoro-82M (Apache-2.0) on CPU -- there is no GPU here and none is
needed: a 65-second script synthesises in about two minutes.

WHAT THIS FILE IS CAREFUL ABOUT:

* **Fit.** Each line is spoken over one scene, and a line that overruns
  its scene is read over the next one's first beat. Every line is
  measured against its window and the script FAILS if one does not fit,
  rather than quietly letting it spill.
* **Ducking.** The bed drops under the voice and comes back between
  lines, with ramps rather than steps, so the music does not fight the
  narration and does not disappear either.
* **Honesty.** The lines live in src/data/narration.json beside the
  scene timings, and each one says what its scene shows -- including
  "mock data, not live spend" and "Google Cloud is not built yet". A
  viewer who listens without reading is told the same things.

    tts/venv/Scripts/python tools/make-voice.py
    bash tools/normalise-audio.sh public/audio/mix-raw.wav
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
TIMING = json.loads((ROOT / "src" / "data" / "timing.json").read_text(encoding="utf-8"))
SCRIPT = json.loads((ROOT / "src" / "data" / "narration.json").read_text(encoding="utf-8"))
AUDIO = ROOT / "public" / "audio"
SR = 48_000

BAR = (60.0 / TIMING["bpm"]) * 4
LEAD = float(SCRIPT["lead"])

# Bed level under the voice, and how long the ramp into it takes.
DUCK_DB = -11.0
RAMP = 0.28


def resample(x: np.ndarray, src_sr: int) -> np.ndarray:
    """Linear resample to SR. Good enough for speech, no scipy needed."""
    if src_sr == SR:
        return x
    n = int(round(len(x) * SR / src_sr))
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x)


def main() -> int:
    from kokoro_onnx import Kokoro

    kokoro = Kokoro(str(ROOT / "tts" / "kokoro-v1.0.onnx"), str(ROOT / "tts" / "voices-v1.0.bin"))

    bed, bed_sr = sf.read(AUDIO / "bed-raw.wav", dtype="float32")
    if bed.ndim > 1:
        bed = bed.mean(axis=1)
    assert bed_sr == SR, f"bed is {bed_sr} Hz, expected {SR}"

    voice_track = np.zeros_like(bed)
    gain = np.ones_like(bed)
    at = 0.0
    problems: list[str] = []

    for scene in TIMING["scenes"]:
        line = SCRIPT["lines"].get(scene["id"])
        window = scene["bars"] * BAR
        start = at
        at += window
        if not line:
            continue

        samples, sr = kokoro.create(line, voice=SCRIPT["voice"], speed=SCRIPT["speed"], lang="en-us")
        audio = resample(np.asarray(samples, dtype=np.float32), sr)
        spoken = len(audio) / SR
        room = window - LEAD
        flag = "" if spoken <= room else "  <-- OVERRUNS"
        if spoken > room:
            problems.append(f"{scene['id']}: {spoken:.2f}s of speech in a {room:.2f}s window")
        print(f"{scene['id']:10s} {spoken:5.2f}s / {room:5.2f}s{flag}")

        i = int((start + LEAD) * SR)
        end = min(len(voice_track), i + len(audio))
        voice_track[i:end] += audio[: end - i]

        # Duck the bed across the spoken span, with ramps either side.
        duck = 10 ** (DUCK_DB / 20)
        r = int(RAMP * SR)
        a, b = i, min(len(gain), i + len(audio))
        gain[max(0, a - r) : a] = np.minimum(gain[max(0, a - r) : a], np.linspace(1, duck, a - max(0, a - r)))
        gain[a:b] = duck
        tail = min(len(gain), b + r)
        gain[b:tail] = np.minimum(gain[b:tail], np.linspace(duck, 1, tail - b))

    if problems:
        print("\nlines that do not fit their scene:", *problems, sep="\n  ")
        return 1

    peak = float(np.max(np.abs(voice_track))) or 1.0
    voice_track = voice_track / peak * 0.72
    mix = bed * gain * 0.85 + voice_track

    sf.write(AUDIO / "vo.wav", voice_track.astype(np.float32), SR, subtype="PCM_16")
    sf.write(AUDIO / "mix-raw.wav", (mix / (np.max(np.abs(mix)) or 1.0) * 0.9).astype(np.float32), SR, subtype="PCM_16")
    print(f"\nwrote {AUDIO / 'vo.wav'} and {AUDIO / 'mix-raw.wav'} ({len(mix) / SR:.2f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
