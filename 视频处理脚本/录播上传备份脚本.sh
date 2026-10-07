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

# 是否将原版视频追加到指定VID
should_append_raw_video() {
  [[ "$ENABLE_APPEND_RAW_VIDEO" == "true" ]]
}

# ===================== 按月追加：辅助函数 =====================
# 从时间戳 2026年10月04日20点01分22秒 提取月份键 2026-10 / 中文 2026年10月
month_key_from_timestr() {
  echo "$1" | grep -oE '[0-9]{4}年[0-9]{2}月' | head -1 | sed -E 's/([0-9]{4})年([0-9]{2})月/\1-\2/'
}
month_cn_from_timestr() {
  echo "$1" | grep -oE '[0-9]{4}年[0-9]{2}月' | head -1
}
# 从文件名提取完整时间戳，提不到回退 $2
file_time_from_filename() {
  local fn="$1" fallback="$2" t
  t=$(echo "$fn" | grep -oE '[0-9]{4}年[0-9]{2}月[0-9]{2}日[0-9]{2}点[0-9]{2}分[0-9]{2}秒' | head -1)
  [[ -z "$t" ]] && t="$fallback"
  echo "$t"
}
# 月映射内存缓存：键为 主播|YYYY-MM，值为 VID
declare -A MONTH_VID_CACHE
monthly_map_file() {
  echo "${APPEND_MONTHLY_MAP_FILE:-/rec/data/append_month_vid.map}"
}
monthly_map_load() {
  local map f key val
  map=$(monthly_map_file)
  [[ -f "$map" ]] || return 0
  while IFS='=' read -r key val; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    key=$(echo "$key" | xargs); val=$(echo "$val" | xargs)
    [[ -n "$key" && -n "$val" ]] && MONTH_VID_CACHE["$key"]="$val"
  done < "$map"
}
monthly_map_get() {
  echo "${MONTH_VID_CACHE[$1]}"
}
monthly_map_set() {
  local key="$1" vid="$2" map tmp
  MONTH_VID_CACHE["$key"]="$vid"
  map=$(monthly_map_file)
  mkdir -p "$(dirname "$map")"
  touch "$map"
  tmp="${map}.tmp.$$"
  awk -F'=' -v k="$key" '$1!=k' "$map" > "$tmp" 2>/dev/null || cp "$map" "$tmp"
  echo "${key}=${vid}" >> "$tmp"
  mv "$tmp" "$map"
}
# 将一组已排序文件追加到指定 VID（内部做临时重命名，保证有序）
# 用法：append_group_to_vid <vid> <start_idx> <文件...>
append_group_to_vid() {
  local vid="$1"; shift
  local start_idx="$1"; shift
  local files=("$@")
  local append_src=() append_tmp=()
  local -A seen_tmp=()
  local idx=$start_idx f filename ext file_time new_name suffix
  for f in "${files[@]}"; do
    [[ ! -f "$f" ]] && continue
    filename=$(basename "$f")
    ext="${filename##*.}"
    file_time=$(file_time_from_filename "$filename" "$start_time")
    if (( idx == 0 )); then
      new_name="${file_time}.${ext}"
    else
      new_name="${file_time}_${idx}.${ext}"
    fi
    suffix=$idx
    while [[ -e "${cache_dir}/${new_name}" ]] || [[ -n "${seen_tmp[$new_name]}" ]]; do
      ((suffix++))
      new_name="${file_time}_${suffix}.${ext}"
    done
    seen_tmp[$new_name]=1
    append_src+=("$f")
    append_tmp+=("$new_name")
    log info "追加命名：$filename -> $new_name（第$((idx+1))P -> ${vid}）"
    ((idx++))
  done
  local i
  for i in "${!append_src[@]}"; do
    f="${append_src[$i]}"
    new_name="${append_tmp[$i]}"
    filename=$(basename "$f")
    mv "$f" "${cache_dir}/${new_name}"
    APPEND_START_TS=$(date +%s)
    append_output=$("$source_backup/biliup/biliup" -u "${biliup_up_cookies}" append --vid "$vid" "${cache_dir}/${new_name}" 2>&1)
    append_exit=$?
    APPEND_ELAPSED=$(( $(date +%s) - APPEND_START_TS ))
    mv "${cache_dir}/${new_name}" "$f"
    if [[ $append_exit -eq 0 ]] && echo "$append_output" | grep -q "稿件修改成功"; then
      log success "追加成功（耗时:${APPEND_ELAPSED}s）：$filename -> $new_name -> ${vid}"
      ((TOTAL_APPEND_OK++))
      APPEND_SUCCEEDED+=("$f")
    else
      log error "追加失败（耗时:${APPEND_ELAPSED}s）：$filename ($new_name -> ${vid})"
      echo "$append_output" | tail -n 10 | while IFS= read -r l; do log error "[biliup-append] $l"; done
      ((TOTAL_APPEND_FAIL++))
      upload_success=false
    fi
  done
}
# 用首个视频新建月稿件，成功写入映射并存入 $MONTHLY_NEW_VID，失败返回非0
# 参数：$1=map_key(如 主播|2026-10) $2=标题 $3=简介 $4=首个视频文件路径
MONTHLY_NEW_VID=""
monthly_create_vid() {
  local map_key="$1" title="$2" desc="$3" first_video="$4" out vid
  MONTHLY_NEW_VID=""
  log info "按月追加：${map_key} 无映射，用首个视频新建稿件：$(basename "$first_video")"
  log info "新建稿件标题：$title"
  log info "新建稿件简介：$desc"
  cover_args=()
  if [[ -f "${APPEND_MONTHLY_COVER:-/rec/assets/封面.jpg}" ]]; then
    cover_args=(--cover "${APPEND_MONTHLY_COVER:-/rec/assets/封面.jpg}")
    log info "按月追加：使用封面 ${APPEND_MONTHLY_COVER:-/rec/assets/封面.jpg}"
  else
    log warn "按月追加：封面不存在，跳过封面上传：${APPEND_MONTHLY_COVER:-/rec/assets/封面.jpg}"
  fi
  out=$("$source_backup/biliup/biliup" -u "${biliup_up_cookies}" upload \
    --copyright 2 \
    "${cover_args[@]}" \
    --source https://live.bilibili.com/1962720 \
    --tid 17 \
    --title "$title" \
    --desc "$desc" \
    --tag "直播回放,奶茶猪,娱乐主播" \
    "$first_video" 2>&1)
  echo "$out" | tail -n 20 | while IFS= read -r l; do log info "[biliup-upload] $l"; done
  if ! echo "$out" | grep -q "投稿成功"; then
    log error "按月追加：新建稿件失败（${map_key}），请检查上面的 biliup 输出"
    return 1
  fi
  vid=$(echo "$out" | grep -oE 'BV[0-9A-Za-z]{10}|av[0-9]+' | head -1)
  if [[ -z "$vid" ]]; then
    # 兜底：upload 输出不带 BV 时，用标题反查最新稿件列表
    log warn "按月追加：输出中无 BV/AV 号，尝试用标题反查：$title"
    list_out=$("$source_backup/biliup/biliup" -u "${biliup_up_cookies}" list -m 1 2>&1)
    vid=$(echo "$list_out" | grep -F "$title" | grep -oE 'BV[0-9A-Za-z]{10}|av[0-9]+' | head -1)
  fi
  if [[ -z "$vid" ]]; then
    log error "按月追加：投稿成功但未解析到 BV/AV 号（${map_key}），请从日志手动补写映射文件：$(monthly_map_file)"
    return 1
  fi
  monthly_map_set "$map_key" "$vid"
  log success "按月追加：新建稿件成功 ${map_key} -> ${vid}"
  MONTHLY_NEW_VID="$vid"
  return 0
}

# 上传已追加视频的配对 XML 到 webdav（覆盖写，按主播/年/月/日期归组）
# 用法：upload_xml_for_files <YYYY-MM> <视频文件...>
# 只传追加成功的视频（APPEND_SUCCEDED 内），无配对 xml 则跳过
upload_xml_for_files() {
  local mk="$1"; shift
  # 调用方已在追加块内（ENABLE_APPEND_RAW_VIDEO 开启），此处不再设开关
  if ! command -v rclone >/dev/null 2>&1; then
    log warn "按月传XML：未找到 rclone，跳过上传"
    return 0
  fi
  local remote="${RCLONE_XML_REMOTE:-openlist-webdav}"
  local path_tpl="${RCLONE_XML_PATH_TEMPLATE:-}"
  if [[ -z "$path_tpl" ]]; then path_tpl='直播录制弹幕/{streamer}/{yyyy}/{mm}/{date}'; fi
  local f filename xml ft yyyy mm dd date month dest
  for f in "$@"; do
    local hit=0 s
    for s in ${APPEND_SUCCEEDED[@]+"${APPEND_SUCCEEDED[@]}"}; do
      [[ "$s" == "$f" ]] && { hit=1; break; }
    done
    (( hit )) || continue
    filename=$(basename "$f")
    xml="${f%.*}.xml"
    if [[ ! -f "$xml" ]]; then
      log warn "按月传XML：无配对弹幕文件，跳过：$filename"
      continue
    fi
    ft=$(file_time_from_filename "$filename" "$start_time")
    yyyy=$(echo "$ft" | sed -E 's/^([0-9]{4})年.*/\1/')
    mm=$(echo "$ft" | sed -E 's/^[0-9]{4}年([0-9]{2})月.*/\1/')
    dd=$(echo "$ft" | sed -E 's/^[0-9]{4}年[0-9]{2}月([0-9]{2})日.*/\1/')
    if [[ -z "$yyyy" || -z "$mm" || -z "$dd" ]]; then
      log warn "按月传XML：无法解析日期，跳过：$filename"
      continue
    fi
    month="${yyyy}-${mm}"
    date="${month}-${dd}"
    subdir=$(echo "$path_tpl" | sed -e "s/{streamer}/${streamer_name}/g" -e "s/{yyyy}/${yyyy}/g" -e "s/{mm}/${mm}/g" -e "s/{dd}/${dd}/g" -e "s/{month}/${month}/g" -e "s/{date}/${date}/g")
    subdir="${subdir#/}"
    dest="${remote}:/${subdir}/$(basename "$xml")"
    rout=$(rclone copyto "$xml" "$dest" 2>&1)
    rc=$?
    echo "$rout" | tail -n 3 | while IFS= read -r l; do log info "[rclone-xml] $l"; done
    if (( rc == 0 )); then
      log success "XML已传webdav（覆盖）：$(basename "$xml") -> ${yyyy}-${mm}-${dd}/"
      ((TOTAL_RCLONE_XML_OK++))
    else
      log error "XML上传webdav失败：$(basename "$xml")"
      ((TOTAL_RCLONE_XML_FAIL++))
    fi
  done
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
log info "配置状态 —— 弹幕压制:${ENABLE_DANMAKU_OVERLAY:-false} 压制模式:${DANMAKU_MODE:-both} 视频上传:${ENABLE_VIDEO_UPLOAD:-false} 网盘备份:${ENABLE_RCLONE_UPLOAD:-false} 自动清理:${ENABLE_CLEANUP:-false} FLV转换:${CONVERT_FLV_TO_MP4:-false} 原版追加:${ENABLE_APPEND_RAW_VIDEO:-false}"
log info "追加模式: 按月分稿件 月映射: ${APPEND_MONTHLY_MAP_FILE:-/rec/data/append_month_vid.map}"
log info "保留天数: ${RETENTION_DAYS:-3} 天"

# 加载按月追加映射（不存在则视为空，本次新建后会写回）
monthly_map_load

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
TOTAL_APPEND_OK=0            # 追加投稿成功数
TOTAL_APPEND_FAIL=0          # 追加投稿失败数
TOTAL_RCLONE_OK=0            # 网盘备份成功数
TOTAL_RCLONE_FAIL=0          # 网盘备份失败数
TOTAL_RCLONE_XML_OK=0        # webdav弹幕xml上传成功数
TOTAL_RCLONE_XML_FAIL=0      # webdav弹幕xml上传失败数
TOTAL_DELETED_DIRS=0         # 清理删除的目录数
APPEND_SUCCEEDED=()          # 本次运行追加成功的视频（用于配对xml上传）

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

    # 清理当前目录中的 txt/log 日志文件（计数并记录名称）
    log_count=$(find "$dir" -type f \( -iname "*.txt" -o -iname "*.log" \) 2>/dev/null | wc -l)
    if [[ "$log_count" -gt 0 ]]; then
      log_files=$(find "$dir" -type f \( -iname "*.txt" -o -iname "*.log" \) -printf "%f、" 2>/dev/null | sed 's/、$//')
      log info "发现 ${log_count} 个日志文件（${log_files}），正在清理"
      find "$dir" -type f \( -iname "*.txt" -o -iname "*.log" \) -delete 2>/dev/null
    fi

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
      fsize=$(stat -c%s "$f" 2>/dev/null || echo 0)
      mv "$f" "$cache_dir/"
      ((moved_count++))
      ((moved_size += fsize))
    done < <(find "$dir" -type f -print0 2>/dev/null)

    TOTAL_FILES_MOVED=$((TOTAL_FILES_MOVED + moved_count))
    log info "移动完成 —— 共 ${moved_count} 个文件，视频总大小:$(format_size $moved_size)"
    rmdir "$dir" 2>/dev/null || true
    cache_dirs+=("$cache_dir")

    # 记录处理前信息
    pre_count=$(find "$cache_dir" -type f \( -name "*.mp4" -o -name "*.flv" -o -name "*.xml" \) 2>/dev/null | wc -l)
    pre_size=$(dir_video_size "$cache_dir")
    log info "处理前信息 —— 文件数:${pre_count} 视频总大小:$(format_size $pre_size)"

    # --- 第一阶段：成组清理（视频+XML 联动，<10MB 整组删，孤儿 XML 单删） ---
    mapfile -d '' -t temp_files < <(find "$cache_dir" -type f \( -name "*.flv" -o -name "*.mp4" -o -name "*.xml" \) -print0 | sort -z)
    input_files=()
    clean_count=0
    for file in "${temp_files[@]}"; do
      [[ ! -f "$file" ]] && continue
      base_path="${file%.*}"
      ext="${file##*.}"
      if [[ "$ext" == "xml" ]]; then
        if [[ -f "${base_path}.mp4" ]]; then vid_file="${base_path}.mp4"
        elif [[ -f "${base_path}.flv" ]]; then vid_file="${base_path}.flv"
        else vid_file=""; fi
      else
        vid_file="$file"
      fi
      if [[ -n "$vid_file" ]]; then
        vsize=$(stat -c%s "$vid_file" 2>/dev/null || echo 0)
        if (( vsize < 10485760 )); then
          log info "关联视频过小 (<10MB)，清理该组文件: $base_path.* (大小:$(format_size $vsize))"
          rm -f "${base_path}.mp4" "${base_path}.flv" "${base_path}.xml"
          ((clean_count++))
          ((TOTAL_CLEANED_SMALL++))
          continue
        fi
      else
        if [[ "$ext" == "xml" ]]; then
          log info "发现无视频关联的孤儿 XML，执行清理: $file"
          rm -f "$file"
          ((clean_count++))
          continue
        fi
      fi
      input_files+=("$file")
    done

    if [[ $clean_count -gt 0 ]]; then
      log info "第一阶段完成：共清理 ${clean_count} 组小文件/孤儿 XML"
    fi

    # --- 第二阶段：有效文件确认 ---
    if [[ ${#input_files[@]} -eq 0 ]]; then
        log info "清理小文件后，${cache_dir} 中已无有效视频，跳过"
        continue
    fi
    log info "真正剩余有效文件 ${#input_files[@]} 个"

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
                # 计时兼容：%N 不可用时退回秒级
                START_RAW=$(date +%s%N 2>/dev/null)
                if [[ "$START_RAW" == *N ]]; then
                    CONV_START_TS=$(date +%s)
                    TIME_UNIT="s"
                else
                    CONV_START_TS=$(( START_RAW / 1000000 ))
                    TIME_UNIT="ms"
                fi
                # -fflags +genpts：杜绝转码后音画不同步与首帧黑屏
                if ffmpeg -fflags +genpts -i "$file" -c:v copy -c:a copy -loglevel error -y "$output_file"; then
                    END_RAW=$(date +%s%N 2>/dev/null)
                    if [[ "$TIME_UNIT" == "s" ]]; then
                        CONV_ELAPSED=$(( $(date +%s) - CONV_START_TS ))
                    else
                        CONV_ELAPSED=$(( (END_RAW / 1000000) - CONV_START_TS ))
                    fi
                    out_size=$(stat -c%s "$output_file" 2>/dev/null || echo 0)
                    rm -f "$file"
                    log success "转换成功（耗时:${CONV_ELAPSED}${TIME_UNIT} 输出大小:$(format_size $out_size)），已清理源文件"
                    ((TOTAL_CONVERT_OK++))
                else
                    END_RAW=$(date +%s%N 2>/dev/null)
                    if [[ "$TIME_UNIT" == "s" ]]; then
                        CONV_ELAPSED=$(( $(date +%s) - CONV_START_TS ))
                    else
                        CONV_ELAPSED=$(( (END_RAW / 1000000) - CONV_START_TS ))
                    fi
                    log error "转换失败（耗时:${CONV_ELAPSED}${TIME_UNIT}）：$file，保留原视频"
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
    append_files=()

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

    log info "直播标题: $stream_title"
    log info "录制平台: $recording_platform"
    log info "主播名称: $streamer_name"
    log info "开播时间: $start_time"
    log info "上传标题: ${formatted_start_time_4} [${stream_title}]"

    # =============================
    # 预收集：按月追加原版视频到月稿件（在压制之前）
    # =============================
    if should_append_raw_video; then
      # 收集所有非投稿版的原始视频文件
      for video_file in "${input_files[@]}"; do
        [[ ! -f "$video_file" ]] && continue
        filename=$(basename "$video_file")
        [[ "$filename" == 投稿版-* ]] && continue
        ext="${filename##*.}"
        [[ "$ext" != "mp4" && "$ext" != "flv" ]] && continue
        append_files+=("${cache_dir}/${filename}")
      done

      if [[ ${#append_files[@]} -eq 0 ]]; then
        log info "无可追加的原版视频，跳过追加"
      else
        # ---------- 按月分稿件追加（整目录按首文件月份归组） ----------
        mapfile -t sorted_append < <(printf '%s\n' "${append_files[@]}" | sort)
        # 月份只看本目录首文件：首文件是9月，整组录播就归9月
        first_append_fn=$(basename "${sorted_append[0]}")
        first_append_ft=$(file_time_from_filename "$first_append_fn" "$start_time")
        mk=$(month_key_from_timestr "$first_append_ft")
        [[ -z "$mk" ]] && mk=$(month_key_from_timestr "$start_time")
        if [[ -z "$mk" ]]; then
          log error "按月追加：无法解析月份（首文件：$first_append_fn），本目录跳过"
          ((TOTAL_APPEND_FAIL+=${#sorted_append[@]}))
          upload_success=false
        else
          group=("${sorted_append[@]}")
          map_key="${streamer_name}|${mk}"
          vid=$(monthly_map_get "$map_key")
          if [[ -n "$vid" ]]; then
            log info "按月追加：${mk} 共 ${#group[@]} 个文件 -> 既有稿件 ${vid}"
            append_group_to_vid "$vid" 0 "${group[@]}"
            upload_xml_for_files "$mk" "${group[@]}"
          else
            # 无映射：用组内首个文件新建月稿件，首文件即 P1，不再重复 append
            month_cn=$(echo "$mk" | sed -E 's/([0-9]{4})-([0-9]{2})/\1年\2月/')
            title_tpl="${APPEND_MONTHLY_TITLE_TEMPLATE:-}"
            if [[ -z "$title_tpl" ]]; then title_tpl='{streamer} {month_cn} 直播回放}'; fi
            new_title=$(echo "$title_tpl" | sed -e "s/{streamer}/${streamer_name}/g" -e "s/{month}/${mk}/g" -e "s/{month_cn}/${month_cn}/g")
            desc_tpl="${APPEND_MONTHLY_DESC_TEMPLATE:-}"
            if [[ -z "$desc_tpl" ]]; then desc_tpl='本稿件为{streamer}{month_cn}原版直播回放合集，每次直播追加为一个分P。}'; fi
            new_desc=$(echo "$desc_tpl" | sed -e "s/{streamer}/${streamer_name}/g" -e "s/{month}/${mk}/g" -e "s/{month_cn}/${month_cn}/g")
            # 网盘地址占位：{pan_url} = 前缀/{streamer}/{yyyy}/{mm}，中文直写不编码
            if echo "$new_desc" | grep -q "{pan_url}"; then
              pan_yyyy=$(echo "$mk" | cut -d- -f1)
              pan_mm=$(echo "$mk" | cut -d- -f2)
              pan_url="${RCLONE_XML_PAN_URL:-https://openlist.xct258.top/直播回放弹幕}/${streamer_name}/${pan_yyyy}/${pan_mm}"
              new_desc=$(echo "$new_desc" | sed -e "s|{pan_url}|$pan_url|g")
            fi
            first_f="${group[0]}"
            first_fn=$(basename "$first_f")
            first_ext="${first_fn##*.}"
            first_ft=$(file_time_from_filename "$first_fn" "$start_time")
            first_tmp="${first_ft}.${first_ext}"
            suffix=0
            while [[ -e "${cache_dir}/${first_tmp}" ]]; do
              ((suffix++))
              first_tmp="${first_ft}_${suffix}.${first_ext}"
            done
            mv "$first_f" "${cache_dir}/${first_tmp}"
            if monthly_create_vid "$map_key" "$new_title" "$new_desc" "${cache_dir}/${first_tmp}"; then
              new_vid="$MONTHLY_NEW_VID"
              mv "${cache_dir}/${first_tmp}" "$first_f"
              ((TOTAL_APPEND_OK++))
              APPEND_SUCCEEDED+=("$first_f")
              log success "按月追加：首文件已作为新稿件 P1（${new_vid}）：$first_fn -> $first_tmp"
              if [[ ${#group[@]} -gt 1 ]]; then
                append_group_to_vid "$new_vid" 1 "${group[@]:1}"
              fi
              upload_xml_for_files "$mk" "${group[@]}"
            else
              mv "${cache_dir}/${first_tmp}" "$first_f"
              log error "按月追加：${mk} 新建稿件失败，本组 ${#group[@]} 个文件跳过"
              ((TOTAL_APPEND_FAIL+=${#group[@]}))
              upload_success=false
            fi
          fi
        fi
      fi
    fi

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
              true # 已清理：预收集已全量追加，此处不再重复入队
            
            # ==================== 2. 启用后，再检查弹幕 XML 是否存在 ====================
            elif [[ ! -f "${cache_dir}/${xml_file}" ]]; then
              danmaku_reason="未检测到弹幕 XML 文件"
              log warn "未检测到弹幕 XML 文件，跳过弹幕压制：${cache_dir}/${xml_file}"
              true # 已清理：预收集已全量追加，此处不再重复入队

            # ==================== 3. 存在后，再检查弹幕内容是否符合规则 ====================
            elif ! grep -aEq '^\s*<(d|sc|gift|guard)' "${cache_dir}/${xml_file}"; then
              danmaku_reason="弹幕文件内容为空或不符合预期"
              log warn "弹幕文件内容为空或不符合预期，跳过弹幕压制：${cache_dir}/${xml_file}"
              true # 已清理：预收集已全量追加，此处不再重复入队

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
                # 输出模式由 DANMAKU_MODE 配置控制：
                # --mode both/all:       生成投稿版(无进度条) + 预览版(无进度条)
                # --mode clean:          只生成投稿版(无进度条)，不生成预览版
                # --mode both-bar:       生成投稿版(无进度条) + 预览版(带进度条)
                # --mode preview:        只生成预览版(带进度条)
                # --mode preview-clean:  只生成预览版(无进度条)
                if python3 /rec/脚本/压制视频.py "${cache_dir}/${xml_file}" --mode "${DANMAKU_MODE:-both}"; then
                  DANMAKU_ELAPSED=$(( $(date +%s) - DANMAKU_START_TS ))
                  if [[ -s "${cache_dir}/${output_file}" ]]; then
                    out_size=$(stat -c%s "${cache_dir}/${output_file}" 2>/dev/null || echo 0)
                    log success "视频弹幕压制完成（耗时:${DANMAKU_ELAPSED}s 输出大小:$(format_size $out_size)）：$output_file"
                    compressed_files+=("${cache_dir}/${output_file}")
                    ((TOTAL_DANMAKU_OK++))
                  else
                    log error "压制脚本执行成功但未生成目标文件（耗时:${DANMAKU_ELAPSED}s），使用原视频：$filename"
                    true # 已清理：预收集已全量追加，此处不再重复入队
                    ((TOTAL_DANMAKU_SKIP++))
                  fi
                else
                  DANMAKU_ELAPSED=$(( $(date +%s) - DANMAKU_START_TS ))
                  log error "视频弹幕压制失败（耗时:${DANMAKU_ELAPSED}s）：$output_file"
                  true # 已清理：预收集已全量追加，此处不再重复入队
                  ((TOTAL_DANMAKU_SKIP++))
                fi
              else
                ((TOTAL_DANMAKU_SKIP++))
                true # 已清理：预收集已全量追加，此处不再重复入队
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
        # 固定落点：禁用投稿也不改目录，保证在线切片/语音识别路径稳定
        danmu_version_cache_dir="${source_backup}/videos/${streamer_name}/压制版/${formatted_start_time_3}/"
      elif [[ ${#compressed_files[@]} -eq 0 ]]; then
        log warn "没有需要投稿的文件（未压制视频已追加到指定稿件），跳过新投稿"
        danmu_version_cache_dir="${source_backup}/videos/${streamer_name}/压制版/${formatted_start_time_3}/"
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
          log error "投稿失败（耗时:${UPLOAD_ELAPSED}s），状态记入日志，文件仍按固定落点备份，请检查"
          # 固定落点：投稿失败也不改目录，保证在线切片/语音识别路径稳定
          danmu_version_cache_dir="${source_backup}/videos/${streamer_name}/压制版/${formatted_start_time_3}/"
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
          log info "开始从原始视频中提取音频 (M4A)"
          audio_extract_ok=0
          audio_extract_fail=0
          for video_file in "$target_dir"*.mp4 "$target_dir"*.flv; do
            if [[ -f "$video_file" ]]; then
              # 1. 将后缀名修改为 .m4a
              audio_file="${video_file%.*}.m4a"
              AUDIO_START_TS=$(date +%s%N)
              log info "提取音频: $(basename "$video_file") -> $(basename "$audio_file")"
              
              # 2. 修改 ffmpeg 参数：使用 -c:a aac 确保网页端兼容性更好（可快进、拖动时间轴）
              if ffmpeg -i "$video_file" -vn -c:a aac -loglevel error -y "$audio_file"; then
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
        # 找到第一个不符合条件的文件并赋值给变量（加入了 txt, srt, m4a）
        unexpected_file=$(find "$cache_dir" -type f \
          ! -iname "*.log" \
          ! -iname "*.jpg" \
          ! -iname "*.txt" \
          ! -iname "*.srt" \
          ! -iname "*.acc" \
          ! -iname "*.m4a" \
          -print -quit)
          
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
log info "  追加投稿: 成功 ${TOTAL_APPEND_OK} / 失败 ${TOTAL_APPEND_FAIL}"
log info "  网盘备份: 成功 ${TOTAL_RCLONE_OK} / 失败 ${TOTAL_RCLONE_FAIL}"
log info "  webdav弹幕: 成功 ${TOTAL_RCLONE_XML_OK} / 失败 ${TOTAL_RCLONE_XML_FAIL}"
log info "  旧视频清理: ${TOTAL_DELETED_DIRS} 个目录"
log info "═══════════════════════════════════════════════"
log info "脚本执行完毕"
