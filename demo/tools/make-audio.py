"""Synthesise the music bed and the sound effects.

Nothing is downloaded and nothing is licensed: every sample here is
generated with numpy, so the audio in this video is owned outright. That
is also why it is restrained -- a synthesised "song" sounds synthesised,
while a pulse, a low drone and a few marks sound like sound design.

The tempo and the scene lengths come from `src/data/timing.json`, the
same file `src/Root.tsx` reads, so the marks land on the cuts by
construction rather than by ear.

    tts/venv/Scripts/python tools/make-audio.py
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
TIMING = json.loads((ROOT / "src" / "data" / "timing.json").read_text(encoding="utf-8"))
OUT = ROOT / "public" / "audio"
OUT.mkdir(parents=True, exist_ok=True)

SR = 48_000
BPM = TIMING["bpm"]
FPS = TIMING["fps"]
BEAT = 60.0 / BPM                      # 0.6 s
BAR = BEAT * 4
TOTAL_BARS = sum(s["bars"] for s in TIMING["scenes"])
DURATION = TOTAL_BARS * BAR
N = int(DURATION * SR)

rng = np.random.default_rng(0x05570)   # fixed: a bed that differs per run is not reviewable
t = np.arange(N) / SR
bed = np.zeros(N)


def place(buffer: np.ndarray, sample: np.ndarray, at_s: float, gain: float = 1.0) -> None:
    i = int(at_s * SR)
    if i >= len(buffer):
        return
    end = min(len(buffer), i + len(sample))
    buffer[i:end] += sample[: end - i] * gain


def env(n: int, attack: float, decay: float) -> np.ndarray:
    """Attack-decay envelope, in seconds, cosine in and exponential out."""
    a = max(1, int(attack * SR))
    e = np.ones(n)
    e[:a] = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, a))
    tail = np.arange(n) / SR
    return e * np.exp(-tail / decay)


def tone(freq: float, dur: float, attack: float, decay: float, partials=(1.0, 0.0)) -> np.ndarray:
    n = int(dur * SR)
    x = np.arange(n) / SR
    wave = np.zeros(n)
    for k, amp in enumerate(partials, start=1):
        if amp:
            wave += amp * np.sin(2 * np.pi * freq * k * x)
    return wave * env(n, attack, decay)


def noise_brush(dur: float, decay: float) -> np.ndarray:
    n = int(dur * SR)
    raw = rng.standard_normal(n)
    # One-pole low-pass, twice: the point is air, not hiss.
    for _ in range(2):
        out = np.zeros(n)
        acc = 0.0
        for i in range(0, n, 1):
            acc += 0.02 * (raw[i] - acc)
            out[i] = acc
        raw = out
    return raw / (np.max(np.abs(raw)) or 1.0) * env(n, 0.004, decay)


# ---- drone: A2 + E3, breathing over sixteen bars -------------------------
for freq, amp in ((110.0, 0.085), (164.81, 0.052), (220.0, 0.026)):
    breathe = 0.72 + 0.28 * np.sin(2 * np.pi * t / (BAR * 8) + freq)
    bed += amp * breathe * np.sin(2 * np.pi * freq * t)

# ---- pulse on beats 1 and 3 of every bar --------------------------------
beats = int(DURATION / BEAT)
kick = tone(58.0, 0.34, 0.002, 0.085, partials=(1.0, 0.22))
for b in range(beats):
    if b % 2 == 0:
        place(bed, kick, b * BEAT, 0.5 if b % 4 == 0 else 0.3)

# ---- brush on the downbeat of every bar ---------------------------------
brush = noise_brush(0.5, 0.11)
for bar_index in range(int(TOTAL_BARS) + 1):
    place(bed, brush, bar_index * BAR, 0.3)

# ---- a mark on every scene cut ------------------------------------------
# Scene changes are the only events in the video, so they are the only
# events in the bed. Fifth above the drone, short enough to read as a
# punctuation mark rather than a note.
mark = tone(659.26, 0.5, 0.004, 0.12, partials=(1.0, 0.3, 0.12))
cuts_s: list[float] = []
acc_bars = 0.0
for scene in TIMING["scenes"][:-1]:
    acc_bars += scene["bars"]
    cuts_s.append(acc_bars * BAR)
for cut in cuts_s:
    place(bed, mark, cut, 0.16)

# ---- shape: fade in, duck under the first line, fade out ----------------
fade_in = min(N, int(1.2 * SR))
bed[:fade_in] *= np.linspace(0, 1, fade_in)
fade_out = min(N, int(2.2 * SR))
bed[-fade_out:] *= np.linspace(1, 0, fade_out)

peak = float(np.max(np.abs(bed)))
bed = bed / peak * 0.5                 # headroom for loudnorm
sf.write(OUT / "bed-raw.wav", bed.astype(np.float32), SR, subtype="PCM_16")

print(f"bars={TOTAL_BARS} duration={DURATION:.2f}s frames={int(DURATION * FPS)}")
print("cuts at seconds:", ", ".join(f"{c:.1f}" for c in cuts_s))
print(f"wrote {OUT / 'bed-raw.wav'} (peak before normalise {peak:.3f})")
