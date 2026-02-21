#!/bin/bash

# 读取输入数据并存入数组
input_files=()
while read line; do
  input_files+=("$line")
done

# 遍历每个输入文件
for input_file in "${input_files[@]}"; do
  # 去除文件路径
  base_filename=$(basename "$input_file")
  # 获取开播时间
  broadcast_start_time=$(echo "$base_filename" | cut -d '_' -f 2 | cut -d '.' -f 1)
  # 处理开播时间格式
  formatted_start_time_4=$(echo "$broadcast_start_time" | sed -E 's/([0-9]{4})年([0-9]{2})月([0-9]{2})日([0-9]{2})点([0-9]{2})分/\1-\2-\3/')
  # 示例：2025-03-26
  # 获取主播名称
  streamer_name=$(echo "$base_filename" | sed -E 's/.*_(.*)\..*/\1/')

  # 备份目录
  backup_dir=video/${streamer_name}/${formatted_start_time_4}
  # 移动到备份目录
  mkdir -p "$backup_dir"
  mv "$input_file" "$backup_dir"/
done
