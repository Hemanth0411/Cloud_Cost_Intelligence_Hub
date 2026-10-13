#!/usr/bin/env bash
# Frames out of the rendered file, as sheets you can actually read.
#
# One frame a second at 480px is enough to catch text running off the
# edge, a value that jumps, or a cut landing early. It is NOT enough to
# judge small type, so this also writes full-size frames at the middle
# of every scene (scene-*.png) from the timing table.
#
#   bash tools/contact-sheet.sh [out/costhub.mp4]
set -euo pipefail
cd "$(dirname "$0")/.."
FF=node_modules/ffmpeg-static/ffmpeg.exe
SRC=${1:-out/costhub.mp4}

"$FF" -hide_banner -nostats -y -i "$SRC" -vf "fps=1,scale=480:-1,tile=5x4" out/contact-%02d.png 2>&1 | tail -1

# Full-size frame from the middle of each scene, named after the scene.
node -e '
const t = require("./src/data/timing.json");
const bar = (60 / t.bpm) * 4;
let at = 0;
const rows = t.scenes.map((s) => {
  const mid = at + (s.bars * bar) / 2;
  at += s.bars * bar;
  return `${s.id} ${mid.toFixed(2)}`;
});
console.log(rows.join("\n"));
' | while read -r id mid; do
  "$FF" -hide_banner -nostats -y -ss "$mid" -i "$SRC" -frames:v 1 "out/scene-$id.png" 2>/dev/null
  echo "out/scene-$id.png at ${mid}s"
done
