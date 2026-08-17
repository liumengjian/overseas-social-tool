#!/usr/bin/env bash
# 脚本1：敏感内容「重新编码脱敏」
# 对视频做 去元数据 + 重新编码(H.264) + 改分辨率(720宽) + 改码率 + 轻微裁剪(四周各10px) + 调帧率(24fps)，
# 用于绕开基于元数据/编码特征的内容安全敏感判定。
#
# 用法：
#   ./ffmpeg_sanitize.sh <输入视频> [输出视频] [ffmpeg路径]
# 示例：
#   ./ffmpeg_sanitize.sh raw.mp4 sanitized.mp4
#   ./ffmpeg_sanitize.sh raw.mp4 sanitized.mp4 /opt/ffmpeg/bin/ffmpeg

set -euo pipefail

FF="${3:-ffmpeg}"
IN="${1:?用法: ffmpeg_sanitize.sh <输入视频> [输出视频] [ffmpeg路径]}"
OUT="${2:-${IN%.*}_sanitized.mp4}"

"$FF" -y -i "$IN" \
  -vf "scale=720:-2,crop=iw-20:ih-20:10:10,format=yuv420p" \
  -r 24 \
  -c:v libx264 -preset veryfast -crf 23 -b:v 1400k \
  -map_metadata -1 -fflags +bitexact \
  -c:a aac -b:a 128k \
  -movflags +faststart \
  "$OUT"

echo "已生成脱敏视频: $OUT"
