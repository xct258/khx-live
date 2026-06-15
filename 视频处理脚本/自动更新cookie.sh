#!/bin/bash
# 自动从 GitHub 更新 B站 cookie 并同步到录播姬配置，每天凌晨 3 点重启录播姬

REPO="xct258/Documentation"
BRANCH="main"
SYNC_SCRIPT="/rec/脚本/更新录播姬配置文件.py"
RECORDER_CMD="/root/BililiveRecorder/BililiveRecorder.Cli run --bind http://*:2356 --http-basic-user ${Bililive_USER} --http-basic-pass ${Bililive_PASS} /rec/录播姬"

get_md5() {
  if command -v md5sum &> /dev/null; then
    md5sum "$1" | awk '{print $1}'
  else
    openssl dgst -md5 "$1" | awk '{print $2}'
  fi
}

download_if_changed() {
  local path="$1" file_path="$2" tmp_file
  tmp_file="/tmp/cookie_$$_$(basename "$path")"

  http_code=$(curl -s -w "%{http_code}" -o "$tmp_file" \
    -H "Authorization: token $XCT258_GITHUB_TOKEN" \
    -H "Accept: application/vnd.github.v3.raw" \
    --connect-timeout 10 -m 30 \
    "https://api.github.com/repos/${REPO}/contents/${file_path}?ref=${BRANCH}")

  [ "$http_code" != "200" ] && { rm -f "$tmp_file"; return 1; }

  if [ ! -f "$path" ]; then
    mkdir -p "$(dirname "$path")"
    mv "$tmp_file" "$path"
    return 2
  fi

  if [ "$(get_md5 "$path")" != "$(get_md5 "$tmp_file")" ]; then
    mv "$tmp_file" "$path"; return 0
  fi
  rm -f "$tmp_file"
  return 1
}

RESTART_DATE=$(date +%Y-%m-%d)

while true; do
  download_if_changed "/rec/cookies/bilibili/cookies-烦心事远离.json" "b站cookies/cookies-b站-烦心事远离.json"
  download_if_changed "/rec/cookies/bilibili/cookies-xct258-2.json" "b站cookies/cookies-b站-xct258-2.json"

  python3 "$SYNC_SCRIPT" --check
  if [ $? -eq 1 ]; then
    echo "[$(date)] cookie 已更新，写入录播姬配置"
    python3 "$SYNC_SCRIPT"
  fi

  TODAY=$(date +%Y-%m-%d)
  if [ "$RESTART_DATE" != "$TODAY" ] && [ "$(date +%H)" -ge 3 ]; then
    echo "[$(date)] 凌晨重启录播姬..."
    pkill -f "BililiveRecorder.Cli" || true
    sleep 3
    $RECORDER_CMD > /dev/null 2>&1 &
    RESTART_DATE=$TODAY
    echo "[$(date)] 录播姬已重启"
    sleep 180
  fi

  sleep 14400
done
