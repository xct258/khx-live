#!/bin/bash
# adjust_danmaku_raw.sh
# 支持秒 / 分:秒 / 时:分:秒（含中文冒号，支持负偏移）
# 18:10之前的弹幕保持原样，从18:10开始偏移，偏移后小于18:10的弹幕删除

set -euo pipefail

if [ $# -lt 3 ]; then
    echo "用法: $0 <输入 XML 文件> <起始时间> <偏移时间> [输出文件]"
    echo "时间格式支持:"
    echo "  SS"
    echo "  MM:SS / MM：SS"
    echo "  HH:MM:SS / HH：MM:SS"
    echo "  偏移时间支持负数，如 -01:30"
    exit 1
fi

INPUT_FILE="$1"
START_TIME="$2"
OFFSET_TIME="$3"
OUTPUT_FILE="${4:-${INPUT_FILE%.*}_adjusted.xml}"

PYTHON=$(command -v python3 || command -v python)
[ -z "$PYTHON" ] && { echo "错误: 未找到 python"; exit 1; }

"$PYTHON" - "$INPUT_FILE" "$START_TIME" "$OFFSET_TIME" "$OUTPUT_FILE" <<'PY'
import re
import sys

# ---------------- 参数 ----------------
infile = sys.argv[1]
start_str = sys.argv[2]
offset_str = sys.argv[3]
outfile = sys.argv[4]

# ---------------- 时间解析 ----------------
def parse_time(s: str) -> float:
    s = s.strip().replace("：", ":")
    sign = -1 if s.startswith("-") else 1
    if s and s[0] in "+-":
        s = s[1:]

    if ":" not in s:
        return sign * float(s)

    parts = s.split(":")
    if len(parts) == 2:  # MM:SS
        m, sec = parts
        return sign * (int(m) * 60 + float(sec))
    if len(parts) == 3:  # HH:MM:SS
        h, m, sec = parts
        return sign * (int(h) * 3600 + int(m) * 60 + float(sec))
    raise ValueError(f"无法解析时间格式: {s}")

try:
    start_sec = parse_time(start_str)
    offset = parse_time(offset_str)
except Exception as e:
    print(f"时间参数错误: {e}", file=sys.stderr)
    sys.exit(1)

# ---------------- 读取文件 ----------------
with open(infile, "r", encoding="utf-8") as f:
    lines = f.readlines()

out_lines = []

d_pattern = re.compile(r'(<d\s+[^>]*p=")([^"]+)(".*>)')
gift_pattern = re.compile(r'(<gift\s+[^>]*ts=")([^"]+)(".*>)')

# ---------------- 处理 ----------------
for line in lines:
    line_ending = '\n' if line.endswith('\n') else ''
    line = line.rstrip('\n')

    # ---- 普通弹幕 <d> ----
    m = d_pattern.search(line)
    if m:
        prefix, p_value, suffix = m.groups()
        parts = p_value.split(',')

        try:
            rel = float(parts[0])
        except Exception:
            out_lines.append(line + line_ending)
            continue

        # 只有 start_sec 及之后的弹幕才应用偏移
        if rel >= start_sec:
            new_rel = rel + offset
            if new_rel < start_sec:
                continue  # 删除偏移后提前的弹幕
            parts[0] = f"{new_rel:.3f}"

            # 修复毫秒字段（第5项）
            if len(parts) >= 5:
                try:
                    new_ms = int(parts[4]) + int(offset * 1000)
                    parts[4] = str(max(0, new_ms))
                except Exception:
                    pass

            line = f"{prefix}{','.join(parts)}{suffix}"

        # start_sec 之前的弹幕保持原样
        out_lines.append(line + line_ending)
        continue

    # ---- 礼物 <gift> ----
    m = gift_pattern.search(line)
    if m:
        prefix, ts_value, suffix = m.groups()
        try:
            ts = float(ts_value)
        except Exception:
            out_lines.append(line + line_ending)
            continue

        if ts >= start_sec:
            ts_new = ts + offset
            if ts_new < start_sec:
                continue
            ts = ts_new
            line = f"{prefix}{ts:.3f}{suffix}"

        out_lines.append(line + line_ending)
        continue

    # ---- 其他行 ----
    out_lines.append(line + line_ending)

# ---------------- 写出 ----------------
with open(outfile, "w", encoding="utf-8") as f:
    f.writelines(out_lines)

print(f"完成: 文件写入 {outfile}")
PY

echo "输出文件: $OUTPUT_FILE"
