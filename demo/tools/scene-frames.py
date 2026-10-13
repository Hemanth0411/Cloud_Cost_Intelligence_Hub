"""One full-size frame from the middle of each scene, for close reading.

A 480px contact sheet catches layout and timing; it cannot tell you
whether 24px caption text is legible. These can.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = sys.argv[1] if len(sys.argv) > 1 else "out/costhub.mp4"
FF = str(ROOT / "node_modules" / "ffmpeg-static" / "ffmpeg.exe")

timing = json.loads((ROOT / "src" / "data" / "timing.json").read_text(encoding="utf-8"))
bar = (60.0 / timing["bpm"]) * 4
at = 0.0
for scene in timing["scenes"]:
    mid = at + scene["bars"] * bar / 2
    at += scene["bars"] * bar
    out = ROOT / "out" / f"scene-{scene['id']}.png"
    subprocess.run(
        [FF, "-hide_banner", "-nostats", "-y", "-ss", f"{mid:.2f}", "-i", SRC, "-frames:v", "1", str(out)],
        check=True, capture_output=True,
    )
    print(f"{out.relative_to(ROOT).as_posix()} at {mid:.2f}s")
