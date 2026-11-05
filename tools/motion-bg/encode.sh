#!/usr/bin/env bash
# Склейка PNG-кадров в assets/motion.mp4 (+ облегчённая assets/motion-720.mp4) + постер assets/motion-poster.jpg.
# Использование: ./encode.sh <папка_с_кадрами> [fps=30] [crf=22]
# Сайт чёрно-белый, поэтому всё кодируется в ч/б (hue=s=0). Цветной вариант — убери hue=s=0 из GRAY.
set -euo pipefail

FRAMES="${1:?укажи папку с кадрами f00000.png …}"
FPS="${2:-30}"
CRF="${3:-22}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/assets/motion.mp4"
OUT_SM="$ROOT/assets/motion-720.mp4"
POSTER="$ROOT/assets/motion-poster.jpg"
GRAY="hue=s=0,"
mkdir -p "$ROOT/assets"

# H.264 High, yuv420p, BT.709 (так браузеры показывают цвета без сдвига), faststart, без звука.
# Против бэндинга в тёмных градиентах: aq-mode=3 (+биты тёмным плоским участкам) и низкие deadzone —
# кодер не «съедает» дизеринг из шейдера, вместо ступенек остаётся мелкий шум.
X264="aq-mode=3:aq-strength=1.2:deadzone-inter=6:deadzone-intra=6:psy-rd=1.0,0.15:deblock=-1,-1:keyint=120:min-keyint=30"
COLOR=(-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv)

ffmpeg -nostdin -v error -stats -y -framerate "$FPS" -i "$FRAMES/f%05d.png" \
  -vf "${GRAY}scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p" \
  -c:v libx264 -preset slow -crf "$CRF" -profile:v high -level:v 4.1 -x264-params "$X264" \
  "${COLOR[@]}" -movflags +faststart -an "$OUT"

# 720p для телефонов и слабого железа (выбирает ui.js) — сильнее сжата, на маленьком экране не видно
ffmpeg -nostdin -v error -stats -y -framerate "$FPS" -i "$FRAMES/f%05d.png" \
  -vf "${GRAY}scale=1280:720:out_color_matrix=bt709:out_range=tv:flags=lanczos+accurate_rnd+full_chroma_int,format=yuv420p" \
  -c:v libx264 -preset slow -crf $((CRF + 6)) -profile:v high -level:v 4.1 -x264-params "$X264" \
  "${COLOR[@]}" -movflags +faststart -an "$OUT_SM"

# постер = кадр 0: видео стартует ровно с той же картинки, без скачка
ffmpeg -nostdin -v error -y -i "$FRAMES/f00000.png" -vf "${GRAY}null" -q:v 4 "$POSTER"

ls -l "$OUT" "$OUT_SM" "$POSTER"
