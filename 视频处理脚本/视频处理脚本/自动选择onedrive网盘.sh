#!/bin/bash

# 默认值，如果没有符合条件的网盘
output='{"remote": null, "free_gb": 0}'

# 按原始顺序遍历远程网盘
for remote in $(rclone listremotes | sed 's/:$//' | grep -i 'onedrive-video-'); do
    free=$(rclone about "$remote": --json 2>/dev/null | jq -r '.free // 0')

    # 过滤剩余容量 <=50GB
    if (( free <= 50*1024*1024*1024 )); then
        continue
    fi

    # 转换为 GB 并保留两位小数
    free_gb=$(awk "BEGIN {printf \"%.2f\", $free/1024/1024/1024}")

    # 输出 JSON 并退出循环（只返回第一个符合条件的网盘）
    output=$(jq -n --arg remote "$remote" --arg free_gb "$free_gb" \
        '{remote: $remote, free_gb: ($free_gb | tonumber)}')
    break
done

echo "$output"
