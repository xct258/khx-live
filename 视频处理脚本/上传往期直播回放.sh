#!/bin/bash
set -x
# 引入日志脚本
source /root/apps/脚本/上传往期视频回放/log.sh

log info "上传任务开始"

# === 基本路径 ===
WORK_DIR="/root/apps/脚本/上传往期视频回放"
RCLONE_REMOTE="onedrive-video-7:直播录制/括弧笑/2023/02"
DST_DIR="$WORK_DIR/video"
CACHE_DIR="$WORK_DIR/cache"
COVER_DIR="$WORK_DIR/covers"
COVER_DIR_BACKUP="$WORK_DIR/covers_backup"
UPLOAD_LOG="$CACHE_DIR/upload_log.txt"

# 初始化
mkdir -p "$DST_DIR" "$CACHE_DIR" "$COVER_DIR_BACKUP"
[[ -f "$UPLOAD_LOG" ]] || touch "$UPLOAD_LOG"
log info "初始化目录和日志文件完成"

select_unused_cover() {
    log info "开始选择未使用的封面图片"
    mapfile -t all_covers < <(find "$COVER_DIR" -type f \( -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" -o -iname "*.webp" \))
    log debug "找到封面总数：${#all_covers[@]}"
    mapfile -t used_covers < <(awk -F "封面: " '/封面:/ {print $2}' "$UPLOAD_LOG")
    log debug "已使用封面数量：${#used_covers[@]}"

    mapfile -t unused_covers < <(comm -23 \
        <(printf "%s\n" "${all_covers[@]}" | sort) \
        <(printf "%s\n" "${used_covers[@]}" | sort))

    log info "未使用的封面数量：${#unused_covers[@]}"
    if [[ ${#unused_covers[@]} -eq 0 ]]; then
        log error "所有封面已使用。"
        return 1
    fi

    local rand_index=$((RANDOM % ${#unused_covers[@]}))
    local original="${unused_covers[$rand_index]}"
    local cover="$original"

    log info "随机选择封面：$original"
    if [[ "$original" == *.webp ]]; then
        cover="${original%.webp}.jpg"
        if [[ ! -f "$cover" ]]; then
            log info "转换 WebP 为 JPG: $original -> $cover"
            if ffmpeg -loglevel error -y -i "$original" -q:v 2 "$cover"; then
                log info "删除原始 WebP: $original"
                rm -f "$original"
            else
                log error "转换失败: $original"
                return 1
            fi
        else
            log info "对应 JPG 封面已存在，无需转换"
        fi
    fi

    echo "$cover"
    return 0
}

log info "开始列出远程目录"
mapfile -t subdirs < <(
    rclone lsd "$RCLONE_REMOTE" --max-depth 1 2>/dev/null | awk '{print $NF}' |
    sort | while read -r line; do
        if ! grep -q "回放时间: $line" "$UPLOAD_LOG"; then
            echo "$line"
        else
            log debug "目录已上传过，跳过：$line"
        fi
    done
)
log info "待处理远程子目录数量：${#subdirs[@]}"

for dirname in "${subdirs[@]}"; do
    log info "开始处理远程子目录：$dirname"

    if ! biliup_cover_image=$(select_unused_cover); then
        log error "封面用尽，停止处理。"
        exit 1
    fi

    log info "选用封面：$biliup_cover_image"
    local_dst_dir="${DST_DIR}/${dirname}"
    log info "准备复制远程目录到本地：$RCLONE_REMOTE/$dirname -> $local_dst_dir"

    if ! rclone copy "$RCLONE_REMOTE/$dirname" "$local_dst_dir" -P; then
        log error "rclone 复制失败，跳过目录 $dirname"
        continue
    fi
    log info "rclone 复制完成：$dirname"

    mapfile -t video_files < <(
        find "$local_dst_dir" -type f \( -iname "*.mp4" -o -iname "*.flv" \) | sort
    )

    log info "在目录 $dirname 中找到视频文件数量：${#video_files[@]}"

    if [[ ${#video_files[@]} -gt 0 ]]; then
        log info "开始上传视频文件..."
        upload_output=$(
            /rec/biliup/biliup -u "$WORK_DIR/cookies-烦心事远离.json" upload \
                --copyright 2 \
                --cover "$biliup_cover_image" \
                --source https://live.bilibili.com/1962720 \
                --tid 17 \
                --title "$dirname" \
                --desc "硬盘空间回收，不定期投稿没有上传过的直播回放" \
                --tag "搞笑,直播回放,奶茶猪,高机动持盾军官,括弧笑,娱乐主播" \
                "${video_files[@]}" 2>&1
        )
        log debug "上传命令输出：$upload_output"

        log_entry="完成时间：$(date '+%Y-%m-%d') | 回放时间: $dirname | 封面: $biliup_cover_image"

        if echo "$upload_output" | grep -q "投稿成功"; then
            log success "投稿成功，删除本地缓存目录：$local_dst_dir"
            rm -rf "$local_dst_dir"
            echo "$log_entry | 状态: 成功" >> "$UPLOAD_LOG"
            mv "$biliup_cover_image" "$COVER_DIR_BACKUP/"
            log info "封面已移动到备份目录"
        else
            log warn "投稿失败，保留本地文件，目录：$local_dst_dir"
            echo "$log_entry | 状态: 失败" >> "$UPLOAD_LOG"
        fi
    else
        log warn "目录 $dirname 中未找到视频文件，跳过"
    fi
done

log info "上传任务结束"
