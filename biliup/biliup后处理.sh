#!/bin/bash

# 读取输入数据并存入数组
input_files=()
while read line; do
  input_files+=("$line")
done

# 遍历每个输入文件
for input_file in "${input_files[@]}"; do
  # 如果文件不存在（可能已经被上一步作为同名 xml 顺带移动走了），则跳过
  if [ ! -e "$input_file" ]; then
    continue
  fi

  # 去除文件路径
  base_filename=$(basename "$input_file")
  
  # 1. 获取开播时间
  broadcast_start_time=$(echo "$base_filename" | cut -d '_' -f 2)
  
  # 2. 处理开播时间格式（提取出 2025-03-28）
  formatted_start_time_4=$(echo "$broadcast_start_time" | sed -E 's/([0-9]{4})年([0-9]{2})月([0-9]{2})日.*/\1-\2-\3/')

  # 3. 精准获取主播名称（核心修改）
  # 逻辑：只截取最后一个下划线“_”之后、点号“.”之前的内容
  streamer_name=$(echo "$base_filename" | sed -E 's/.*_([^_]+)\.[a-zA-Z0-9]+$/\1/')

  # 备份目录
  backup_dir="video/${streamer_name}/${formatted_start_time_4}"
  mkdir -p "$backup_dir"
  
  # 4. 判断如果是 flv，则查找并移动同名 xml
  if [[ "$input_file" == *.flv ]]; then
    # 将后缀 .flv 替换为 .xml，得到同名 xml 的完整路径
    xml_file="${input_file%.flv}.xml"
    
    # 检查该 xml 文件是否存在
    if [ -f "$xml_file" ]; then
      mv "$xml_file" "$backup_dir"/
      echo "已联动移动同名 XML: $(basename "$xml_file")"
    fi
  fi

  # 5. 移动当前处理的文件（flv 或 其他文件）
  mv "$input_file" "$backup_dir"/
  echo "已移动主文件: $base_filename -> $backup_dir/"
done
