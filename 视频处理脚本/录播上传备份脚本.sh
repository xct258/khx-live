#!/bin/bash
set -x

# 设置工作目录和备份文件件路径
source_backup="/rec"

# 读取配置文件
source /rec/config.conf

# 定义需要检查的库及其apt包名
declare -A libraries
libraries=(
  ["numpy"]="python3-numpy"
  ["matplotlib"]="python3-matplotlib"
  ["scipy"]="python3-scipy"
)

# 生成压制弹幕版上传描述的函数
generate_upload_desc() {
  local stream_title="$1"
  local formatted_start_time_2="$2"

  echo "直播间标题：$stream_title
录制平台：$recording_platform

括弧笑频道主页：
bilibili
顶级尼鸡塔结晶
https://space.bilibili.com/296620370
高机动持盾军官
https://space.bilibili.com/32223456
acfun
蘑菇的括弧笑
https://www.acfun.cn/u/12909228
鬼屋神狙会
https://www.acfun.cn/u/73177808
youtube
蘑菇的刮弧笑
https://www.youtube.com/@蘑菇的刮弧笑

括弧笑直播间地址：
bilibili
https://live.bilibili.com/1962720

使用录播姬和biliup录制上传，有问题请站内私信联系xct258
https://space.bilibili.com/33235987

项目地址：
https://github.com/xct258/khx-live

非常感谢录播姬和biliup项目
录播姬
https://github.com/BililiveRecorder/BililiveRecorder
biliup
https://github.com/biliup/biliup"
}

# 处理上传成功的状态的函数
handle_upload_status() {
  local upload_success="$1"
  local streamer_name="$2"
  local start_time="$3"
  local remote_name="$4"
  local free_gb="$5"

  if $upload_success; then
    echo "${server_name}

${streamer_name}
${start_time}场

视频上传成功
备份网盘: 
${remote_name}
剩余空间: 
${free_gb}GB"
  else
    echo "${server_name}

${streamer_name}
${start_time}场

脚本执行失败！，请检查⚠"
  fi
}

# 引入日志函数库
export LOG_BASE_DIR="/rec/logs"
source "/rec/脚本/log.sh"

log info "脚本开始执行"

# 安装ffmpeg
if ! command -v ffmpeg &> /dev/null; then
  log info "检测到系统未安装 ffmpeg，开始安装..."
  if ! apt install -y ffmpeg; then
    log error "安装 ffmpeg 失败，脚本退出"
    exit 1
  else
    log success "ffmpeg 安装成功"
  fi
fi

# 安装wget
if ! command -v wget &> /dev/null; then
  log info "检测到系统未安装 wget，开始安装..."
  if ! apt install -y wget; then
    log error "安装 wget 失败，脚本退出"
    exit 1
  else
    log success "wget 安装成功"
  fi
fi

# 检查 source_folders 中的文件夹是否存在，不存在则创建,防止脚本报错
for source_folder in "${source_folders[@]}"; do
  if [ ! -d "$source_folder" ]; then
    mkdir -p "$source_folder"
  fi
done

# 创建一个空数组来保存非空目录
directories=()
# 创建一个空数组来保存所有的备份目录
cache_dirs=()

while IFS= read -r -d $'\0' dir; do
    compgen -G "$dir/*/" > /dev/null || directories+=("$dir")
done < <(find "${source_folders[@]}" -type d -not -empty -print0)

# 遍历每个非空目录
for dir in "${directories[@]}"; do
  upload_success=true
  log info "处理非空目录: ${dir}"

  # --- 第一阶段：极速清理小视频及其关联 XML ---
  # 【核心修复】仅依赖 find 的 -size -10M 参数，直接读取底层文件系统元数据，零 I/O 负担
  find "$dir" -type f \( -name "*.mp4" -o -name "*.flv" -o -name "*.ts" \) -size -10M -print0 |
  while IFS= read -r -d '' video; do
      log info "视频过小 (<10MB): $video，执行清理"
      base_path="${video%.*}"
      rm -f "$video"
      
      # 同步尝试删除同名的 XML
      if [[ -f "${base_path}.xml" ]]; then
          rm -f "${base_path}.xml"
          log info "同步删除关联的 XML: ${base_path}.xml"
      fi
  done

  # --- 第二阶段：重新读取有效文件路径，并提取元数据 ---
  # 清理完小垃圾文件后，重新获取剩余的真实有效文件列表
  # mapfile (或 readarray) 能够绝对安全地处理带空格等特殊字符的文件名
  mapfile -t input_files < <(find "$dir" -type f \( -name "*.ts" -o -name "*.flv" -o -name "*.mp4" -o -name "*.xml" \) | sort)

  # 【重要保护】如果清理小文件后，目录变空了，直接删除目录并跳过后续逻辑
  if [[ ${#input_files[@]} -eq 0 ]]; then
      log info "目录 ${dir} 清理后已无有效视频，直接移除"
      rm -rf "$dir"
      continue
  fi

  # 获取第一个有效文件的信息，用于提取直播开始时间和主播名称
  first_file="${input_files[0]}"
  # 示例：录播姬_2024年12月01日22点13分_暗区最穷_高机动持盾军官.flv
  base_filename=$(basename "$first_file")

  # 获取开播时间
  start_time=$(echo "$base_filename" | cut -d '_' -f 2 | cut -d '.' -f 1)

  # 获取主播名称
  streamer_name=$(echo "$base_filename" | sed -E 's/.*_(.*)\..*/\1/')
  if [[ "$streamer_name" == "高机动持盾军官" ]]; then
      streamer_name="括弧笑bilibili"
  fi

  # 获取录制平台
  recording_platform=$(echo "$base_filename" | cut -d'_' -f 1 | sed 's/^投稿版-//')

  # 设置并创建缓存目录
  cache_dir="${source_backup}/正在处理中/${streamer_name}/${start_time}"
  mkdir -p "$cache_dir"
  cache_dirs+=("$cache_dir")

  # --- 第三阶段：处理有效的大视频和 XML 的移动/转换 ---
  # 直接遍历刚刚获取到的有效数组 input_files，避免重复执行 find
  for file in "${input_files[@]}"; do
      [[ ! -f "$file" ]] && continue # 防御性检查：确保文件真实存在

      ext="${file##*.}"
      filename="$(basename "$file" ."$ext")"

      case "$ext" in
          xml|mp4)
              log info "移动文件: $file"
              mv "$file" "$cache_dir/" || upload_success=false
              ;;
          flv|ts)
              output_file="$cache_dir/${filename}.mp4"
              log info "转换视频: $file -> $output_file"
              # 使用 copy 模式极速封转，-loglevel error 避免输出过多无用日志
              if ffmpeg -i "$file" -c:v copy -c:a copy -loglevel error -y "$output_file"; then
                  rm -f "$file"
                  log success "转换成功并清理源文件"
              else
                  log error "转换失败：$file"
                  upload_success=false
              fi
              ;;
      esac
  done

  # --- 第四阶段：收尾 ---
  # 如果所有移动/转换都成功，则删除原目录
  if $upload_success; then
      rm -rf "$dir"
      log success "处理完毕，删除原目录成功：$dir"
  else
      log error "目录 ${dir} 中有文件处理失败，保留原目录以备人工检查"
  fi
done

# 按时间排序备份目录
mapfile -t sorted_cache_dirs < <(printf '%s\n' "${cache_dirs[@]}" | sort)

for cache_dir in "${sorted_cache_dirs[@]}"; do
  log info "处理备份目录：$cache_dir"
  
  # 声明数组，用于存储上传到B站视频的文件名
  compressed_files=()
  original_files=()

  # 处理从临时目录获取的文件路径
  mapfile -d '' -t input_files < <(find "$cache_dir" -type f -print0 | sort -z)
  # 获取临时目录第一个文件的信息，用于提取直播开始时间和主播名称
  first_file="${input_files[0]}"
  # 示例：video/高机动持盾军官/录播姬_2024年12月01日22点13分_暗区最穷_高机动持盾军官.flv
  # 去除文件路径
  base_filename=$(basename "$first_file")
  # 示例：录播姬_2024年12月01日22点13分_暗区最穷_高机动持盾军官.flv

  # 获取开播时间
  start_time=$(echo "$base_filename" | cut -d '_' -f 2 | cut -d '.' -f 1)
  # 示例：2024年12月01日22点13分
  # 处理开播时间格式
  formatted_start_time_1=$(echo "$start_time" | sed 's/^\(.*点\)[0-9]\+分$/\1/')
  # 示例：2024年12月01日22点
  formatted_start_time_2=$(echo "$start_time" | sed 's/日/日 /')
  # 示例：2024年12月01日 22点13分
  formatted_start_time_3=$(echo "$start_time" | sed -E 's/([0-9]{4})年([0-9]{2})月([0-9]{2})日([0-9]{2})点([0-9]{2})分/\1\/\2\/\1-\2-\3/; s/日/日 /')
  # 示例：2024/12/2024-12-01
  formatted_start_time_4=$(echo "$start_time" | sed -E 's/([0-9]+年[0-9]+月[0-9]+日).*/\1/')
  # 示例：2024年12月01日

  # 获取直播间标题
  stream_title=$(echo "$base_filename" | awk -F'_' '{for (i=3; i<NF-1; i++) printf "%s_", $i; printf "%s\n", $(NF-1)}')
  # 示例：暗区最穷

  # 获取录制平台
  recording_platform=$(echo "$base_filename" | cut -d'_' -f 1 | sed 's/^投稿版-//')
  # 示例：录播姬

  # 获取主播名称
  streamer_name=$(echo "$base_filename" | sed -E 's/.*_(.*)\..*/\1/')

  if [[ "$streamer_name" == "高机动持盾军官" ]]; then
    streamer_name="括弧笑bilibili"
  fi

  log info "直播标题: $stream_title"
  log info "录制平台: $recording_platform"
  log info "主播名称: $streamer_name"

  # 投稿
  if [[ "$streamer_name" == "括弧笑bilibili" && " ${update_servers[*]} " == *" $recording_platform "* ]]; then
    log info "开始投稿准备"
    # 安装xz工具
    if ! command -v xz &> /dev/null; then
      log info "检测到系统未安装 xz-utils，开始安装..."
      if ! apt install -y xz-utils; then
        log error "安装 xz-utils 失败，脚本退出"
        exit 1
      else
        log success "xz-utils 安装成功"
      fi
    fi
  fi

  for video_file in "${input_files[@]}"; do
    if [[ -f "$video_file" ]]; then
      # 获取文件名（不带路径）
      filename=$(basename "$video_file")
      # 示例：录播姬_2024年12月01日22点13分_暗区最穷_高机动持盾军官.flv

      # 获取文件名（不带扩展名）
      filename_no_ext="${filename%.*}"
      # 示例：录播姬_2024年12月01日22点13分_暗区最穷_高机动持盾军官

      if [[ "$streamer_name" == "括弧笑bilibili" && " ${update_servers[*]} " == *" $recording_platform "* ]]; then
        if [[ "$filename" == *.mp4 ]]; then
          if [[ "$filename" == 投稿版-* ]]; then
            log info "检测到投稿版视频，跳过弹幕压制"
            compressed_files+=("${cache_dir}/${filename}")
            original_files+=("${cache_dir}/${filename}")
          else
            xml_file="${filename_no_ext}.xml"
            ass_file="${filename_no_ext}.ass"
            output_file="投稿版-${filename_no_ext}.mp4"
            if [[ -f "${cache_dir}/${xml_file}" ]]; then
              # 检查 XML 是否包含有效弹幕（通过匹配<d，<sc，<gift，<guard开头的行）
              if grep -aEq '^\s*<(d|sc|gift|guard)' "${cache_dir}/${xml_file}"; then
                log info "检测到有效弹幕文件，开始弹幕压制：${cache_dir}"

                # 检查 Intel 显卡驱动安装
                if lspci | grep -i "VGA\|Display" | grep -i "Intel Corporation" > /dev/null; then
                  if ! vainfo > /dev/null 2>&1; then
                    log info "检测到Intel显卡驱动未安装，开始安装..."
                    apt update
                    apt install -y gpg wget
                    wget -qO - https://repositories.intel.com/gpu/intel-graphics.key | gpg --dearmor --output /usr/share/keyrings/intel-graphics.gpg
                    echo "deb [arch=amd64,i386 signed-by=/usr/share/keyrings/intel-graphics.gpg] https://repositories.intel.com/gpu/ubuntu jammy client" | tee /etc/apt/sources.list.d/intel-gpu-jammy.list
                    apt update
                    apt install -y intel-media-va-driver-non-free libmfx1 libmfxgen1 libvpl2 va-driver-all vainfo
                    log success "Intel显卡驱动安装完成"
                  fi
                fi

                for lib in "${!libraries[@]}"; do
                  if ! python3 -c "import $lib" &> /dev/null; then
                    if apt install -y "${libraries[$lib]}"; then
                      log success "安装Python库 ${libraries[$lib]} 成功"
                    else
                      log error "安装Python库 ${libraries[$lib]} 失败"
                      upload_success=false
                    fi
                  fi
                done
                if [[ "$ENABLE_DANMAKU_OVERLAY" != "true" ]]; then
                  log warn "已禁用弹幕压制，跳过压制"
                  compressed_files+=("${cache_dir}/${filename}")  # 直接添加原视频路径
                else
                  if python3 /rec/脚本/压制视频.py "${cache_dir}/${xml_file}"; then
                    if [[ -f "${cache_dir}/${output_file}" ]]; then
                      log success "视频弹幕压制完成：$output_file"
                      compressed_files+=("${cache_dir}/${output_file}")
                    else
                      log error "压制脚本执行成功但未生成目标文件，使用原视频：$filename"
                      compressed_files+=("${cache_dir}/${filename}")
                    fi
                  else
                    log error "视频弹幕压制失败：$output_file"
                    compressed_files+=("${cache_dir}/${filename}")
                  fi
                  rm "${cache_dir}/${ass_file}"
                  original_files+=("${cache_dir}/${filename}")
                fi
              else
                log warn "弹幕文件内容为空或不符合预期，跳过弹幕压制：${cache_dir}/${xml_file}"
                # 添加视频到数组
                compressed_files+=("${cache_dir}/${filename}")
              fi
            else
              log warn "未检测到弹幕 XML 文件，跳过弹幕压制：${cache_dir}/${xml_file}"
              # 添加视频到数组
              compressed_files+=("${cache_dir}/${filename}")
            fi
            # 同时将原始视频文件添加到原始文件数组
            original_files+=("${cache_dir}/${filename}")
          fi
        fi
      fi
    else
      log warn "视频文件不存在或无法访问：$video_file"
    fi
  done

  if [[ "$streamer_name" == "括弧笑bilibili" && " ${update_servers[*]} " == *" $recording_platform "* ]]; then
    # 构建视频标题
    upload_title_1="${formatted_start_time_4}"
    # 构建视频简介
    upload_desc_1=$(generate_upload_desc "$stream_title" "$formatted_start_time_2")
    
    if [[ "$ENABLE_VIDEO_UPLOAD" != "true" ]]; then
      log warn "上传已被禁用，跳过投稿步骤"
      danmu_version_cache_dir="${source_backup}/videos/${streamer_name}/禁用投稿/压制版/${formatted_start_time_3}/"
    else
      log info "开始上传视频：${compressed_files[@]}"
      # 正常发布
      # 封面获取
      biliup_cover_image=$(python3 /rec/脚本/封面获取.py "$cache_dir")
      log info "获取封面图片路径：$biliup_cover_image"

      # === 新增：检测封面文件是否存在 ===
      cover_args=() # 初始化一个空数组
      if [[ -f "$biliup_cover_image" ]]; then
          log info "封面文件存在，已添加封面参数。"
          cover_args=("--cover" "$biliup_cover_image")
      else
          log info "封面文件不存在或路径无效，跳过封面上传。"
      fi
      # ==================================

      # 在命令中使用 "${cover_args[@]}" 动态展开参数
      biliup_upload_output=$("$source_backup/biliup/biliup" -u "${biliup_up_cookies}" upload \
        --copyright 2 \
        "${cover_args[@]}" \
        --source https://live.bilibili.com/1962720 \
        --tid 17 \
        --title "$upload_title_1" \
        --desc "$upload_desc_1" \
        --tag "直播回放,奶茶猪,娱乐主播" \
      "${compressed_files[@]}")

      # 检查是否包含“投稿成功”关键字
      if echo "$biliup_upload_output" | grep -q "投稿成功"; then
        log info "投稿成功"
        danmu_version_cache_dir="${source_backup}/videos/${streamer_name}/压制版/${formatted_start_time_3}/"
      else
        log error "投稿失败，请检查"
        danmu_version_cache_dir="${source_backup}/videos/${streamer_name}/投稿失败/压制版/${formatted_start_time_3}/"
      fi
    fi

    # =============================
    # 备份压制版
    # =============================
    if compgen -G "${cache_dir}/投稿版-*" > /dev/null; then
      log info "找到投稿版文件，准备备份"

      mkdir -p "$danmu_version_cache_dir"
      mv "${cache_dir}/投稿版-"* "$danmu_version_cache_dir/"
      mv "${cache_dir}/预览版-"* "$danmu_version_cache_dir/"
      log info "备份完成：投稿版文件已移动到 $danmu_version_cache_dir"
    else
      log info "未找到投稿版文件，跳过备份投稿版"
    fi


    # =============================
    # 备份视频源文件
    # =============================
    if compgen -G "${cache_dir}/*.mp4" > /dev/null \
      || compgen -G "${cache_dir}/*.flv" > /dev/null \
      || compgen -G "${cache_dir}/*.xml" > /dev/null; then

      log info "备份录制源文件"

      target_dir="${source_backup}/videos/${streamer_name}/源文件/${formatted_start_time_3}/"
      mkdir -p "$target_dir"

      mv "${cache_dir}"/*.mp4 "$target_dir" 2>/dev/null
      mv "${cache_dir}"/*.flv "$target_dir" 2>/dev/null
      mv "${cache_dir}"/*.xml "$target_dir" 2>/dev/null

      log info "备份完成：源文件已移动到 $target_dir"
    else
      log info "未找到源文件，跳过备份源文件"
    fi


    # =============================
    # 清理临时文件
    # =============================
    if [ -d "$cache_dir" ]; then
      if find "$cache_dir" -type f ! -name "*.txt" -print -quit | grep -q .; then
        log warn "存在非txt文件，保留临时文件以备检查：${cache_dir}"
      else
        log info "仅剩txt文件或目录为空，清理临时文件"
        rm -rf "$cache_dir"
        log info "清理完成：临时文件已删除"
      fi
    fi
  fi

  # 上传rclone
  if [[ "$ENABLE_RCLONE_UPLOAD" != "true" ]]; then
    log info "已禁用 rclone 网盘备份，跳过上传"
  else
    # 调用获取最大剩余容量网盘的脚本（JSON 输出）
    rclone_onedrive_max_remote_json=$("/rec/脚本/自动选择onedrive网盘.sh")
    rclone_onedrive_config=$(echo "$rclone_onedrive_max_remote_json" | jq -r '.remote')
    rclone_onedrive_free_gb=$(echo "$rclone_onedrive_max_remote_json" | jq -r '.free_gb')

    # 检查是否找到可用网盘
    if [[ "$rclone_onedrive_config" == "null" || -z "$rclone_onedrive_config" ]]; then
        log warn "未找到可用的 rclone 网盘，跳过上传"
        upload_success=false
    else
      if [[ "$streamer_name" == "括弧笑bilibili" ]]; then
        rclone_backup_path="$rclone_onedrive_config:/直播录制/括弧笑/"
      else
        rclone_backup_path="$rclone_onedrive_config:/直播录制/${streamer_name}/"
      fi

      if rclone move "$cache_dir" "${rclone_backup_path}${formatted_start_time_3}/bilibili/$recording_platform/"; then
        if [ -z "$(ls -A "$cache_dir")" ]; then
          log info "rclone 网盘备份成功，删除本地文件夹"
          rmdir "$cache_dir"
        fi
      else
        upload_success=false
        log warn "rclone 网盘备份失败，请检查"
      fi
    fi
  fi

  # 发送上传结果消息
  message=$(handle_upload_status "$upload_success" "$streamer_name" "$start_time" "$rclone_onedrive_config" "$rclone_onedrive_free_gb")
  # 推送消息命令
  curl -s -X POST "https://msgpusher.xct258.top/push/root" \
    --data-urlencode "title=直播录制" \
    --data-urlencode "description=直播录制" \
    --data-urlencode "channel=一般通知" \
    --data-urlencode "content=$message" \
  >/dev/null
done
# 自动清理旧视频
if [[ "$ENABLE_CLEANUP" == "true" ]]; then
  log info "开始清理超过 ${RETENTION_DAYS} 天的旧视频目录..."
  
  # 获取当前系统时间戳
  now_seconds=$(date +%s)
  # 计算保留阈值的秒数 (天数 * 24 * 3600)
  retention_seconds=$((RETENTION_DAYS * 86400))

  # 查找特定目录下（压制版或源文件）符合 YYYY-MM-DD 格式的日期目录
  # 使用 -path 确保只匹配 /videos/*/压制版/... 或 /videos/*/源文件/... 下的文件夹
  find "${source_backup}/videos" -type d \( -path "*/压制版/*" -o -path "*/源文件/*" \) -name "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]" | while read -r dir_path; do
    # 提取文件夹名作为日期字符串
    dir_name=$(basename "$dir_path")
    
    # 将文件夹日期转换为时间戳
    if dir_seconds=$(date -d "$dir_name" +%s 2>/dev/null); then
      # 计算差异
      diff_seconds=$((now_seconds - dir_seconds))
      
      if [[ "$diff_seconds" -gt "$retention_seconds" ]]; then
        log info "检测到过期目录: $dir_path (日期: $dir_name)，执行删除"
        rm -rf "$dir_path"
      fi
    fi
  done

  # 清理可能产生的空父目录 (Year/Month)
  find "${source_backup}/videos" -type d -empty -delete
  log success "旧视频清理完成"
fi

log info "脚本执行完毕"