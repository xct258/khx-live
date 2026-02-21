#!/bin/bash

# 提示用户输入文件夹路径
read -p "请输入-deleted结尾的视频文件的文件夹路径: " folder_path

# 检查文件夹是否存在
if [ ! -d "$folder_path" ]; then
    echo "错误：文件夹不存在！"
    exit 1
fi

# 初始化数组
deleted_files=()

# 遍历文件夹下所有文件
for f in "$folder_path"/*; do
    # 判断文件是否以 -deleted.mp4 结尾
    if [[ -f "$f" && "$f" == *-deleted.mp4 ]]; then
        deleted_files+=("$f")   # 添加到数组
    fi
done

# 检查是否找到文件
if [ ${#deleted_files[@]} -eq 0 ]; then
    echo "没有找到以 -deleted.mp4 结尾的文件。"
    exit 0
fi

# 遍历文件夹中以 -deleted.mp4 结尾的文件
for file in "${deleted_files[@]}"; do
    # 去除文件路径
    base_filename=$(basename "$file")
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
    recording_platform=$(echo "$base_filename" | cut -d'_' -f 1 | sed 's/^压制版-//')
    # 示例：录播姬

    # 获取主播名称
    streamer_name=$(echo "$base_filename" | sed -E 's/.*_([^-]+)-deleted\.mp4$/\1/')

    if [[ "$streamer_name" == "高机动持盾军官" ]]; then
      streamer_name="括弧笑bilibili"
    fi

    # 调用获取最大剩余容量网盘的脚本（JSON 输出）
    rclone_onedrive_max_remote_json=$("/rec/脚本/自动选择onedrive网盘.sh")
    rclone_onedrive_config=$(echo "$rclone_onedrive_max_remote_json" | jq -r '.remote')
    rclone_onedrive_free_gb=$(echo "$rclone_onedrive_max_remote_json" | jq -r '.free_gb')

    # 检查是否找到可用网盘
    if [[ -n "$rclone_onedrive_config" && "$rclone_onedrive_config" != "null" ]]; then
        if [[ "$streamer_name" == "括弧笑bilibili" ]]; then
            rclone_backup_path="$rclone_onedrive_config:/直播录制/括弧笑/"
        else
            rclone_backup_path="$rclone_onedrive_config:/直播录制/${streamer_name}/"
        fi
        rclone move "$file" "${rclone_backup_path}/b站投稿没有过审的片段/${formatted_start_time_3}/$recording_platform/" -P
    else
        echo "没有找到合适的网盘"
    fi
done