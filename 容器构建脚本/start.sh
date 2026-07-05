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

# intel核显驱动安装
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

# 启动 biliup(暂时不使用biliup录制，只用于上传)
#/rec/biliup/biliup server --auth > /dev/null 2>&1

#if ! pgrep -f "biliup" > /dev/null; then
#  log warn "biliup启动失败"
#else
#  log info "biliup运行中"
#fi


# 创建并启动每日视频上传备份定时任务
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
PREVIOUS_ACTIVE_FILES=""      # 录制中用来比对新增文件的“当前活跃快照”
HISTORY_ACTIVE_FILES=""       # 【新增】用来做最终存在性检测的“全量历史累加池”
declare -A MISSING_DIR_REPORTED

DEFAULT_SLEEP_TIME="5"            # 循环时间（分钟）
SCAN_FRESHNESS_MIN="20"         # find 直接查找的时间（分钟）

print_welcome_banner() {
  log info "═══════════════════════════════════════════════"
  log info "  目录监控脚本已启动/重置"
  log info "  检查间隔: ${DEFAULT_SLEEP_TIME}m"
  log info "  文件写入静默阈值: 直接使用 find 过滤 ${SCAN_FRESHNESS_MIN} 分钟"
  log info "  安全防护机制: 历史视频存在性文件级熔断自检"
  log info "═══════════════════════════════════════════════"
}

# 启动打印
print_welcome_banner

while true; do

  if [[ -f "$CONFIG_FILE" ]]; then
    source "$CONFIG_FILE"
  else
    log warn "配置文件不存在，使用默认设置"
    ENABLE_UPLOAD_SCRIPT=false
  fi

  if [[ "$ENABLE_UPLOAD_SCRIPT" != "true" ]]; then
    log info "上传备份未启用(ENABLE_UPLOAD_SCRIPT=$ENABLE_UPLOAD_SCRIPT)，跳过检查"
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

    # 直接查找 20 分钟内是否有新文件写入
    RECENT_FILES=$(find "$folder" -type f -mmin -"$SCAN_FRESHNESS_MIN" 2>/dev/null)
    if [[ -n "$RECENT_FILES" ]]; then
      ANY_RECORDING=true
      SAVED_RECENT_FILES="${SAVED_RECENT_FILES}${RECENT_FILES}"$'\n'
    fi
  done

  # 核心状态控制逻辑
  if [[ "$ANY_RECORDING" = true ]]; then
    CURRENT_ACTIVE_FILES=$(echo "$SAVED_RECENT_FILES" | sed '/^\s*$/d')
    file_count=$(echo "$CURRENT_ACTIVE_FILES" | wc -l)

    if [[ $LAST_STATUS -eq 0 ]]; then
      log info "检测到新录制启动，当前有 ${file_count} 个文件处于活跃写入状态："
      echo "$CURRENT_ACTIVE_FILES" | while read -r file; do
        log info "录制文件: $file"
      done
      LAST_STATUS=1
    else
      # 录制中，比对并追加新文件到日志
      echo "$CURRENT_ACTIVE_FILES" | while read -r file; do
        if ! echo "$PREVIOUS_ACTIVE_FILES" | grep -Fqx "$file" 2>/dev/null; then
          log info "新增文件: $file"
        fi
      done
    fi
    
    # 更新快照用于下一次比对新文件
    PREVIOUS_ACTIVE_FILES="$CURRENT_ACTIVE_FILES"
    
    # 🌟 动态更新“历史全量池”，把整场录制产生过的文件合并、去重累加进去
    if [[ -z "$HISTORY_ACTIVE_FILES" ]]; then
      HISTORY_ACTIVE_FILES="$CURRENT_ACTIVE_FILES"
    else
      HISTORY_ACTIVE_FILES=$(echo -e "${HISTORY_ACTIVE_FILES}\n${CURRENT_ACTIVE_FILES}" | sort -u)
    fi

  else
    # 进入 SCAN_FRESHNESS_MIN 分钟完全无新写入的状态
    if [[ $LAST_STATUS -eq 1 ]]; then
      
      log info "${SCAN_FRESHNESS_MIN}分钟无新写入，正在执行备份前置自检：检查本轮录制文件的存在性..."
      
      # 🛡️ 核心自检：遍历历史记录里出现过的文件，只要有一个还活在硬盘上就判定安全
      ANY_FILE_EXISTS=false
      total_checked=0
      
      while read -r file; do
        [[ -z "$file" ]] && continue
        ((total_checked++))
        if [[ -f "$file" ]]; then
          ANY_FILE_EXISTS=true
          break # 只要抓到一个活着的视频，就通过验证，不需要往下看了
        fi
      done <<< "$HISTORY_ACTIVE_FILES"

      # 根据自检结果决定是否熔断
      if [[ "$ANY_FILE_EXISTS" = false ]] && [[ $total_checked -gt 0 ]]; then
        # ❌ 触发熔断：刚才记录的所有文件其实都被删掉了，这不是下播，是用户在删目录
        log warn "【安全熔断】本轮记录的 ${total_checked} 个历史活跃文件在硬盘上已全部不存！放弃执行备份脚本。"
      else
        # ✅ 自检通过：至少有一个视频文件还在，属于正常录制完毕
        log info "自检通过（检测到有效录制产物）。直接开始执行备份脚本..."
        
        BACKUP_LOG="$LOG_DIR/录播上传备份脚本_$(date +%Y%m%d_%H%M%S).log"
        /rec/脚本/录播上传备份脚本.sh >> "$BACKUP_LOG" 2>&1 &
        (ls -t "$LOG_DIR"/*.log 2>/dev/null | tail -n +6 | xargs -r rm -f) &
      fi

      # 无论成功备份还是触发熔断，最终都重置会话，迎接下一次录制
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
STATUS_FILE="/app/.status"
touch "$STATUS_FILE"

# 引入日志函数库
source "/rec/脚本/log.sh"
LOG_BASE_DIR="/rec/logs"

if [[ -f "$CONFIG_FILE" ]]; then
  source "$CONFIG_FILE"
fi

if [[ "$ENABLE_WEBCLIP" = "true" ]]; then
  # 检查是否已安装过
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
      echo "WEBCLIP_INSTALLED=\"$(date '+%Y-%m-%d %H:%M:%S')\"" >> "$STATUS_FILE"
      log info "【成功】在线切片依赖安装完毕！"
    else
      log warn "【错误】在线切片依赖安装失败！"
      exit 1
    fi
  fi

  # 启动服务
  if [[ -f "/rec/在线切片/app.py" ]]; then
      log info "启动在线切片服务..."
      port="${WEBCLIP_PORT:-8186}"
      uvicorn app:app --host 0.0.0.0 --port "$port" --app-dir "/rec/在线切片" > /dev/null 2>&1 &
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
STATUS_FILE="/app/.status"
touch "$STATUS_FILE"

# 引入日志函数库
source "/rec/脚本/log.sh"
LOG_BASE_DIR="/rec/logs"

if [[ -f "$CONFIG_FILE" ]]; then
  source "$CONFIG_FILE"
fi

if [[ "$ENABLE_OPENCC" = "true" ]]; then
  # 检查是否已安装过
  if ! grep -q "SPEECH_INSTALLED" "$STATUS_FILE"; then
    log info "检测到开启语音识别，正在安装 AI 依赖（包体较大，请耐心等待）..."
    pip install \
      opencc \
      torch \
      faster_whisper \
    --break-system-packages > /dev/null 2>&1

    if [ $? -eq 0 ]; then
      echo "SPEECH_INSTALLED=\"$(date '+%Y-%m-%d %H:%M:%S')\"" >> "$STATUS_FILE"
      log info "【成功】语音识别依赖安装完毕！"
    else
      log warn "【错误】语音识别依赖安装失败！"
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
      log info "【成功】模型 $OPENCC_MODEL 下载完毕！"
    else
      log warn "【错误】模型 $OPENCC_MODEL 下载失败，可尝试其他模型或手动下载放到 $MODEL_DIR/$OPENCC_MODEL/"
    fi
  fi

  # 模型存在才启动服务
  if [[ -f "$MODEL_DIR/$OPENCC_MODEL/config.json" ]]; then
    if [[ -f "/rec/语音识别/app.py" ]]; then
      log info "启动语音识别服务..."
      python3 /rec/语音识别/app.py > /dev/null 2>&1 &
    fi
  else
    log warn "模型文件不存在，语音识别服务未启动，请稍后检查模型是否下载成功"
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
      /rec/脚本/自动更新cookie.sh
      break
    fi
  done
done
EOF
chmod +x "$COOKIE_SCHEDULER_SCRIPT"
"$COOKIE_SCHEDULER_SCRIPT" &

# 输出账户信息（首次强制输出到终端，后续仅记录日志）
if ! grep -q "CREDENTIALS_SHOWN" "$STATUS_FILE" 2>/dev/null; then
    log -f info "当前录播姬用户名:"
    log -f info "$Bililive_USER"
    log -f info "当前录播姬密码:"
    log -f info "$Bililive_PASS"
    echo "CREDENTIALS_SHOWN=\"$(date '+%Y-%m-%d %H:%M:%S')\"" >> "$STATUS_FILE"
else
    log info "当前录播姬用户名:"
    log info "$Bililive_USER"
    log info "当前录播姬密码:"
    log info "$Bililive_PASS"
fi
#echo "biliup默认用户名为："
#echo "biliup"
#echo "biliup密码需要登录web界面注册"

# 保持容器运行
tail -f /dev/null
