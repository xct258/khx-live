#!/bin/bash
# 单次执行：从 GitHub 更新 B站 cookie 并同步到录播姬配置

REPO="xct258/Documentation"
BRANCH="main"
SYNC_SCRIPT="/rec/脚本/更新录播姬配置文件.py"
RECORDER_CMD="/root/BililiveRecorder/BililiveRecorder.Cli run --bind http://*:2356 --http-basic-user ${Bililive_USER} --http-basic-pass ${Bililive_PASS} /rec/录播姬"
TOKEN_FILE="/root/.github_token"

# 引入日志函数库
export LOG_BASE_DIR="/rec/logs"
source "/rec/脚本/log.sh"

log info "🚀 脚本开始执行..."

# 1. 检查 Token 文件
log info "正在检查 GitHub Token 文件: $TOKEN_FILE ..."
if [ -f "$TOKEN_FILE" ]; then
  CURRENT_GITHUB_TOKEN=$(cat "$TOKEN_FILE")
  log success "成功从本地文件读取到 Token (长度: ${#CURRENT_GITHUB_TOKEN} 字符)"
else
  log fatal "未找到 Token 文件！请确保引导脚本已正确生成 $TOKEN_FILE"
  exit 1
fi

get_md5() {
  if command -v md5sum &> /dev/null; then
    md5sum "$1" | awk '{print $1}'
  else
    openssl dgst -md5 "$1" | awk '{print $2}'
  fi
}

download_if_changed() {
  local path="$1" file_path="$2" tmp_file
  local filename=$(basename "$path")
  tmp_file="/tmp/cookie_$$_$filename"

  log info "正在从 GitHub 请求下载: $file_path"
  log debug "本地目标路径: $path"

  # 请求 GitHub API 下载文件
  http_code=$(curl -s -w "%{http_code}" -o "$tmp_file" \
    -H "Authorization: token $CURRENT_GITHUB_TOKEN" \
    -H "Accept: application/vnd.github.v3.raw" \
    --connect-timeout 10 -m 30 \
    "https://api.github.com/repos/${REPO}/contents/${file_path}?ref=${BRANCH}")

  log debug "GitHub API 返回 HTTP Code: $http_code"

  if [ "$http_code" != "200" ]; then
    log warn "文件 $filename 下载失败，API未返回200。保持本地现有文件不变。"
    rm -f "$tmp_file"
    return 1
  fi

  # 情况 A：本地本来就没有这个文件（比如刚刚删除了它）
  if [ ! -f "$path" ]; then
    log debug "检测到本地不存在该文件，正在创建目录并直接写入新下载的文件..."
    mkdir -p "$(dirname "$path")"
    mv "$tmp_file" "$path"
    log success "文件 $filename 缺失，已成功补全。MD5: $(get_md5 "$path")"
    return 2 # 返回 2 代表是新下载缺失文件
  fi

  # 情况 B：本地有文件，进行 MD5 校验比对内容
  local local_md5=$(get_md5 "$path")
  local remote_md5=$(get_md5 "$tmp_file")
  log debug "本地文件 MD5: $local_md5 | 远端文件 MD5: $remote_md5"

  if [ "$local_md5" != "$remote_md5" ]; then
    mv "$tmp_file" "$path"
    log success "检测到内容有变化！已用最新的 GitHub 文件覆盖本地 $filename。"
    return 0 # 返回 0 代表内容确实更新了
  else
    log info "内容完全一致，无需覆盖本地 $filename。"
    rm -f "$tmp_file"
    return 1 # 返回 1 代表无实质变化
  fi
}

# 2. 执行下载并比对文件
download_if_changed "/rec/cookies/bilibili/cookies-烦心事远离.json" "b站cookies/cookies-b站-烦心事远离.json"
res_fanxin=$?

download_if_changed "/rec/cookies/bilibili/cookies-xct258-2.json" "b站cookies/cookies-b站-xct258-2.json"
res_xct=$?

log info "本地文件下载/比对阶段结束。"
log debug "烦心事状态码: $res_fanxin | xct258状态码: $res_xct (0:更新, 1:无变化, 2:补全)"

# 3. 移交 Python 脚本进行录播姬配置比对
log info "正在调用 Python 脚本检查录播姬内部配置是否需要更新..."

if [ ! -f "$SYNC_SCRIPT" ]; then
  log fatal "未找到 Python 同步脚本: $SYNC_SCRIPT，无法继续！"
  exit 1
fi

log debug "执行检测命令: python3 $SYNC_SCRIPT --check"

# 1. 捕获检测模式的输出（使用 2>&1 将报错和正常输出合并后逐行读取）
python3 "$SYNC_SCRIPT" --check 2>&1 | while IFS= read -r line; do
  log debug "Python检测: $line"
done
# 核心技巧：通过 PIPESTATUS[0] 拿到管道前 python 真实的 exit code
py_exit_code=${PIPESTATUS[0]}

log info "配置检测完毕，Python 退出码: $py_exit_code (1=需更新, 0=已最新)"

if [ $py_exit_code -eq 1 ]; then
  log warn "准备写入新配置，正在通知录播姬安全退出进程..."
  pkill -f "BililiveRecorder.Cli" || true
  
  timeout=30
  while pgrep -f "BililiveRecorder.Cli" > /dev/null && [ "$timeout" -gt 0 ]; do
    log debug "等待录播姬释放文件锁... 剩余 ${timeout} 秒"
    sleep 1
    timeout=$((timeout - 1))
  done

  if pgrep -f "BililiveRecorder.Cli" > /dev/null; then
    log error "录播姬未能成功停止！强制跳过本次配置写入以防文件损坏。"
  else
    log info "录播姬已安全停止，开始将新 Cookie 写入配置文件..."
    
    # 2. 捕获执行模式的输出，并进行智能日志级别分发
    python3 "$SYNC_SCRIPT" 2>&1 | while IFS= read -r line; do
      if [[ "$line" == *"[错误]"* || "$line" == *"Error"* || "$line" == *"Exception"* ]]; then
        log error "Python: $line"
      else
        log info "Python: $line"
      fi
    done
    write_exit_code=${PIPESTATUS[0]}

    # 3. 校验写入是否真的成功
    if [ $write_exit_code -eq 0 ]; then
      log success "写入录播姬配置成功！"
    else
      log error "配置写入似乎出现异常 (Python 退出码: $write_exit_code)"
    fi

    log info "正在重新拉起录播姬进程..."
    $RECORDER_CMD > /dev/null 2>&1 &
    log success "录播姬启动指令已发送。"
  fi
else
  log info "录播姬内部的配置已经是最新状态，本次无需重写配置文件。"
fi

log info "🏁 脚本单次运行结束。"