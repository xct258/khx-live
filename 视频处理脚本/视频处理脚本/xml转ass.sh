#!/usr/bin/env bash
set -euo pipefail

# ===== 可配置项 =====
DANMAKU_FACTORY="/rec/apps/DanmakuFactory"
FONT_SIZE=50
OPACITY=200   # 0–255，数值越大越不透明

# ===== 参数检查 =====
if [[ $# -ne 1 ]]; then
  echo "用法: $0 <弹幕xml文件路径>"
  exit 1
fi

XML_PATH="$1"

if [[ ! -f "$XML_PATH" ]]; then
  echo "错误：XML 文件不存在：$XML_PATH"
  exit 1
fi

if [[ ! -x "$DANMAKU_FACTORY" ]]; then
  echo "错误：DanmakuFactory 不存在或不可执行：$DANMAKU_FACTORY"
  exit 1
fi

# ===== 生成 ASS 路径 =====
DIR="$(dirname "$XML_PATH")"
BASENAME="$(basename "$XML_PATH")"
NAME="${BASENAME%.*}"
ASS_PATH="${DIR}/${NAME}.ass"

# ===== 转换 =====
echo "正在转换："
echo "  XML -> $XML_PATH"
echo "  ASS -> $ASS_PATH"

"$DANMAKU_FACTORY" \
  -i "$XML_PATH" \
  -o "$ASS_PATH" \
  -S "$FONT_SIZE" \
  -O "$OPACITY" \
  --ignore-warnings

echo "转换完成 ✅"
