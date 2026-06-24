#!/bin/bash

# 检查是否输入了参数
if [ -z "$1" ]; then
    echo "使用方法: $0 <mp4文件路径> [-s|--short]"
    echo "示例: $0 录播姬_xxx.mp4"
    echo "      $0 录播姬_xxx.mp4 -s (只输出带符号的秒数)"
    exit 1
fi

MP4_FILE="$1"
XML_FILE="${MP4_FILE%.mp4}.xml"
SHORT_MODE=0

# 检查第二个参数是否为简洁模式
if [ "$2" = "-s" ] || [ "$2" = "--short" ]; then
    SHORT_MODE=1
fi

# 1. 检查文件是否存在
if [ ! -f "$MP4_FILE" ]; then
    [ $SHORT_MODE -eq 0 ] && echo "错误: 找不到视频文件 $MP4_FILE"
    exit 1
fi

if [ ! -f "$XML_FILE" ]; then
    [ $SHORT_MODE -eq 0 ] && echo "错误: 找不到对应的弹幕文件 $XML_FILE"
    exit 1
fi

[ $SHORT_MODE -eq 0 ] && echo "正在分析文件，请稍候..."
[ $SHORT_MODE -eq 0 ] && echo "----------------------------------------"

# 2. 获取 MP4 时长（全面清洗）
MP4_SEC=$(ffmpeg -i "$MP4_FILE" 2>&1 | grep "Duration" | awk '{print $2}' | tr -d '[:space:],')
MP4_SEC=$(echo "$MP4_SEC" | awk -F: '{print ($1*3600)+($2*60)+$3}')

# 3. 获取 XML 最后一条弹幕的时间
XML_SEC=$(tail -n 50 "$XML_FILE" | grep -o 'p="[0-9.]*' | tail -n 1 | cut -d'"' -f2 | tr -d '[:space:]')

# 检查是否成功提取到时间
if [ -z "$MP4_SEC" ] || [ -z "$XML_SEC" ]; then
    [ $SHORT_MODE -eq 0 ] && echo "错误: 无法解析视频时长或弹幕时间。"
    exit 1
fi

# 4. 转换秒数为时分秒格式的函数
format_time() {
    local TOTAL_SECS=$(echo "if ($1 < 0) -$1 else $1" | bc)
    TOTAL_SECS=${TOTAL_SECS%.*}
    if [ -z "$TOTAL_SECS" ]; then TOTAL_SECS=0; fi
    
    local HOURS=$((TOTAL_SECS / 3600))
    local MINUTES=$(( (TOTAL_SECS % 3600) / 60 ))
    local SECS=$((TOTAL_SECS % 60))
    printf "%02d:%02d:%02d" $HOURS $MINUTES $SECS
}

# 5. 计算差值
IS_MP4_LONGER=$(awk -v n1="$MP4_SEC" -v n2="$XML_SEC" 'BEGIN{print (n1>n2)?1:0}')
DIFF_SEC=$(echo "$MP4_SEC - $XML_SEC" | bc)

# 6. 输出结果
if [ $SHORT_MODE -eq 1 ]; then
    # 【简洁模式】只输出带符号的秒数
    if [ "$IS_MP4_LONGER" -eq 1 ]; then
        echo "+$(echo "$DIFF_SEC" | bc)"
    elif [ "$(echo "$DIFF_SEC == 0" | bc)" -eq 1 ]; then
        echo "0"
    else
        echo "$(echo "$DIFF_SEC" | bc)" # bc计算负数自带 - 号
    fi
else
    # 【详细模式】原原本本的面板输出
    MP4_HMS=$(format_time "$MP4_SEC")
    XML_HMS=$(format_time "$XML_SEC")
    
    echo "视频文件: $MP4_FILE"
    echo "视频总时长: ${MP4_SEC} 秒 ($MP4_HMS)"
    echo "----------------------------------------"
    echo "弹幕文件: $XML_FILE"
    echo "最后弹幕时间: ${XML_SEC} 秒 ($XML_HMS)"
    echo "----------------------------------------"

    if [ "$IS_MP4_LONGER" -eq 1 ]; then
        ABS_DIFF_SEC=$(echo "$DIFF_SEC" | bc)
        DIFF_HMS=$(format_time "$ABS_DIFF_SEC")
        echo "对比结果: 视频比最后一条弹幕长了 +${ABS_DIFF_SEC} 秒 (+$DIFF_HMS)"
    elif [ "$(echo "$DIFF_SEC == 0" | bc)" -eq 1 ]; then
        echo "对比结果: 视频时长与最后一条弹幕时间完全一致！(00:00:00)"
    else
        ABS_DIFF_SEC=$(echo "-($DIFF_SEC)" | bc)
        DIFF_HMS=$(format_time "$ABS_DIFF_SEC")
        echo "对比结果: 弹幕比视频总时长更长 -${ABS_DIFF_SEC} 秒 (-$DIFF_HMS) [视频比弹幕早结束/分段录制]"
    fi
fi
