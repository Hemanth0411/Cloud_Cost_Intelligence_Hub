#!/usr/bin/env bash
# Bring the synthesised bed to -14 LUFS integrated, -1.5 dBTP true peak.
#
# WHY THIS IS THREE STAGES. The raw bed is a quiet drone with sharp
# pulses: integrated -27.7 LUFS but true peak only -6 dBTP. A linear
# loudnorm would need +13.7 dB, which puts the peaks at +7.6 dBTP, so
# loudnorm refuses to go linear and lands ~1.5 LU short of the target
# (measured: -15.6 against a -14 request). Limiting the transients
# FIRST lowers the crest factor enough that the remaining correction
# fits under the true-peak ceiling.
#
#   gain -> limiter -> loudnorm, then verify with ebur128.
set -euo pipefail
cd "$(dirname "$0")/.."
FF=node_modules/ffmpeg-static/ffmpeg.exe
IN=public/audio/bed-raw.wav
OUT=public/audio/bed.wav
TARGET=-14

measure() {   # file -> integrated LUFS
  "$FF" -hide_banner -nostats -i "$1" -af loudnorm=print_format=json -f null - 2>&1 |
    grep '"input_i"' | tail -1 | sed 's/.*: *"//; s/".*//'
}

I=$(measure "$IN")
GAIN=$(awk -v t="$TARGET" -v i="$I" 'BEGIN { printf "%.2f", t - i }')
echo "raw integrated ${I} LUFS -> applying ${GAIN} dB with a limiter"

"$FF" -hide_banner -nostats -y -i "$IN" \
  -af "volume=${GAIN}dB,alimiter=limit=0.84:attack=5:release=60,loudnorm=I=${TARGET}:TP=-1.5:LRA=11" \
  -ar 48000 -c:a pcm_s16le "$OUT" 2>&1 | tail -2

echo "verify:"
"$FF" -hide_banner -nostats -i "$OUT" -af ebur128=peak=true:framelog=quiet -f null - 2>&1 |
  grep -E "I: |Peak:" | head -4
