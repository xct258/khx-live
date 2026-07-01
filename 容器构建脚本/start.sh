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

# =====================================================================
# 1. 语音识别依赖安装
# =====================================================================
if [[ "$ENABLE_OPENCC" = "true" ]]; then
    # 检查状态文件中是否包含 SPEECH_INSTALLED 标记
    if ! grep -q "SPEECH_INSTALLED" "$STATUS_FILE"; then
        echo "========================================="
        echo "检测到开启语音识别，正在安装 AI 依赖（包体较大，请耐心等待）..."
        echo "========================================="
        
        pip install \
            opencc \
            torch \
            faster_whisper \
            --break-system-packages

        # 判断上一步 pip 是否成功
        if [ $? -eq 0 ]; then
            CURRENT_TIME=$(date "+%Y-%m-%d %H:%M:%S")
            # 将运行时间写入状态文件
            echo "SPEECH_INSTALLED=\"$CURRENT_TIME\"" >> "$STATUS_FILE"
            echo "【成功】语音识别依赖安装完毕！"
        else
            echo "【错误】语音识别依赖安装失败，不写入状态。"
            exit 1
        fi
    else
        echo "【跳过】语音识别依赖已于历史记录中安装，无需重复检测。"
    fi
fi

# =====================================================================
# 2. 在线切片依赖安装
# =====================================================================
if [[ "$ENABLE_WEBCLIP" = "true" ]]; then
    # 检查状态文件中是否包含 WEBCLIP_INSTALLED 标记
    if ! grep -q "WEBCLIP_INSTALLED" "$STATUS_FILE"; then
        echo "========================================="
        echo "检测到开启在线切片，正在安装 Web 依赖..."
        echo "========================================="
        
        pip install \
            fastapi \
            uvicorn[standard] \
            jinja2 \
            pydantic \
            python-multipart \
            --break-system-packages

        # 判断上一步 pip 是否成功
        if [ $? -eq 0 ]; then
            CURRENT_TIME=$(date "+%Y-%m-%d %H:%M:%S")
            # 将运行时间追加到同一个状态文件
            echo "WEBCLIP_INSTALLED=\"$CURRENT_TIME\"" >> "$STATUS_FILE"
            echo "【成功】在线切片依赖安装完毕！"
        else
            echo "【错误】在线切片依赖安装失败，不写入状态。"
            exit 1
        fi
    else
        echo "【跳过】在线切片依赖已于历史记录中安装，无需重复检测。"
    fi
fi

# intel核显驱动安装
if [[ "$ENABLE_INTEL_GPU" = "true" ]]; then
  if ! grep -q "INTEL_GPU_INSTALLED" "$STATUS_FILE"; then
    echo "========================================="
    echo "检测到开启 Intel 核显加速，正在安装驱动..."
    echo "========================================="
    
    apt update
    apt install -y gpg wget
    wget -qO - https://repositories.intel.com/gpu/intel-graphics.key | gpg --dearmor --output /usr/share/keyrings/intel-graphics.gpg
    echo "deb [arch=amd64,i386 signed-by=/usr/share/keyrings/intel-graphics.gpg] https://repositories.intel.com/gpu/ubuntu jammy client" | tee /etc/apt/sources.list.d/intel-gpu-jammy.list
    apt update
    apt install -y intel-media-va-driver-non-free libmfx1 libmfxgen1 libvpl2 va-driver-all vainfo

    if [ $? -eq 0 ]; then
      CURRENT_TIME=$(date "+%Y-%m-%d %H:%M:%S")
      echo "INTEL_GPU_INSTALLED=\"$CURRENT_TIME\"" >> "$STATUS_FILE"
      echo "【成功】Intel 核显驱动安装完毕！"
    else
      echo "【错误】Intel 核显驱动安装失败，不写入状态。"
      exit 1
    fi
  else
    echo "【跳过】Intel 核显驱动已于历史记录中安装，无需重复检测。"
  fi
fi

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

# 下载私有配置文件（需 GitHub Token）
if [ -n "$CURRENT_GITHUB_TOKEN" ]; then

  # 检查是否有文件缺失，只有缺失时才下载
  missing_file=false

  [ ! -f "/root/.config/rclone/rclone.conf" ] && missing_file=true
  [ ! -f "/rec/cookies/bilibili/cookies-烦心事远离.json" ] && missing_file=true
  [ ! -f "/rec/cookies/bilibili/cookies-xct258-2.json" ] && missing_file=true

  if $missing_file; then
    echo "检测到 CURRENT_GITHUB_TOKEN..."

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
      echo "✅ 私有配置文件全部已下载完成。"
    else
      echo "⚠️ 私有配置文件部分下载失败，请检查 GitHub Token 或网络连接。"
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
  echo "------------------------------------"
  echo "$(date)"
  echo "录播姬启动失败"
  echo "------------------------------------"
else
  echo "------------------------------------"
  echo "$(date)"
  echo "录播姬运行中，正在检测配置更新需求..."
  echo "------------------------------------"

  # 先检测是否有配置更新需求
  UPDATE_SCRIPT="/rec/脚本/更新录播姬配置文件.py"
  if [ ! -f "$UPDATE_SCRIPT" ]; then
    UPDATE_SCRIPT="/opt/bililive/scripts/更新录播姬配置文件.py"
  fi

  if [ ! -f "$UPDATE_SCRIPT" ]; then
    echo "未找到更新脚本：$UPDATE_SCRIPT" >&2
    UPDATE_RESULT=253
  else
    echo "检测是否需要更新录播姬配置：$UPDATE_SCRIPT"
    if command -v python3 >/dev/null 2>&1; then
      python3 "$UPDATE_SCRIPT" --check
      UPDATE_RESULT=$?
    elif command -v python >/dev/null 2>&1; then
      python "$UPDATE_SCRIPT" --check
      UPDATE_RESULT=$?
    else
      echo "未找到 python，无法执行更新脚本"
      UPDATE_RESULT=254
    fi
  fi

  if [ "$UPDATE_RESULT" -eq 0 ]; then
    echo "无配置更新，保持当前录播姬进程。"  # 不关闭/不重启
  elif [ "$UPDATE_RESULT" -eq 1 ]; then
    echo "检测到配置需要更新，准备停止录播姬。"
    pkill -f "BililiveRecorder.Cli" || true

    timeout=30
    while pgrep -f "BililiveRecorder.Cli" > /dev/null && [ "$timeout" -gt 0 ]; do
      sleep 1
      timeout=$((timeout - 1))
    done

    if pgrep -f "BililiveRecorder.Cli" > /dev/null; then
      echo "错误: 录播姬未能停止，后续不再尝试。"
    else
      echo "录播姬已停止，执行一次更新脚本以写入配置。"
      if command -v python3 >/dev/null 2>&1; then
        python3 "$UPDATE_SCRIPT"
        UPDATE_RESULT2=$?
      elif command -v python >/dev/null 2>&1; then
        python "$UPDATE_SCRIPT"
        UPDATE_RESULT2=$?
      else
        echo "未找到 python，无法执行更新脚本"
        UPDATE_RESULT2=254
      fi
      if [ "$UPDATE_RESULT2" -eq 0 ]; then
        echo "更新脚本执行成功（exit=$UPDATE_RESULT2）"
      else
        echo "警告：更新脚本执行失败（exit=$UPDATE_RESULT2）"
      fi

      echo "重新启动录播姬..."
      /root/BililiveRecorder/BililiveRecorder.Cli run --bind "http://*:2356" --http-basic-user "$Bililive_USER" --http-basic-pass "$Bililive_PASS" "/rec/录播姬" > /dev/null 2>&1 &
      sleep 4
      if pgrep -f "BililiveRecorder.Cli" > /dev/null; then
        echo "录播姬重启成功"
      else
        echo "录播姬重启失败"
      fi
    fi
  else
    echo "更新脚本检测异常（exit=$UPDATE_RESULT），保持当前录播姬进程不改动。"
  fi
fi

# 启动 biliup(暂时不使用biliup录制，只用于上传)
#/rec/biliup/biliup server --auth > /dev/null 2>&1

#if ! pgrep -f "biliup" > /dev/null; then
#  echo "$(date)"
#  echo "biliup启动失败"
#else
#  echo "------------------------------------"
#  echo "$(date)"
#  echo "biliup运行中"
#  echo "------------------------------------"
#fi


# 创建并启动每日视频上传备份定时任务
SCHEDULER_SCRIPT="/usr/local/bin/执行视频备份脚本.sh"
cat << 'EOF' > "$SCHEDULER_SCRIPT"
#!/bin/bash

CONFIG_FILE="/rec/config.conf"
DEFAULT_SLEEP_TIME="300"  # 每五分钟检查一次状态
LOG_FILE="/rec/备份脚本执行日志.log"

# 引入日志函数库
export LOG_BASE_DIR="/rec/logs"
export LOG_MAX_FILES=100
source "/rec/脚本/log.sh"

# 用于记录上一次检查时的整体状态（0: 均静止, 1: 有目录在录制）
LAST_STATUS=0
# 跟踪已报告不存在的目录，避免重复警告
declare -A MISSING_DIR_REPORTED 

log info "目录监控脚本已启动..."

while true; do
  # 1. 读取配置文件
  if [[ -f "$CONFIG_FILE" ]]; then
    source "$CONFIG_FILE"
  else
    log warn "配置文件不存在，使用默认设置"
    ENABLE_UPLOAD_SCRIPT=false
  fi

  # 如果未启用，则跳过后续检查
  if [[ "$ENABLE_UPLOAD_SCRIPT" != "true" ]]; then
    log info "配置文件中未启用上传备份脚本，跳过检查。"
    sleep "$DEFAULT_SLEEP_TIME"
    continue
  fi

  # 2. 遍历所有配置的源文件夹，检查写入状态
  ANY_RECORDING=false # 局部变量：标记本次循环中是否有任意一个目录在录制
  SAVED_RECENT_FILES="" # 新增：用于记录究竟是哪些文件在写入
  for folder in "${source_folders[@]}"; do
    # 如果文件夹不存在，跳过检查（仅首次警告）
    if [[ ! -d "$folder" ]]; then
      if [[ -z "${MISSING_DIR_REPORTED[$folder]}" ]]; then
        log warn "监控目录 $folder 不存在，跳过该目录检查（后续不再重复警告）。"
        MISSING_DIR_REPORTED[$folder]=1
      fi
      continue
    fi

    # 核心逻辑：使用 find 检查该目录下 20 分钟内是否有文件被修改/写入
    RECENT_FILES=$(find "$folder" -type f -mmin -20 2>/dev/null)
    
    if [[ -n "$RECENT_FILES" ]]; then
      ANY_RECORDING=true
      SAVED_RECENT_FILES="${SAVED_RECENT_FILES}${RECENT_FILES}"$'\n'
    fi
  done

  # 3. 状态机逻辑判断
  if [[ "$ANY_RECORDING" = true ]]; then
    # 情况 A：至少有一个目录正在写入
    if [[ $LAST_STATUS -eq 0 ]]; then
      log info "检测到写入，重置状态..."
      echo "$SAVED_RECENT_FILES" | sed '/^\s*$/d' | while read -r file; do
        log info "触发写入的文件: $file"
      done
    fi
    LAST_STATUS=1 # 标记整体为录制中状态
  else
    # 情况 B：所有目录在过去 20 分钟内都没有任何文件写入
    if [[ $LAST_STATUS -eq 1 ]]; then
      # 关键节点：所有录制都结束，且距离最后一次写入已满 20 分钟
      log info "所有设置目录停止写入已满 20 分钟，判断录制全部结束，开始执行备份..."
      # 执行核心备份脚本
      /rec/脚本/录播上传备份脚本.sh >> "$LOG_FILE" 2>&1
      log info "备份脚本执行完毕。"
      
      LAST_STATUS=0 # 重置状态，等待下一次录制
    else
      # 持续静止状态（没有录制，或者早就录完上传过了），不做任何操作
      :
    fi
  fi
  sleep "$DEFAULT_SLEEP_TIME"
done
EOF

chmod +x "$SCHEDULER_SCRIPT"
"$SCHEDULER_SCRIPT" &

# 创建webclip在线切片服务的定时任务
WEBCLIP_SCHEDULER_SCRIPT="/usr/local/bin/在线切片启动脚本.sh"
cat << 'EOF' > "$WEBCLIP_SCHEDULER_SCRIPT"
#!/bin/bash
CONFIG_FILE="/rec/config.conf"
source "$CONFIG_FILE"
if [[ "$ENABLE_WEBCLIP" = "true" ]] && [[ -f "/rec/在线切片/app.py" ]]; then
  echo "启动在线切片服务..."
  port="${WEBCLIP_PORT:-8186}"
  uvicorn app:app --host 0.0.0.0 --port "$port" --app-dir "/rec/在线切片" > /dev/null 2>&1 &
fi
EOF
chmod +x "$WEBCLIP_SCHEDULER_SCRIPT"
"$WEBCLIP_SCHEDULER_SCRIPT" &

# 创建语音识别服务的定时任务
OPENCC_SCHEDULER_SCRIPT="/usr/local/bin/语音识别启动脚本.sh"
cat << 'EOF' > "$OPENCC_SCHEDULER_SCRIPT"
#!/bin/bash
CONFIG_FILE="/rec/config.conf"
source "$CONFIG_FILE"
if [[ "$ENABLE_OPENCC" = "true" ]] && [[ -f "/rec/语音识别/app.py" ]]; then
  echo "启动语音识别服务..."
  python3 /rec/语音识别/app.py > /dev/null 2>&1 &
fi
EOF
chmod +x "$OPENCC_SCHEDULER_SCRIPT"
"$OPENCC_SCHEDULER_SCRIPT" &

# 输出账户信息
echo "------------------------------------"
echo "当前录播姬用户名:"
echo "$Bililive_USER"
echo "当前录播姬密码:"
echo "$Bililive_PASS"
echo "------------------------------------"
#echo "biliup默认用户名为："
#echo "biliup"
#echo "biliup密码需要登录web界面注册"
#echo "------------------------------------"

# 保持容器运行
tail -f /dev/null
