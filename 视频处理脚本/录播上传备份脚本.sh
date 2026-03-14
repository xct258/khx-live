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

  # 使用配置中的模板并替换占位符
  # {title} 为直播标题，{platform} 为录制平台
  echo "$UPLOAD_DESC_TEMPLATE" | sed \
    -e "s/{title}/$stream_title/g" \
    -e "s/{platform}/$recording_platform/g"
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

# 如果没有待处理文件夹，直接进入后续维护逻辑
if [[ ${#directories[@]} -eq 0 ]]; then
  log info "未发现待处理的视频目录"
else
  # 遍历每个非空目录
  for dir in "${directories[@]}"; do
    upload_success=true
    log info "处理目录: ${dir}"

    # --- 第一阶段：极速清理小视频及其关联 XML ---
    # 【核心修复】仅依赖 find 的 -size -10M 参数，直接读取底层文件系统元数据，零 I/O 负担
    find "$dir" -type f \( -name "*.mp4" -o -name "*.flv" \) -size -10M -print0 |
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
    mapfile -t input_files < <(find "$dir" -type f \( -name "*.flv" -o -name "*.mp4" -o -name "*.xml" \) | sort)

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
            flv)
                # 如果配置禁用转换，则直接移动原文件
                if [[ "$CONVERT_FLV_TO_MP4" != "true" ]]; then
                    log info "配置禁用 flv 转换，直接移动原文件: $file"
                    mv "$file" "$cache_dir/" || upload_success=false
                    continue
                fi

                # 需要转换为 mp4
                output_file="$cache_dir/${filename}.mp4"
                log info "转换视频: $file -> $output_file"
                # 使用 copy 模式极速封转，-loglevel error 避免输出过多无用日志
                if ffmpeg -i "$file" -c:v copy -c:a copy -loglevel error -y "$output_file"; then
                    rm -f "$file"
                    log success "转换成功并清理源文件"
                else
                    log error "转换失败：$file，保留原视频并使用原文件"
                    # 转换失败时直接使用原视频，将其移动到缓存目录
                    if mv "$file" "$cache_dir/"; then
                        log info "转换失败，已将原文件移动到缓存目录：$cache_dir"
                    else
                        log error "无法移动原视频到缓存目录：$file"
                        upload_success=false
                    fi
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
fi


# 检查是否有需要备份/上传的目录
if [[ ${#cache_dirs[@]} -eq 0 ]]; then
  log info "无新生成的备份目录需要处理"
else
  # 按时间排序备份目录
  mapfile -t sorted_cache_dirs < <(printf '%s\n' "${cache_dirs[@]}" | sort)

  for cache_dir in "${sorted_cache_dirs[@]}"; do
    # 再次防御性检查，防止 mapfile 读取到空行
    [[ -z "$cache_dir" ]] && continue
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
          ext="${filename##*.}"
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
                # 如果未启用弹幕压制或者关闭了 flv->mp4 转换，视为禁用弹幕压制
                if [[ "$ENABLE_DANMAKU_OVERLAY" != "true" || "$CONVERT_FLV_TO_MP4" != "true" ]]; then
                  log warn "弹幕压制已禁用（ENABLE_DANMAKU_OVERLAY=$ENABLE_DANMAKU_OVERLAY CONVERT_FLV_TO_MP4=$CONVERT_FLV_TO_MP4），跳过压制"
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
                  original_files+=("${cache_dir}/${filename}")
                fi
              else
                log.warn "弹幕文件内容为空或不符合预期，跳过弹幕压制：${cache_dir}/${xml_file}"
                # 添加视频到数组
                compressed_files+=("${cache_dir}/${filename}")
              fi
            else
              log.warn "未检测到弹幕 XML 文件，跳过弹幕压制：${cache_dir}/${xml_file}"
              # 添加视频到数组
              compressed_files+=("${cache_dir}/${filename}")
            fi
            # 同时将原始视频文件添加到原始文件数组
            original_files+=("${cache_dir}/${filename}")
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

        target_dir="${source_backup}/videos/${streamer_name}/原文件/${formatted_start_time_3}/"
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
        # 找到第一个不符合条件的文件并赋值给变量
        unexpected_file=$(find "$cache_dir" -type f ! -iname "*.log" ! -iname "*.jpg" -print -quit)
        if [ -n "$unexpected_file" ]; then
          log warn "检测到异常文件 [$(basename "$unexpected_file")]，跳过清理：${cache_dir}"
        else
          log info "清理目录：${cache_dir}"
          rm -rf "$cache_dir"
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
  done
fi

# 清理“正在处理中”目录下的空目录
if [ -d "${source_backup}/正在处理中" ]; then
    log info "清理“正在处理中”目录及其子目录下的空文件夹..."
    find "${source_backup}/正在处理中" -type d -empty -delete
fi

# 自动清理旧视频（按自然日计算）
if [[ "$ENABLE_CLEANUP" == "true" ]]; then
  log info "开始清理超过 ${RETENTION_DAYS} 天的旧视频目录（按自然日计算）..."

  DRY_RUN=false            # true = 只打印不删除
  MAX_DELETE=8            # 最大删除数量保护

  delete_count=0
  scanned_count=0

  # 计算自然日截止日期
  # 例如：今天25号，RETENTION_DAYS=3 → cutoff=22号
  cutoff_date=$(date -d "${RETENTION_DAYS} days ago" +%Y-%m-%d)

  log info "自然日截止日期: ${cutoff_date} （早于此日期的将删除）"

  while read -r dir_path; do
    ((scanned_count++))
    dir_name=$(basename "$dir_path")

    # 只处理合法日期目录
    if date -d "$dir_name" >/dev/null 2>&1; then

      # 字符串比较（YYYY-MM-DD 可以直接比较）
      if [[ "$dir_name" < "$cutoff_date" ]]; then

        if [[ "$DRY_RUN" == "true" ]]; then
          log warn "[DRY-RUN] 将删除目录: $dir_path (日期: $dir_name)"
        else
          log info "删除目录: $dir_path (日期: $dir_name)"
          rm -rf --one-file-system -- "$dir_path"
        fi

        ((delete_count++))

        if [[ "$delete_count" -ge "$MAX_DELETE" ]]; then
          log error "达到最大删除数量 ${MAX_DELETE}，停止清理（安全保护触发）"
          break
        fi
      fi
    else
      log warn "无法解析日期目录，跳过: $dir_path"
    fi

  done < <(
    find "${source_backup}/videos" -type d \
      \( -path "*/压制版/*" -o -path "*/源文件/*" \) \
      -name "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]"
  )

  # 清理空目录（非 DRY_RUN）
  if [[ "$DRY_RUN" != "true" ]]; then
    find "${source_backup}/videos" -type d -empty -delete
  fi

  log success "扫描完成，共扫描 ${scanned_count} 个目录，删除 ${delete_count} 个目录"

else
  log info "已禁用自动清理，跳过清理"
fi


log info "脚本执行完毕"
