#!/bin/bash

# 启动时把构建时 version 信息移动到 /rec/version.txt
mkdir -p /rec
if [ -f /app/version.txt ]; then
  cp /app/version.txt /rec/version.txt
fi

mkdir -p /rec/biliup/脚本
mkdir -p /rec/录播姬
mkdir -p /rec/脚本
mkdir -p /rec/apps
mkdir -p /rec/在线切片
mkdir -p /rec/在线切片/static
mkdir -p /rec/在线切片/templates
mkdir -p /rec/语音识别

TOKEN_FILE="/app/.github_token"
# 1. 如果环境变量传入了 Token，优先使用并持久化保存到文件
if [ -n "$XCT258_GITHUB_TOKEN" ]; then
  echo "$XCT258_GITHUB_TOKEN" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE" # 设置权限，保护私密信息
fi
# 2. 统一读取 Token（用于赋值给后续操作，即使容器重启未传环境变量也能读到）
CURRENT_GITHUB_TOKEN=""
if [ -f "$TOKEN_FILE" ]; then
  CURRENT_GITHUB_TOKEN=$(cat "$TOKEN_FILE")
fi

# 配置文件单独处理
if [ ! -f /rec/config.conf ]; then
  cp /opt/bililive/config/config.conf /rec/config.conf
fi

# STATUS_FILE: 幂等标记文件，记录一次性重操作是否已完成，避免容器重启重复执行
# 路径在容器内 /app/.status（重启保留，重建重置）；成功后以 KEY="时间" 追加标记，用 grep -q 判断跳过
STATUS_FILE="/app/.status"
touch "$STATUS_FILE"
source /rec/config.conf

# 在线切片安装
if [ ! -f /rec/在线切片/app.py ]; then
  cp /opt/webclip/app.py /rec/在线切片/app.py
fi

# 在线切片static静态文件安装
for file in /opt/webclip/static/*; do
  filename=$(basename "$file")
  target="/rec/在线切片/static/$filename"
  if [ -f "$file" ] && [ ! -f "$target" ]; then
    cp "$file" "$target"
  fi
done
# 在线切片templates模板文件安装
for file in /opt/webclip/templates/*; do
  filename=$(basename "$file")
  target="/rec/在线切片/templates/$filename"
  if [ -f "$file" ] && [ ! -f "$target" ]; then
    cp "$file" "$target"
  fi
done

# 语音识别安装
for file in /opt/opencc/*; do
  filename=$(basename "$file")
  target="/rec/语音识别/$filename"
  if [ -f "$file" ] && [ ! -f "$target" ]; then
    cp "$file" "$target"
  fi
done

# biliup安装
if [ ! -f /rec/biliup/biliup ]; then
  cp /root/biliup/biliup /rec/biliup/biliup
fi

# 复制 /opt/bililive/biliup 到 /rec/biliup/脚本
for file in /opt/bililive/biliup/*; do
  filename=$(basename "$file")
  target="/rec/biliup/脚本/$filename"
  if [ -f "$file" ] && [ ! -f "$target" ]; then
    cp "$file" "$target"
  fi
done

# 复制 /opt/bililive/scripts 到 /rec/脚本
for file in /opt/bililive/scripts/*; do
  filename=$(basename "$file")
  target="/rec/脚本/$filename"
  if [ -f "$file" ] && [ ! -f "$target" ]; then
    cp "$file" "$target"
  fi
done

# 复制 /opt/bililive/apps 到 /rec/apps
for file in /opt/bililive/apps/*; do
  filename=$(basename "$file")
  target="/rec/apps/$filename"
  if [ -f "$file" ] && [ ! -f "$target" ]; then
    cp "$file" "$target"
  fi
done

source /rec/脚本/log.sh
LOG_BASE_DIR=/rec/logs
LOG_APP_NAME="容器主脚本"

# intel核显驱动安装（一次性：查 STATUS_FILE 有无 INTEL_GPU_INSTALLED，有则跳过）
if [[ "$ENABLE_INTEL_GPU" = "true" ]]; then
  if ! grep -q "INTEL_GPU_INSTALLED" "$STATUS_FILE"; then
    log info "检测到开启 Intel 核显加速，正在安装驱动..."
    
    apt update > /dev/null 2>&1
    apt install -y gpg wget > /dev/null 2>&1
    wget -qO - https://repositories.intel.com/gpu/intel-graphics.key | gpg --dearmor --output /usr/share/keyrings/intel-graphics.gpg > /dev/null 2>&1
    echo "deb [arch=amd64,i386 signed-by=/usr/share/keyrings/intel-graphics.gpg] https://repositories.intel.com/gpu/ubuntu jammy client" > /etc/apt/sources.list.d/intel-gpu-jammy.list
    apt update > /dev/null 2>&1
    apt install -y intel-media-va-driver-non-free libmfx1 libmfxgen1 libvpl2 va-driver-all vainfo > /dev/null 2>&1

    if [ $? -eq 0 ]; then
      CURRENT_TIME=$(date "+%Y-%m-%d %H:%M:%S")
      # 安装成功才打标记，下次重启 grep 到即跳过
      echo "INTEL_GPU_INSTALLED=\"$CURRENT_TIME\"" >> "$STATUS_FILE"
      log info "【成功】Intel 核显驱动安装完毕！"
    else
      log warn "【错误】Intel 核显驱动安装失败，不写入状态。"
      exit 1
    fi
  else
    log info "【跳过】Intel 核显驱动已于历史记录中安装，无需重复检测。"
  fi
fi

# 下载私有配置文件（需 GitHub Token）
if [ -n "$CURRENT_GITHUB_TOKEN" ]; then

  # 检查是否有文件缺失，只有缺失时才下载
  missing_file=false

  [ ! -f "/root/.config/rclone/rclone.conf" ] && missing_file=true
  [ ! -f "/rec/cookies/bilibili/cookies-烦心事远离.json" ] && missing_file=true
  [ ! -f "/rec/cookies/bilibili/cookies-xct258-2.json" ] && missing_file=true

  if $missing_file; then
    log info "检测到 CURRENT_GITHUB_TOKEN..."

    mkdir -p /root/.config/rclone
    mkdir -p /rec/cookies/bilibili

    download_all_success=true

    if [ ! -f "/root/.config/rclone/rclone.conf" ]; then
      wget --quiet --header="Authorization: token $CURRENT_GITHUB_TOKEN" \
        -O "/root/.config/rclone/rclone.conf" \
        "https://raw.githubusercontent.com/xct258/Documentation/refs/heads/main/rclone/rclone.conf" || download_all_success=false
    fi

    if [ ! -f "/rec/cookies/bilibili/cookies-烦心事远离.json" ]; then
      wget --quiet --header="Authorization: token $CURRENT_GITHUB_TOKEN" \
        -O "/rec/cookies/bilibili/cookies-烦心事远离.json" \
        "https://raw.githubusercontent.com/xct258/Documentation/refs/heads/main/b站cookies/cookies-b站-烦心事远离.json" || download_all_success=false
    fi

    if [ ! -f "/rec/cookies/bilibili/cookies-xct258-2.json" ]; then
      wget --quiet --header="Authorization: token $CURRENT_GITHUB_TOKEN" \
        -O "/rec/cookies/bilibili/cookies-xct258-2.json" \
        "https://raw.githubusercontent.com/xct258/Documentation/refs/heads/main/b站cookies/cookies-b站-xct258-2.json" || download_all_success=false
    fi

    if $download_all_success; then
      log info "私有配置文件全部已下载完成。"
    else
      log warn "私有配置文件部分下载失败，请检查 GitHub Token 或网络连接。"
    fi
  fi
fi

# 初始化登录账户密码
if [ -f /root/.credentials ]; then
  source /root/.credentials
else
  touch /root/.credentials

  if [ -z "$Bililive_USER" ]; then
    Bililive_USER="xct258"
  fi
  echo Bililive_USER="$Bililive_USER" >> /root/.credentials

  if [ -z "$Bililive_PASS" ]; then
    Bililive_PASS=$(openssl rand -base64 12)
  fi
  echo Bililive_PASS="$Bililive_PASS" >> /root/.credentials
fi

# 启动 BililiveRecorder
/root/BililiveRecorder/BililiveRecorder.Cli run --bind "http://*:2356" --http-basic-user "$Bililive_USER" --http-basic-pass "$Bililive_PASS" "/rec/录播姬" > /dev/null 2>&1 &

# 检查 Bililive 是否启动成功
sleep 4
if ! pgrep -f "BililiveRecorder.Cli" > /dev/null; then
  log warn "录播姬启动失败"
else
  log info "录播姬运行中，正在检测配置更新需求..."

  # 先检测是否有配置更新需求
  UPDATE_SCRIPT="/rec/脚本/更新录播姬配置文件.py"
  if [ ! -f "$UPDATE_SCRIPT" ]; then
    UPDATE_SCRIPT="/opt/bililive/scripts/更新录播姬配置文件.py"
  fi

  if [ ! -f "$UPDATE_SCRIPT" ]; then
    log info "未找到更新脚本：$UPDATE_SCRIPT" >&2
    UPDATE_RESULT=253
  else
    log info "检测是否需要更新录播姬配置：$UPDATE_SCRIPT"
    if command -v python3 >/dev/null 2>&1; then
      UPDATE_OUTPUT=$(python3 "$UPDATE_SCRIPT" --check)
      UPDATE_RESULT=$?
      log info "更新脚本输出:"
      log info "$UPDATE_OUTPUT"
    elif command -v python >/dev/null 2>&1; then
      UPDATE_OUTPUT=$(python "$UPDATE_SCRIPT" --check)
      UPDATE_RESULT=$?
      log info "更新脚本输出:"
      log info "$UPDATE_OUTPUT"
    else
      log warn "未找到 python，无法执行更新脚本"
      UPDATE_RESULT=254
    fi
  fi

  if [ "$UPDATE_RESULT" -eq 0 ]; then
    log info "无配置更新，保持当前录播姬进程。"  # 不关闭/不重启
  elif [ "$UPDATE_RESULT" -eq 1 ]; then
    log info "检测到配置需要更新，准备停止录播姬。"
    pkill -f "BililiveRecorder.Cli" || true

    timeout=30
    while pgrep -f "BililiveRecorder.Cli" > /dev/null && [ "$timeout" -gt 0 ]; do
      sleep 1
      timeout=$((timeout - 1))
    done

    if pgrep -f "BililiveRecorder.Cli" > /dev/null; then
      log warn "错误: 录播姬未能停止，后续不再尝试。"
    else
      log info "录播姬已停止，执行一次更新脚本以写入配置。"
      if command -v python3 >/dev/null 2>&1; then
        UPDATE_OUTPUT=$(python3 "$UPDATE_SCRIPT")
        UPDATE_RESULT2=$?
        log info "更新脚本输出:"
        log info "$UPDATE_OUTPUT"
      elif command -v python >/dev/null 2>&1; then
        UPDATE_OUTPUT=$(python "$UPDATE_SCRIPT")
        UPDATE_RESULT2=$?
        log info "更新脚本输出:"
        log info "$UPDATE_OUTPUT"
      else
        log warn "未找到 python，无法执行更新脚本"
        UPDATE_RESULT2=254
      fi
      if [ "$UPDATE_RESULT2" -eq 0 ]; then
        log info "更新脚本执行成功（exit=$UPDATE_RESULT2）"
      else
        log warn "警告：更新脚本执行失败（exit=$UPDATE_RESULT2）"
      fi

      log info "重新启动录播姬..."
      /root/BililiveRecorder/BililiveRecorder.Cli run --bind "http://*:2356" --http-basic-user "$Bililive_USER" --http-basic-pass "$Bililive_PASS" "/rec/录播姬" > /dev/null 2>&1 &
      sleep 4
      if pgrep -f "BililiveRecorder.Cli" > /dev/null; then
        log info "录播姬重启成功"
      else
        log warn "录播姬重启失败"
      fi
    fi
  else
    log warn "更新脚本检测异常（exit=$UPDATE_RESULT），保持当前录播姬进程不改动。"
  fi
fi

# 创建并启动视频上传备份监控（常驻轮询：每5分钟检查，录制结束自动触发备份，非cron每日任务）
SCHEDULER_SCRIPT="/usr/local/bin/执行视频备份脚本.sh"
cat << 'EOF' > "$SCHEDULER_SCRIPT"
#!/bin/bash

CONFIG_FILE="/rec/config.conf"
LOG_DIR="/rec/logs/上传备份脚本执行输出"
mkdir -p "$LOG_DIR"

source "/rec/脚本/log.sh"
LOG_BASE_DIR="/rec/logs"
LOG_APP_NAME="备份执行脚本"
LOG_MAX_FILES=100

LAST_STATUS=0
PREVIOUS_ACTIVE_FILES=""      # 上轮活跃文件快照，用于比对新增文件
HISTORY_ACTIVE_FILES=""       # 本轮全量历史池，用于下播前存在性熔断自检
declare -A MISSING_DIR_REPORTED  # 缺失目录仅警告一次

DEFAULT_SLEEP_TIME="5"            # 轮询间隔（分钟）
SCAN_FRESHNESS_MIN="20"         # 判定“正在录制”的文件新鲜度窗口（分钟）

print_welcome_banner() {
  log info "═══════════════════════════════════════════════"
  log info "备份监控就绪"
  log info "检查间隔: ${DEFAULT_SLEEP_TIME}m"
  log info "静默阈值: ${SCAN_FRESHNESS_MIN}分钟无写入判下播"
  log info "熔断自检: 历史文件全消失则跳过备份"
  log info "═══════════════════════════════════════════════"
}

# 启动横幅
print_welcome_banner

while true; do
  # 每轮重载配置，支持不重启容器改开关

  if [[ -f "$CONFIG_FILE" ]]; then
    source "$CONFIG_FILE"
  else
    log warn "配置文件不存在，使用默认设置"
    ENABLE_UPLOAD_SCRIPT=false
  fi

  if [[ "$ENABLE_UPLOAD_SCRIPT" != "true" ]]; then
    # 未启用时降为debug，避免每5分钟刷一条info淹没正常日志
    log debug "备份未启用(ENABLE_UPLOAD_SCRIPT=$ENABLE_UPLOAD_SCRIPT)，跳过本轮"
    sleep "$((DEFAULT_SLEEP_TIME * 60))"
    continue
  fi

  ANY_RECORDING=false
  SAVED_RECENT_FILES=""
  
  for folder in "${source_folders[@]}"; do
    if [[ ! -d "$folder" ]]; then
      if [[ -z "${MISSING_DIR_REPORTED[$folder]}" ]]; then
        log warn "监控目录 $folder 不存在，跳过检查（仅首次警告）"
        MISSING_DIR_REPORTED[$folder]=1
      fi
      continue
    fi

    # 扫描各监控目录：20分钟内有新写入即判定为录制中
    RECENT_FILES=$(find "$folder" -type f -mmin -"$SCAN_FRESHNESS_MIN" 2>/dev/null)
    if [[ -n "$RECENT_FILES" ]]; then
      ANY_RECORDING=true
      SAVED_RECENT_FILES="${SAVED_RECENT_FILES}${RECENT_FILES}"$'\n'
    fi
  done

  # 状态机：LAST_STATUS 0=空闲，1=录制中；仅 1->0 跃迁时触发备份
  if [[ "$ANY_RECORDING" = true ]]; then
    CURRENT_ACTIVE_FILES=$(echo "$SAVED_RECENT_FILES" | sed '/^\s*$/d')
    file_count=$(echo "$CURRENT_ACTIVE_FILES" | wc -l)

    if [[ $LAST_STATUS -eq 0 ]]; then
      # 录制开始用success醒目，文件清单降为debug避免刷屏
      log success "录制开始：${file_count}个活跃文件"
      echo "$CURRENT_ACTIVE_FILES" | while read -r file; do
        log debug "录制文件: $file"
      done
      LAST_STATUS=1
    else
      # 录制中：与上轮快照比对，仅打印新增文件（debug避免每轮刷屏）
      echo "$CURRENT_ACTIVE_FILES" | while read -r file; do
        if ! echo "$PREVIOUS_ACTIVE_FILES" | grep -Fqx "$file" 2>/dev/null; then
          log debug "新增文件: $file"
        fi
      done
    fi
    
    # 更新快照供下一轮比对
    PREVIOUS_ACTIVE_FILES="$CURRENT_ACTIVE_FILES"
    
    # 累加本轮全量历史（去重），供下播熔断自检用
    if [[ -z "$HISTORY_ACTIVE_FILES" ]]; then
      HISTORY_ACTIVE_FILES="$CURRENT_ACTIVE_FILES"
    else
      HISTORY_ACTIVE_FILES=$(echo -e "${HISTORY_ACTIVE_FILES}\n${CURRENT_ACTIVE_FILES}" | sort -u)
    fi

  else
    # 无新写入：仅处理 1->0 的下播瞬间
    if [[ $LAST_STATUS -eq 1 ]]; then
      
      log info "下播判定：${SCAN_FRESHNESS_MIN}分钟无写入，自检历史文件存在性..."
      
      # 熔断自检：历史池中只要还有一个文件存在，即正常下播；全消失则是人为删除，放弃备份
      ANY_FILE_EXISTS=false
      total_checked=0
      
      while read -r file; do
        [[ -z "$file" ]] && continue
        ((total_checked++))
        if [[ -f "$file" ]]; then
          ANY_FILE_EXISTS=true
          break # 命中一个即通过，无需全量扫描
        fi
      done <<< "$HISTORY_ACTIVE_FILES"

      # 熔断：历史文件全部消失，疑似人为删除，跳过备份
      if [[ "$ANY_FILE_EXISTS" = false ]] && [[ $total_checked -gt 0 ]]; then
        # 熔断分支：warn醒目，带数量便于排查
        log warn "安全熔断：${total_checked}个历史文件全消失，疑似人为删除，跳过备份"
      else
        # 正常下播：异步执行备份，日志按时间命名，仅保留最新5份
        BACKUP_LOG="$LOG_DIR/录播上传备份脚本_$(date +%Y%m%d_%H%M%S).log"
        if [[ ! -x "/rec/脚本/录播上传备份脚本.sh" ]]; then
          log error "备份脚本缺失/不可执行：/rec/脚本/录播上传备份脚本.sh，跳过本轮"
        else
          log success "自检通过，触发备份：$BACKUP_LOG"
          /rec/脚本/录播上传备份脚本.sh >> "$BACKUP_LOG" 2>&1 &
          (ls -t "$LOG_DIR"/*.log 2>/dev/null | tail -n +6 | xargs -r rm -f) &
        fi
      fi

      # 会话重置：无论备份或熔断，均清空状态迎接下一场录制
      log_reset_session
      print_welcome_banner
      
      LAST_STATUS=0
      PREVIOUS_ACTIVE_FILES=""
      HISTORY_ACTIVE_FILES=""
    fi
  fi

  sleep "$((DEFAULT_SLEEP_TIME * 60))"
done
EOF

chmod +x "$SCHEDULER_SCRIPT"
"$SCHEDULER_SCRIPT" &

# 创建webclip在线切片服务的定时任务
WEBCLIP_SCHEDULER_SCRIPT="/usr/local/bin/在线切片启动脚本.sh"
cat << 'EOF' > "$WEBCLIP_SCHEDULER_SCRIPT"
#!/bin/bash
CONFIG_FILE="/rec/config.conf"
# STATUS_FILE: 幂等标记文件，与主脚本共用 /app/.status，用于跳过已完成的在线切片依赖安装
STATUS_FILE="/app/.status"
touch "$STATUS_FILE"

# 引入日志函数库
source "/rec/脚本/log.sh"
LOG_BASE_DIR="/rec/logs"

if [[ -f "$CONFIG_FILE" ]]; then
  source "$CONFIG_FILE"
fi

if [[ "$ENABLE_WEBCLIP" = "true" ]]; then
  # 检查是否已安装过（查 STATUS_FILE 有无 WEBCLIP_INSTALLED）
  if ! grep -q "WEBCLIP_INSTALLED" "$STATUS_FILE"; then
    log info "检测到开启在线切片，正在安装 Web 依赖..."
    pip install \
      fastapi \
      uvicorn[standard] \
      jinja2 \
      pydantic \
      python-multipart \
    --break-system-packages > /dev/null 2>&1

    if [ $? -eq 0 ]; then
      # 安装成功才打标记，下次重启 grep 到即跳过安装、直接启动服务
      echo "WEBCLIP_INSTALLED=\"$(date '+%Y-%m-%d %H:%M:%S')\"" >> "$STATUS_FILE"
      log success "在线切片依赖安装成功"
    else
      log error "在线切片依赖安装失败"
      exit 1
    fi
  fi

  # 启动服务并确认是否成功
  if [[ ! -f "/rec/在线切片/app.py" ]]; then
    log error "在线切片启动失败：缺失 /rec/在线切片/app.py"
  else
    log info "正在启动在线切片服务..."
    port="${WEBCLIP_PORT:-8186}"
    uvicorn app:app --host 0.0.0.0 --port "$port" --app-dir "/rec/在线切片" > /dev/null 2>&1 &
    sleep 3
    if pgrep -f "uvicorn.*app:app" > /dev/null; then
      log success "在线切片启动成功：端口 $port"
    else
      log error "在线切片启动失败：uvicorn进程不存在"
    fi
  fi
fi
EOF
chmod +x "$WEBCLIP_SCHEDULER_SCRIPT"
"$WEBCLIP_SCHEDULER_SCRIPT" &

# 创建语音识别服务的定时任务
OPENCC_SCHEDULER_SCRIPT="/usr/local/bin/语音识别启动脚本.sh"
cat << 'EOF' > "$OPENCC_SCHEDULER_SCRIPT"
#!/bin/bash
CONFIG_FILE="/rec/config.conf"
# STATUS_FILE: 幂等标记文件，与主脚本共用 /app/.status，用于跳过已完成的语音识别依赖安装
STATUS_FILE="/app/.status"
touch "$STATUS_FILE"

# 引入日志函数库
source "/rec/脚本/log.sh"
LOG_BASE_DIR="/rec/logs"

if [[ -f "$CONFIG_FILE" ]]; then
  source "$CONFIG_FILE"
fi

if [[ "$ENABLE_OPENCC" = "true" ]]; then
  # 检查是否已安装过（查 STATUS_FILE 有无 SPEECH_INSTALLED）
  if ! grep -q "SPEECH_INSTALLED" "$STATUS_FILE"; then
    log info "检测到开启语音识别，正在安装 AI 依赖（包体较大，请耐心等待）..."
    pip install \
      opencc \
      torch \
      faster_whisper \
    --break-system-packages > /dev/null 2>&1

    if [ $? -eq 0 ]; then
      # 安装成功才打标记，下次重启 grep 到即跳过安装、直接走模型检查和启动
      echo "SPEECH_INSTALLED=\"$(date '+%Y-%m-%d %H:%M:%S')\"" >> "$STATUS_FILE"
      log success "语音识别依赖安装成功"
    else
      log error "语音识别依赖安装失败"
      exit 1
    fi
  fi

  # 检查并自动下载模型
  OPENCC_MODEL="${OPENCC_MODEL:-large-v3-turbo}"
  MODEL_DIR="/rec/语音识别/models"
  mkdir -p "$MODEL_DIR"
  if [ ! -f "$MODEL_DIR/$OPENCC_MODEL/config.json" ]; then
    log info "检测到模型文件不存在，正在下载模型 $OPENCC_MODEL（包体较大，请耐心等待）..."
    HF_BASE="https://huggingface.co"
    case "$OPENCC_MODEL" in
      tiny)     REPO="Systran/faster-whisper-tiny" ;;
      base)     REPO="Systran/faster-whisper-base" ;;
      small)    REPO="Systran/faster-whisper-small" ;;
      medium)   REPO="Systran/faster-whisper-medium" ;;
      large-v2) REPO="Systran/faster-whisper-large-v2" ;;
      large-v3) REPO="Systran/faster-whisper-large-v3" ;;
      large-v3-turbo|turbo) REPO="Systran/faster-whisper-large-v3" ;;
      *)        REPO="$OPENCC_MODEL" ;;
    esac
    mkdir -p "$MODEL_DIR/$OPENCC_MODEL"
    cd "$MODEL_DIR/$OPENCC_MODEL"
    wget --continue --timeout=30 -q "$HF_BASE/$REPO/resolve/main/config.json"
    wget --continue --timeout=30 -q "$HF_BASE/$REPO/resolve/main/tokenizer.json"
    wget --continue --timeout=30 -q "$HF_BASE/$REPO/resolve/main/vocabulary.json"
    wget --continue --timeout=30 -q "$HF_BASE/$REPO/resolve/main/preprocessor_config.json"
    wget --continue --timeout=30 -q "$HF_BASE/$REPO/resolve/main/model.bin"
    if [ $? -eq 0 ] && [ -f config.json ] && [ -f model.bin ] && [ -f vocabulary.json ] && [ -f preprocessor_config.json ]; then
      log success "模型 $OPENCC_MODEL 下载成功"
    else
      log error "模型 $OPENCC_MODEL 下载失败，可尝试其他模型或手动下载放到 $MODEL_DIR/$OPENCC_MODEL/"
    fi
  fi

  # 启动服务并确认是否成功
  if [[ ! -f "$MODEL_DIR/$OPENCC_MODEL/config.json" ]]; then
    log error "语音识别启动失败：模型文件缺失"
  elif [[ ! -f "/rec/语音识别/app.py" ]]; then
    log error "语音识别启动失败：缺失 /rec/语音识别/app.py"
  else
    log info "正在启动语音识别服务..."
    python3 /rec/语音识别/app.py > /dev/null 2>&1 &
    sleep 3
    if pgrep -f "/rec/语音识别/app.py" > /dev/null; then
      log success "语音识别启动成功：模型 $OPENCC_MODEL"
    else
      log error "语音识别启动失败：进程不存在"
    fi
  fi
fi
EOF
chmod +x "$OPENCC_SCHEDULER_SCRIPT"
"$OPENCC_SCHEDULER_SCRIPT" &

# 创建每日 cookie 更新调度器（凌晨3点触发，有录制则每小时重试）
COOKIE_SCHEDULER_SCRIPT="/usr/local/bin/cookie每日更新.sh"
cat << 'EOF' > "$COOKIE_SCHEDULER_SCRIPT"
#!/bin/bash
source "/rec/脚本/log.sh"
LOG_BASE_DIR="/rec/logs"
SCAN_FRESHNESS_MIN=20

is_recording() {
  source /rec/config.conf
  for folder in "${source_folders[@]}"; do
    if [[ -d "$folder" ]] && [[ -n "$(find "$folder" -type f -mmin -$SCAN_FRESHNESS_MIN -print -quit 2>/dev/null)" ]]; then
      return 0
    fi
  done
  return 1
}

sleep_until_3am() {
  local now target
  now=$(date +%s)
  target=$(date -d "today 03:00" +%s 2>/dev/null)
  if (( now >= target )); then
    target=$(date -d "tomorrow 03:00" +%s 2>/dev/null)
  fi
  sleep "$(( target - now ))"
}

while true; do
  sleep_until_3am
  while true; do
    if is_recording; then
      log info "录制中，cookie 更新延后1小时..."
      sleep 3600
    else
      log info "未检测到录制，更新 cookies..."
      # 存在性检查：脚本缺失则记error并等下一个3点，避免每小时空转
      if [[ ! -x "/rec/脚本/自动更新cookie.sh" ]]; then
        log error "cookie更新跳过：缺失/不可执行 /rec/脚本/自动更新cookie.sh"
        break
      fi
      /rec/脚本/自动更新cookie.sh
      COOKIE_RESULT=$?
      if [[ "$COOKIE_RESULT" -eq 0 ]]; then
        log success "cookie更新成功"
      else
        log error "cookie更新失败：exit=$COOKIE_RESULT"
      fi
      break
    fi
  done
done
EOF
chmod +x "$COOKIE_SCHEDULER_SCRIPT"
"$COOKIE_SCHEDULER_SCRIPT" &

# 输出账户信息（一次性：查 STATUS_FILE 有无 CREDENTIALS_SHOWN，无则强制输出到终端并打标记，有则仅记日志）
if ! grep -q "CREDENTIALS_SHOWN" "$STATUS_FILE" 2>/dev/null; then
    log -f info "当前录播姬用户名:"
    log -f info "$Bililive_USER"
    log -f info "当前录播姬密码:"
    log -f info "$Bililive_PASS"
    # 写入标记，下次重启不再强制输出到终端
    echo "CREDENTIALS_SHOWN=\"$(date '+%Y-%m-%d %H:%M:%S')\"" >> "$STATUS_FILE"
else
    log info "当前录播姬用户名:"
    log info "$Bililive_USER"
    log info "当前录播姬密码:"
    log info "$Bililive_PASS"
fi

# 保持容器运行
tail -f /dev/null
