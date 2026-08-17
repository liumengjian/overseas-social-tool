#!/usr/bin/env bash
# 脚本2：敏感内容「抽帧脱敏」
# 按 1 帧/秒从视频抽取关键帧为 JPG 图片集合，用于当重新编码仍被判敏感时，
# 改用「图片集」交给多模态模型做内容分析。
#
# 用法：
#   ./ffmpeg_frames.sh <输入视频> [输出目录] [最大帧数] [ffmpeg路径]
# 示例：
#   ./ffmpeg_frames.sh sanitized.mp4 frames 30

set -euo pipefail

FF="${4:-ffmpeg}"
IN="${1:?用法: ffmpeg_frames.sh <输入视频> [输出目录] [最大帧数] [ffmpeg路径]}"
OUTDIR="${2:-frames}"
MAX="${3:-30}"

mkdir -p "$OUTDIR"
"$FF" -y -i "$IN" -vf fps=1 -q:v 2 -frames:v "$MAX" "$OUTDIR/frame_%05d.jpg"

echo "已抽取帧到: $OUTDIR"
