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
  # 1. 获取开播时间（这一步不需要动，依然能拿到包含秒的时间段）
  broadcast_start_time=$(echo "$base_filename" | cut -d '_' -f 2 | cut -d '.' -f 1)
  
  # 2. 处理开播时间格式（修改正则，允许后面有任意字符，比如“12秒”）
  formatted_start_time_4=$(echo "$broadcast_start_time" | sed -E 's/([0-9]{4})年([0-9]{2})月([0-9]{2})日([0-9]{2})点([0-9]{2})分.*/\1-\2-\3/')
  # 核心改动：在“分”字后面加了“.*”，把“12秒”顺便一起抹掉，输出依旧是 2025-03-28

  # 3. 获取主播名称（修改正则，精准匹配两个下划线中间的内容）
  streamer_name=$(echo "$base_filename" | sed -E 's/^[^\_]+_[^\_]+_(.*)\.[^\.]+$/\1/')
  # 核心改动：原来的正则较弱，新文件名长度改变后容易误切。改为显式匹配：前缀_时间_【主播名】.后缀


  # 备份目录
  backup_dir=video/${streamer_name}/${formatted_start_time_4}
  # 移动到备份目录
  mkdir -p "$backup_dir"
  mv "$input_file" "$backup_dir"/
done
