#!/bin/bash
set -x

# 设置工作目录和备份文件件路径
source_backup="/rec"

# 读取配置文件
source /rec/config.conf


# ===================== 日志增强：辅助函数 =====================
# 生成压制弹幕版上传描述的函数
generate_upload_desc() {
  local stream_title="$1"
  local formatted_start_time_2="$2"
  local danmaku_count="$3"
  local cover_time="$4"
  local cover_p="$5"

  echo "$UPLOAD_DESC_TEMPLATE" | sed \
    -e "s/{title}/$stream_title/g" \
    -e "s/{platform}/$recording_platform/g" \
    -e "s/{danmaku_count}/$danmaku_count/g" \
    -e "s/{cover_time}/$cover_time/g" \
    -e "s/{cover_p}/$cover_p/g" \
    -e "/^弹幕总数：0$/d" \
    -e "/^封面时间：.*P 0$/d"
}

# 封装的文件大小格式化
format_size() {
  local bytes=$1
  if (( bytes < 1024 )); then echo "${bytes}B"
  elif (( bytes < 1048576 )); then echo "$(( bytes / 1024 ))KB"
  elif (( bytes < 1073741824 )); then echo "$(( bytes / 1048576 ))MB"
  else echo "$(( bytes / 1073741824 ))GB"
  fi
}

# 获取目录下视频文件总大小
dir_video_size() {
  local dir="$1"
  local total=0
  while IFS= read -r -d '' f; do
    size=$(stat -c%s "$f" 2>/dev/null || echo 0)
    (( total += size ))
  done < <(find "$dir" -type f \( -name "*.mp4" -o -name "*.flv" \) -print0 2>/dev/null)
  echo "$total"
}

# 引入日志函数库
source "/rec/脚本/log.sh"
LOG_BASE_DIR="/rec/logs"
LOG_APP_NAME="上传备份脚本"

# ===================== 脚本执行起点 =====================
SCRIPT_START_TS=$(date +%s)
log info "═══════════════════════════════════════════════"
log info "  脚本开始执行"
log info "  服务器: ${server_name:-未知}"
log info "  工作目录: ${source_backup}"
log info "  配置文件: /rec/config.conf"
log info "═══════════════════════════════════════════════"

# 记录磁盘空间
log info "磁盘使用情况 ——$(df -h "$source_backup" 2>/dev/null | awk 'NR==2{printf " 总量:%s 已用:%s 可用:%s 使用率:%s", $2, $3, $4, $5}')"

# 记录关键配置状态
log info "配置状态 —— 弹幕压制:${ENABLE_DANMAKU_OVERLAY:-false} 视频上传:${ENABLE_VIDEO_UPLOAD:-false} 网盘备份:${ENABLE_RCLONE_UPLOAD:-false} 自动清理:${ENABLE_CLEANUP:-false} FLV转换:${CONVERT_FLV_TO_MP4:-false}"
log info "保留天数: ${RETENTION_DAYS:-3} 天"

# 全局统计
TOTAL_CLEANED_SMALL=0        # 清理的小视频数量
TOTAL_FILES_MOVED=0          # 移动的文件数
TOTAL_CONVERT_OK=0           # 转换成功数
TOTAL_CONVERT_FAIL=0         # 转换失败数
TOTAL_DIR_PROCESSED=0        # 处理目录数
TOTAL_DIR_FAILED=0           # 失败目录数
TOTAL_DANMAKU_OK=0           # 弹幕压制成功数
TOTAL_DANMAKU_SKIP=0         # 弹幕压制跳过数
TOTAL_UPLOAD_OK=0            # 投稿成功数
TOTAL_UPLOAD_FAIL=0          # 投稿失败数
TOTAL_RCLONE_OK=0            # 网盘备份成功数
TOTAL_RCLONE_FAIL=0          # 网盘备份失败数
TOTAL_DELETED_DIRS=0         # 清理删除的目录数

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
  log info "共发现 ${#directories[@]} 个待处理目录"

  # 遍历每个非空目录
  for dir in "${directories[@]}"; do
    upload_success=true
    ((TOTAL_DIR_PROCESSED++))
    DIR_START_TS=$(date +%s)

    # 日志节目标记
    log info "╔══════════════════════════════════════════╗"
    log info "║  处理目录 #${TOTAL_DIR_PROCESSED}: $(basename "$dir")"
    log info "║  完整路径: ${dir}"
    log info "╚══════════════════════════════════════════╝"

    # 取最早的文件提取元数据（用于确定缓存目录名）
    first_file=$(find "$dir" -type f \( -name "*.mp4" -o -name "*.flv" \) -printf '%T@ %p\n' | sort -n | head -1 | cut -d' ' -f2-)
    if [[ -z "$first_file" ]]; then
      log info "目录 ${dir} 中无视频文件，直接移除"
      rm -rf "$dir"
      continue
    fi
    base_filename=$(basename "$first_file")
    start_time=$(echo "$base_filename" | cut -d '_' -f 2 | cut -d '.' -f 1)
    streamer_name=$(echo "$base_filename" | sed -E 's/.*_(.*)\..*/\1/')
    [[ "$streamer_name" == "高机动持盾军官" ]] && streamer_name="括弧笑bilibili"
    recording_platform=$(echo "$base_filename" | cut -d'_' -f 1 | sed 's/^投稿版-//')

    # 创建缓存目录，立即将源目录所有文件整体移入
    cache_dir="${source_backup}/正在处理中/${streamer_name}/${start_time}"
    mkdir -p "$cache_dir"
    log info "立即将所有文件从 ${dir} 移至缓存目录: ${cache_dir}"

    moved_count=0
    moved_size=0
    while IFS= read -r -d '' f; do
      mv "$f" "$cache_dir/"
      ((moved_count++))
      ((moved_size += $(stat -c%s "$f" 2>/dev/null || echo 0)))
    done < <(find "$dir" -type f -print0 2>/dev/null)

    TOTAL_FILES_MOVED=$((TOTAL_FILES_MOVED + moved_count))
    log info "移动完成 —— 共 ${moved_count} 个文件，视频总大小:$(format_size $moved_size)"
    rmdir "$dir" 2>/dev/null || true
    cache_dirs+=("$cache_dir")

    # 记录处理前信息
    pre_count=$(find "$cache_dir" -type f \( -name "*.mp4" -o -name "*.flv" -o -name "*.xml" \) 2>/dev/null | wc -l)
    pre_size=$(dir_video_size "$cache_dir")
    log info "处理前信息 —— 文件数:${pre_count} 视频总大小:$(format_size $pre_size)"

    # --- 第一阶段：极速清理小视频及其关联 XML ---
    clean_count=0
    while IFS= read -r -d '' video; do
        ((clean_count++))
        vsize=$(stat -c%s "$video" 2>/dev/null || echo 0)
        log info "视频过小 (<10MB): $video (大小:$(format_size $vsize))，执行清理"
        base_path="${video%.*}"
        rm -f "$video"
        ((TOTAL_CLEANED_SMALL++))
        if [[ -f "${base_path}.xml" ]]; then
            rm -f "${base_path}.xml"
            log info "同步删除关联的 XML: ${base_path}.xml"
        fi
    done < <(find "$cache_dir" -type f \( -name "*.mp4" -o -name "*.flv" \) -size -10M -print0)

    if [[ $clean_count -gt 0 ]]; then
      log info "第一阶段完成：共清理 ${clean_count} 个小视频"
    fi

    # --- 第二阶段：读取缓存目录中的有效文件 ---
    mapfile -t input_files < <(find "$cache_dir" -type f \( -name "*.flv" -o -name "*.mp4" -o -name "*.xml" \) | sort)

    if [[ ${#input_files[@]} -eq 0 ]]; then
        log info "缓存目录 ${cache_dir} 中已无有效视频，跳过"
        continue
    fi
    log info "有效文件 ${#input_files[@]} 个"

    # --- 第三阶段：处理有效的大视频和 XML 的转换 ---
    for file in "${input_files[@]}"; do
        [[ ! -f "$file" ]] && continue

        ext="${file##*.}"
        filename="$(basename "$file" ."$ext")"
        fsize=$(stat -c%s "$file" 2>/dev/null || echo 0)

        case "$ext" in
            xml|mp4)
                log info "保留文件: $file (大小:$(format_size $fsize) 类型:$ext)"
                ;;
            flv)
                if [[ "$CONVERT_FLV_TO_MP4" != "true" && "$ENABLE_DANMAKU_OVERLAY" != "true" ]]; then
                    log info "配置禁用 flv 转换，保留原文件: $file (大小:$(format_size $fsize))"
                    continue
                fi

                output_file="$cache_dir/${filename}.mp4"
                log info "转换视频: $(basename "$file") (大小:$(format_size $fsize)) -> $(basename "$output_file")"
                CONV_START_TS=$(date +%s%N)
                if ffmpeg -i "$file" -c:v copy -c:a copy -loglevel error -y "$output_file"; then
                    CONV_ELAPSED=$(( ($(date +%s%N) - CONV_START_TS) / 1000000 ))
                    out_size=$(stat -c%s "$output_file" 2>/dev/null || echo 0)
                    rm -f "$file"
                    log success "转换成功（耗时:${CONV_ELAPSED}ms 输出大小:$(format_size $out_size)），已清理源文件"
                    ((TOTAL_CONVERT_OK++))
                else
                    CONV_ELAPSED=$(( ($(date +%s%N) - CONV_START_TS) / 1000000 ))
                    log error "转换失败（耗时:${CONV_ELAPSED}ms）：$file，保留原视频"
                    ((TOTAL_CONVERT_FAIL++))
                fi
                ;;
        esac
    done

    # --- 第四阶段：收尾 ---
    DIR_ELAPSED=$(( $(date +%s) - DIR_START_TS ))
    if $upload_success; then
        log success "目录处理完成（耗时:${DIR_ELAPSED}s）"
    else
        log error "目录 ${dir} 中有文件处理失败（耗时:${DIR_ELAPSED}s）"
        ((TOTAL_DIR_FAILED++))
    fi
  done
fi


# 检查是否有需要备份/上传的目录
if [[ ${#cache_dirs[@]} -eq 0 ]]; then
  log info "无新生成的备份目录需要处理"
else
  log info "共 ${#cache_dirs[@]} 个备份目录待处理"

  for cache_dir in "${cache_dirs[@]}"; do
    [[ -z "$cache_dir" ]] && continue

    BACKUP_START_TS=$(date +%s)
    log info "╔══════════════════════════════════════════╗"
    log info "║  处理备份目录: $(basename "$cache_dir")"
    log info "║  完整路径: ${cache_dir}"
    log info "╚══════════════════════════════════════════╝"
  
    # 声明数组，用于存储上传到B站视频的文件名
    compressed_files=()
    original_files=()
    audio_files=()

    # 处理从临时目录获取的文件路径
    mapfile -d '' -t input_files < <(find "$cache_dir" -type f -print0 | sort -z)
    # 获取临时目录第一个文件的信息，用于提取直播开始时间和主播名称
    first_file="${input_files[0]}"
    # 示例：video/高机动持盾军官/录播姬_2024年12月01日22点13分11秒_暗区最穷_高机动持盾军官.flv
    # 去除文件路径
    base_filename=$(basename "$first_file")
    # 示例：录播姬_2024年12月01日22点13分11秒_暗区最穷_高机动持盾军官.flv

    # 获取开播时间
    start_time=$(echo "$base_filename" | cut -d '_' -f 2 | cut -d '.' -f 1)
    # 示例：2024年12月01日22点13分11秒
    # 处理开播时间格式
    formatted_start_time_1=$(echo "$start_time" | sed 's/^\(.*点\).*/\1/')
    # 示例：2024年12月01日22点
    formatted_start_time_2=$(echo "$start_time" | sed 's/日/日 /')
    # 示例：2024年12月01日 22点13分11秒
    formatted_start_time_3=$(echo "$start_time" | sed -E 's/([0-9]{4})年([0-9]{2})月([0-9]{2})日.*/\1\/\2\/\1-\2-\3/') 
    # 示例：2024/12/2024-12-01
    formatted_start_time_4=$(echo "$start_time" | sed 's/日.*/日/')
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

    log info "元数据 —— 直播标题: $stream_title"
    log info "元数据 —— 录制平台: $recording_platform"
    log info "元数据 —— 主播名称: $streamer_name"
    log info "元数据 —— 开播时间: $start_time"
    log info "元数据 —— 上传标题: ${formatted_start_time_4} [${stream_title}]"

    for video_file in "${input_files[@]}"; do
      if [[ -f "$video_file" ]]; then
        # 获取文件名（不带路径）
        filename=$(basename "$video_file")
        # 示例：录播姬_2024年12月01日22点13分11秒_暗区最穷_高机动持盾军官.flv

        # 获取文件名（不带扩展名）
        filename_no_ext="${filename%.*}"
        # 示例：录播姬_2024年12月01日22点13分11秒_暗区最穷_高机动持盾军官

        if [[ "$streamer_name" == "括弧笑bilibili" && " ${update_servers[*]} " == *" $recording_platform "* ]]; then
          ext="${filename##*.}"
          [[ "$ext" != "mp4" && "$ext" != "flv" ]] && continue
          
          if [[ "$filename" == 投稿版-* ]]; then
            log info "检测到投稿版视频，跳过弹幕压制"
            compressed_files+=("${cache_dir}/${filename}")
            original_files+=("${cache_dir}/${filename}")
          else
            original_files+=("${cache_dir}/${filename}")
            xml_file="${filename_no_ext}.xml"
            ass_file="${filename_no_ext}.ass"
            output_file="投稿版-${filename_no_ext}.mp4"

            # ==================== 1. 先检查是否启用了弹幕压制 ====================
            danmaku_action="跳过"
            if [[ "$ENABLE_DANMAKU_OVERLAY" != "true" ]]; then
              danmaku_reason="弹幕压制已禁用"
              log warn "弹幕压制已禁用（ENABLE_DANMAKU_OVERLAY=$ENABLE_DANMAKU_OVERLAY），跳过所有检测与压制"
              compressed_files+=("${cache_dir}/${filename}")
            
            # ==================== 2. 启用后，再检查弹幕 XML 是否存在 ====================
            elif [[ ! -f "${cache_dir}/${xml_file}" ]]; then
              danmaku_reason="未检测到弹幕 XML 文件"
              log warn "未检测到弹幕 XML 文件，跳过弹幕压制：${cache_dir}/${xml_file}"
              compressed_files+=("${cache_dir}/${filename}")

            # ==================== 3. 存在后，再检查弹幕内容是否符合规则 ====================
            elif ! grep -aEq '^\s*<(d|sc|gift|guard)' "${cache_dir}/${xml_file}"; then
              danmaku_reason="弹幕文件内容为空或不符合预期"
              log warn "弹幕文件内容为空或不符合预期，跳过弹幕压制：${cache_dir}/${xml_file}"
              compressed_files+=("${cache_dir}/${filename}")

            else
              danmaku_reason=""
              # ==================== 4. 规则校验通过，进入时间差与压制核心逻辑 ====================
              log info "检测到有效弹幕文件，准备时间差校验：${cache_dir}"
              
              DIFF_RESULT=$(/rec/脚本/对比视频和弹幕的时长.sh "$video_file" -s 2>/dev/null)
              IS_SAFE_TO_PROCESS=0
              
              if [[ -n "$DIFF_RESULT" ]]; then
                ABS_DIFF=$(echo "$DIFF_RESULT" | tr -d '+-')
                IS_OVER_LIMIT=$(awk -v diff="$ABS_DIFF" -v limit="$MAX_DIFF_LIMIT" 'BEGIN { print (diff > limit) ? 1 : 0 }')
                if [[ "$IS_OVER_LIMIT" -eq 1 ]]; then
                  danmaku_reason="时间相差过大(${DIFF_RESULT}s > ${MAX_DIFF_LIMIT}s)"
                  log warn "时间相差过大（相差 ${DIFF_RESULT} 秒，限制 ${MAX_DIFF_LIMIT} 秒），疑似网络波动，跳过弹幕压制"
                else
                  log success "时间差校验通过（相差 ${DIFF_RESULT} 秒）"
                  IS_SAFE_TO_PROCESS=1
                fi
              else
                danmaku_reason="时间对比脚本未返回数据"
                log error "安全拦截：时间对比脚本未返回任何数据（可能发生错误），为防同步异常，拒绝执行弹幕压制"
              fi

              if [[ "$IS_SAFE_TO_PROCESS" -eq 1 ]]; then
                danmaku_action="压制"
                DANMAKU_START_TS=$(date +%s)
                log info "开始弹幕压制：${cache_dir}"
                # --mode both/all:       生成投稿版(无进度条) + 预览版(无进度条)
                # --mode clean:          只生成投稿版(无进度条)，不生成预览版
                # --mode both-bar:       生成投稿版(无进度条) + 预览版(带进度条)
                # --mode preview:        只生成预览版(带进度条)
                # --mode preview-clean:  只生成预览版(无进度条)
                if python3 /rec/脚本/压制视频.py "${cache_dir}/${xml_file}" --mode both; then
                  DANMAKU_ELAPSED=$(( $(date +%s) - DANMAKU_START_TS ))
                  if [[ -f "${cache_dir}/${output_file}" ]]; then
                    out_size=$(stat -c%s "${cache_dir}/${output_file}" 2>/dev/null || echo 0)
                    log success "视频弹幕压制完成（耗时:${DANMAKU_ELAPSED}s 输出大小:$(format_size $out_size)）：$output_file"
                    compressed_files+=("${cache_dir}/${output_file}")
                    ((TOTAL_DANMAKU_OK++))
                  else
                    log error "压制脚本执行成功但未生成目标文件（耗时:${DANMAKU_ELAPSED}s），使用原视频：$filename"
                    compressed_files+=("${cache_dir}/${filename}")
                    ((TOTAL_DANMAKU_SKIP++))
                  fi
                else
                  DANMAKU_ELAPSED=$(( $(date +%s) - DANMAKU_START_TS ))
                  log error "视频弹幕压制失败（耗时:${DANMAKU_ELAPSED}s）：$output_file"
                  compressed_files+=("${cache_dir}/${filename}")
                  ((TOTAL_DANMAKU_SKIP++))
                fi
              else
                ((TOTAL_DANMAKU_SKIP++))
                compressed_files+=("${cache_dir}/${filename}")
              fi
            fi # 结束核心条件判断
          fi
        fi
      else
        log warn "视频文件不存在或无法访问：$video_file"
      fi
    done

    if [[ "$streamer_name" == "括弧笑bilibili" && " ${update_servers[*]} " == *" $recording_platform "* ]]; then
      # 构建视频标题（优化样式：日期 + 标题，标题用中括号包裹）
      upload_title_1="${formatted_start_time_4} [${stream_title}]"
      upload_files_count=${#compressed_files[@]}

      upload_total_size=0
      for f in "${compressed_files[@]}"; do
        s=$(stat -c%s "$f" 2>/dev/null || echo 0)
        (( upload_total_size += s ))
      done

      if [[ "$ENABLE_VIDEO_UPLOAD" != "true" ]]; then
        log warn "上传已被禁用，跳过投稿步骤（共 ${upload_files_count} 个文件，总计 $(format_size $upload_total_size)）"
        danmu_version_cache_dir="${source_backup}/videos/${streamer_name}/禁用投稿/压制版/${formatted_start_time_3}/"
      else
        log info "开始上传视频 —— ${upload_files_count} 个文件，总计 $(format_size $upload_total_size)"
        for f in "${compressed_files[@]}"; do
          fs=$(stat -c%s "$f" 2>/dev/null || echo 0)
          log info "  待上传文件: $(basename "$f") ($(format_size $fs))"
        done
        # 正常发布
        # 视频信息获取及弹幕/封面信息（JSON格式）
        cover_json=$(python3 /rec/脚本/视频信息获取.py "$cache_dir")
        biliup_cover_image=$(echo "$cover_json" | jq -r '.cover_path')
        danmaku_count=$(echo "$cover_json" | jq -r '.danmaku_count')
        cover_timestamp=$(echo "$cover_json" | jq -r '.cover_time')
        cover_p_num=$(echo "$cover_json" | jq -r '.cover_p')
        log info "获取封面图片路径：$biliup_cover_image"
        log info "弹幕总数：${danmaku_count:-0}，封面时间节点：${cover_timestamp:-0}，所在分P：${cover_p_num:-0}"

        upload_desc_1=$(generate_upload_desc "$stream_title" "$formatted_start_time_2" "${danmaku_count:-0}" "${cover_timestamp:-0}" "${cover_p_num:-0}")

        # 检测封面文件是否存在 ===
        cover_args=() # 初始化一个空数组
        if [[ -f "$biliup_cover_image" ]]; then
            log info "封面文件存在，已添加封面参数。"
            cover_args=("--cover" "$biliup_cover_image")
        else
            log warn "封面文件不存在或路径无效，跳过封面上传。"
        fi
        # ==================================

        UPLOAD_START_TS=$(date +%s)

        biliup_upload_output=$("$source_backup/biliup/biliup" -u "${biliup_up_cookies}" upload \
          --copyright 2 \
          "${cover_args[@]}" \
          --source https://live.bilibili.com/1962720 \
          --tid 17 \
          --title "$upload_title_1" \
          --desc "$upload_desc_1" \
          --tag "直播回放,奶茶猪,娱乐主播" \
        "${compressed_files[@]}")

        UPLOAD_ELAPSED=$(( $(date +%s) - UPLOAD_START_TS ))
        if echo "$biliup_upload_output" | grep -q "投稿成功"; then
          log success "投稿成功（耗时:${UPLOAD_ELAPSED}s）"
          danmu_version_cache_dir="${source_backup}/videos/${streamer_name}/压制版/${formatted_start_time_3}/"
          ((TOTAL_UPLOAD_OK++))
        else
          log error "投稿失败（耗时:${UPLOAD_ELAPSED}s），请检查"
          danmu_version_cache_dir="${source_backup}/videos/${streamer_name}/投稿失败/压制版/${formatted_start_time_3}/"
          ((TOTAL_UPLOAD_FAIL++))
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

        log info "备份原始录制文件"

        target_dir="${source_backup}/videos/${streamer_name}/原文件/${formatted_start_time_3}/"
        mkdir -p "$target_dir"

        mv "${cache_dir}"/*.mp4 "$target_dir" 2>/dev/null
        mv "${cache_dir}"/*.flv "$target_dir" 2>/dev/null
        mv "${cache_dir}"/*.xml "$target_dir" 2>/dev/null

        src_mp4_count=$(find "$cache_dir" -maxdepth 1 -name "*.mp4" 2>/dev/null | wc -l)
        src_flv_count=$(find "$cache_dir" -maxdepth 1 -name "*.flv" 2>/dev/null | wc -l)
        src_xml_count=$(find "$cache_dir" -maxdepth 1 -name "*.xml" 2>/dev/null | wc -l)
        log info "源文件统计 —— MP4:${src_mp4_count} FLV:${src_flv_count} XML:${src_xml_count}"

        log info "备份完成：源文件已移动到 $target_dir"

        # =============================
        # 提取原始视频的音频
        # =============================
        if [[ "$ENABLE_ASR_SUBMIT" == "true" || "$ENABLE_AUDIO_EXTRACT" == "true" ]]; then
          log info "开始从原始视频中提取音频"
          audio_extract_ok=0
          audio_extract_fail=0
          for video_file in "$target_dir"*.mp4 "$target_dir"*.flv; do
            if [[ -f "$video_file" ]]; then
              audio_file="${video_file%.*}.aac"
              AUDIO_START_TS=$(date +%s%N)
              log info "提取音频: $(basename "$video_file") -> $(basename "$audio_file")"
              if ffmpeg -i "$video_file" -vn -c:a copy -loglevel error -y "$audio_file"; then
                AUDIO_ELAPSED=$(( ($(date +%s%N) - AUDIO_START_TS) / 1000000 ))
                log success "音频提取成功（耗时:${AUDIO_ELAPSED}ms）: $(basename "$audio_file")"
                audio_files+=("$audio_file")
                ((audio_extract_ok++))
              else
                AUDIO_ELAPSED=$(( ($(date +%s%N) - AUDIO_START_TS) / 1000000 ))
                log error "音频提取失败（耗时:${AUDIO_ELAPSED}ms）: $video_file"
                ((audio_extract_fail++))
              fi
            fi
          done
          log info "音频提取完成 —— 成功:${audio_extract_ok} 失败:${audio_extract_fail}"
        fi

        # =============================
        # 提交音频到语音识别后端
        # =============================
        if [[ "$ENABLE_ASR_SUBMIT" == "true" && "${#audio_files[@]}" -gt 0 ]]; then
          ASR_SERVER="${ASR_SERVER:-192.168.50.5}"
          ASR_PORT="${ASR_PORT:-8286}"
          ASR_PATH_TYPE="${ASR_PATH_TYPE:-windows}"
          asr_submit_ok=0
          asr_submit_fail=0
          log info "提交 ${#audio_files[@]} 个音频文件到语音识别后端 ${ASR_SERVER}:${ASR_PORT} (类型: ${ASR_PATH_TYPE})"
          for audio_file in "${audio_files[@]}"; do
            if [[ "$ASR_PATH_TYPE" == "linux" ]]; then
              remote_path="$audio_file"
            else
              remote_path=$(echo "$audio_file" | sed \
                -e 's|/|\\|g' \
                -e "s|^\\\\rec\\\\videos|$ASR_REMOTE_PATH|" \
                -e 's|\\|\\\\|g')
            fi
            log info "提交语音识别任务: $(basename "$audio_file")"
            response=$(curl -s --connect-timeout 5 --max-time 5 -X POST "http://${ASR_SERVER}:${ASR_PORT}/submit_task" \
              -H "Content-Type: application/json" \
              -d "{\"audio_path\": \"$remote_path\", \"device\": \"auto\"}")
            if echo "$response" | grep -q "task_id"; then
              task_id=$(echo "$response" | grep -o '"task_id":"[^"]*"' | cut -d'"' -f4)
              log success "语音识别任务已提交: $task_id"
              ((asr_submit_ok++))
            else
              log error "语音识别任务提交失败: $response"
              ((asr_submit_fail++))
            fi
          done
          log info "语音识别提交完成 —— 成功:${asr_submit_ok} 失败:${asr_submit_fail}"
        fi
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

    BACKUP_ELAPSED=$(( $(date +%s) - BACKUP_START_TS ))
    log info "备份目录处理完毕（耗时:${BACKUP_ELAPSED}s）"

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

        rclone_total=$(find "$cache_dir" -type f 2>/dev/null | wc -l)
        rclone_size=$(dir_video_size "$cache_dir")
        log info "rclone 开始上传 —— 目标: ${rclone_backup_path}${formatted_start_time_3}/bilibili/$recording_platform/ 文件数:${rclone_total} 总大小:$(format_size $rclone_size)"
        RCLONE_START_TS=$(date +%s)
        if rclone move "$cache_dir" "${rclone_backup_path}${formatted_start_time_3}/bilibili/$recording_platform/"; then
          RCLONE_ELAPSED=$(( $(date +%s) - RCLONE_START_TS ))
          log success "rclone 网盘备份成功（耗时:${RCLONE_ELAPSED}s），共上传 ${rclone_total} 个文件"
          ((TOTAL_RCLONE_OK++))
          if [ -z "$(ls -A "$cache_dir")" ]; then
            log info "删除本地空文件夹: $cache_dir"
            rmdir "$cache_dir"
          fi
        else
          RCLONE_ELAPSED=$(( $(date +%s) - RCLONE_START_TS ))
          upload_success=false
          log error "rclone 网盘备份失败（耗时:${RCLONE_ELAPSED}s），请检查"
          ((TOTAL_RCLONE_FAIL++))
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
  CLEANUP_START_TS=$(date +%s)
  log info "开始清理超过 ${RETENTION_DAYS} 天的旧视频目录（按自然日计算）..."

  DRY_RUN=false
  MAX_DELETE=8

  delete_count=0
  scanned_count=0
  total_freed_bytes=0

  cutoff_date=$(date -d "${RETENTION_DAYS} days ago" +%Y-%m-%d)

  log info "自然日截止日期: ${cutoff_date} （早于此日期的将删除）"

  while read -r dir_path; do
    ((scanned_count++))
    dir_name=$(basename "$dir_path")

    if date -d "$dir_name" >/dev/null 2>&1; then

      if [[ "$dir_name" < "$cutoff_date" ]]; then

        del_size=$(du -sb "$dir_path" 2>/dev/null | cut -f1)
        (( total_freed_bytes += del_size ))

        if [[ "$DRY_RUN" == "true" ]]; then
          log warn "[DRY-RUN] 将删除目录: $dir_path (日期: $dir_name, 大小:$(format_size $del_size))"
        else
          log info "删除目录: $dir_path (日期: $dir_name, 大小:$(format_size $del_size))"
          rm -rf --one-file-system -- "$dir_path"
        fi

        ((delete_count++))
        ((TOTAL_DELETED_DIRS++))

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
      \( -path "*/压制版/*" -o -path "*/原文件/*" \) \
      -name "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]"
  )

  if [[ "$DRY_RUN" != "true" ]]; then
    empty_before=$(find "${source_backup}/videos" -type d -empty 2>/dev/null | wc -l)
    find "${source_backup}/videos" -type d -empty -delete
    empty_after=$(find "${source_backup}/videos" -type d -empty 2>/dev/null | wc -l)
    log info "清理空目录: 清理前 ${empty_before} 个, 清理后 ${empty_after} 个"
  fi

  CLEANUP_ELAPSED=$(( $(date +%s) - CLEANUP_START_TS ))
  log success "清理完成（耗时:${CLEANUP_ELAPSED}s），共扫描 ${scanned_count} 个目录，删除 ${delete_count} 个目录（释放 $(format_size $total_freed_bytes)）"

else
  log info "已禁用自动清理，跳过清理"
fi

# ===================== 执行汇总 =====================
SCRIPT_ELAPSED=$(( $(date +%s) - SCRIPT_START_TS ))
log info "═══════════════════════════════════════════════"
log info "  脚本执行汇总"
log info "═══════════════════════════════════════════════"
log info "  总耗时: ${SCRIPT_ELAPSED}s"
log info "  处理的录制目录: ${TOTAL_DIR_PROCESSED} 个（失败 ${TOTAL_DIR_FAILED} 个）"
log info "  清理小视频: ${TOTAL_CLEANED_SMALL} 个"
log info "  文件移动: ${TOTAL_FILES_MOVED} 个"
log info "  FLV→MP4转换: 成功 ${TOTAL_CONVERT_OK} / 失败 ${TOTAL_CONVERT_FAIL}"
log info "  弹幕压制: 成功 ${TOTAL_DANMAKU_OK} / 跳过 ${TOTAL_DANMAKU_SKIP}"
log info "  B站投稿: 成功 ${TOTAL_UPLOAD_OK} / 失败 ${TOTAL_UPLOAD_FAIL}"
log info "  网盘备份: 成功 ${TOTAL_RCLONE_OK} / 失败 ${TOTAL_RCLONE_FAIL}"
log info "  旧视频清理: ${TOTAL_DELETED_DIRS} 个目录"
log info "═══════════════════════════════════════════════"
log info "脚本执行完毕"
