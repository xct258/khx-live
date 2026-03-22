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
# 配置文件单独处理
if [ ! -f /rec/config.conf ]; then
    cp /opt/bililive/config/config.conf /rec/config.conf
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
if [ -n "$XCT258_GITHUB_TOKEN" ]; then

  # 检查是否有文件缺失，只有缺失时才下载
  missing_file=false

  [ ! -f "/root/.config/rclone/rclone.conf" ] && missing_file=true
  [ ! -f "/rec/cookies/bilibili/cookies-烦心事远离.json" ] && missing_file=true
  [ ! -f "/rec/cookies/bilibili/cookies-xct258-2.json" ] && missing_file=true

  if $missing_file; then
    echo "检测到 XCT258_GITHUB_TOKEN，正在静默下载私有配置文件..."

    mkdir -p /root/.config/rclone
    mkdir -p /rec/cookies/bilibili

    download_all_success=true

    if [ ! -f "/root/.config/rclone/rclone.conf" ]; then
      wget --quiet --header="Authorization: token $XCT258_GITHUB_TOKEN" \
        -O "/root/.config/rclone/rclone.conf" \
        "https://raw.githubusercontent.com/xct258/Documentation/refs/heads/main/rclone/rclone.conf" || download_all_success=false
    fi

    if [ ! -f "/rec/cookies/bilibili/cookies-烦心事远离.json" ]; then
      wget --quiet --header="Authorization: token $XCT258_GITHUB_TOKEN" \
        -O "/rec/cookies/bilibili/cookies-烦心事远离.json" \
        "https://raw.githubusercontent.com/xct258/Documentation/refs/heads/main/b站cookies/cookies-b站-烦心事远离.json" || download_all_success=false
    fi

    if [ ! -f "/rec/cookies/bilibili/cookies-xct258-2.json" ]; then
      wget --quiet --header="Authorization: token $XCT258_GITHUB_TOKEN" \
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
DEFAULT_SLEEP_TIME="02:00"

while true; do
  # 读取配置文件
  if [[ -f "$CONFIG_FILE" ]]; then
    source "$CONFIG_FILE"
  else
    echo "配置文件不存在，使用默认设置" >> /rec/录播上传备份脚本.log 2>&1
    ENABLE_UPLOAD_SCRIPT=false
    SCHEDULE_SLEEP_TIME="$DEFAULT_SLEEP_TIME"
  fi

  # 如果未启用，则跳过执行
  if [[ "$ENABLE_UPLOAD_SCRIPT" != "true" ]]; then
    echo "$(date)" > /rec/录播上传备份脚本.log 2>&1
    echo "----------------------------" >> /rec/录播上传备份脚本.log 2>&1
    echo "已禁用上传脚本执行，跳过本次任务。" >> /rec/录播上传备份脚本.log 2>&1
    echo "----------------------------" >> /rec/录播上传备份脚本.log 2>&1
    echo "$(date)" >> /rec/录播上传备份脚本.log 2>&1
  else
    echo "$(date)" > /rec/录播上传备份脚本.log 2>&1
    echo "----------------------------" >> /rec/录播上传备份脚本.log 2>&1
    /rec/脚本/录播上传备份脚本.sh >> /rec/录播上传备份脚本.log 2>&1
    echo "----------------------------" >> /rec/录播上传备份脚本.log 2>&1
    echo "$(date)" >> /rec/录播上传备份脚本.log 2>&1
  fi

  # 计算下次执行时间
  current_date=$(date +%Y-%m-%d)
  now_ts=$(date +%s)
  target_time="${current_date} ${SCHEDULE_SLEEP_TIME:-$DEFAULT_SLEEP_TIME}"
  time_difference=$(( $(date -d "$target_time" +%s) - $now_ts ))
  if [[ $time_difference -lt 0 ]]; then
    time_difference=$(( time_difference + 86400 ))  # 加一天
  fi
  wake_time=$(date -d "@$(( $now_ts + $time_difference ))" '+%Y-%m-%d %H:%M:%S')
  echo "睡眠 $time_difference 秒，预计下次执行时间 $wake_time" >> /rec/录播上传备份脚本.log 2>&1
  sleep $time_difference
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
