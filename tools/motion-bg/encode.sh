#!/usr/bin/env bash
# Склейка PNG-кадров в assets/motion.mp4 + постер assets/motion-poster.jpg.
# Использование: ./encode.sh <папка_с_кадрами> [fps=30] [crf=18]
set -euo pipefail

FRAMES="${1:?укажи папку с кадрами f00000.png …}"
FPS="${2:-30}"
CRF="${3:-18}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/assets/motion.mp4"
POSTER="$ROOT/assets/motion-poster.jpg"
mkdir -p "$ROOT/assets"

# H.264 High, yuv420p, BT.709 (так браузеры показывают цвета без сдвига), faststart, без звука.
# Против бэндинга в тёмных градиентах: aq-mode=3 (+биты тёмным плоским участкам) и низкие deadzone —
# кодер не «съедает» дизеринг из шейдера, вместо ступенек остаётся мелкий шум.
ffmpeg -v error -stats -y -framerate "$FPS" -i "$FRAMES/f%05d.png" \
  -vf "scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p" \
  -c:v libx264 -preset slow -crf "$CRF" -profile:v high -level:v 4.1 \
  -x264-params "aq-mode=3:aq-strength=1.2:deadzone-inter=6:deadzone-intra=6:psy-rd=1.0,0.15:deblock=-1,-1:keyint=120:min-keyint=30" \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -movflags +faststart -an "$OUT"

# постер = кадр 0: видео стартует ровно с той же картинки, без скачка
ffmpeg -v error -y -i "$FRAMES/f00000.png" -q:v 4 "$POSTER"

ls -l "$OUT" "$POSTER"
