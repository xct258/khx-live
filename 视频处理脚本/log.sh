#!/bin/bash

# 防止重复加载
[[ -n "${_LOG_LOADED}" ]] && return
# 如果变量 _LOG_LOADED 已定义且非空，说明脚本已加载过，直接返回，避免重复执行

readonly _LOG_LOADED=1
# 设置 _LOG_LOADED 为只读变量并赋值为1，标记脚本已加载

# 日志保留数量
_log_max_files=5
# 设置最大保留日志文件数为5，超过的旧日志将被删除

# 默认日志目录：支持外部通过 LOG_BASE_DIR 环境变量指定
_log_base_dir="${LOG_BASE_DIR:-$(cd "$(dirname "${BASH_SOURCE[2]:-${BASH_SOURCE[1]}}")" && pwd)/logs}"
# 获取当前脚本所在目录，拼接 logs 文件夹路径，作为日志存储根目录

# 作用域限制变量
declare -gA _log_cleanup_done_map
declare -gA _log_file_map
# 声明两个全局关联数组变量
# _log_cleanup_done_map 用于标记某个日志目录是否已执行过清理
# _log_file_map 用于保存每个调用脚本对应的当前日志文件路径

# 私有：获取调用脚本名
_log_get_caller_base() {
  local caller="${BASH_SOURCE[2]}"
  # 取调用栈中第三层脚本文件路径（即调用 log 函数的脚本）
  echo "$(basename "$caller" .sh)"
  # 返回调用脚本的文件名（去掉 .sh 后缀）
}

# 私有：清理旧日志
_log_cleanup_once() {
  local base="$1"
  # base 参数表示调用脚本的基础名称，用于定位对应日志目录

  if [[ -z "${_log_cleanup_done_map[$base]}" ]]; then
    # 如果该 base 日志目录还没清理过，则进行清理
    local dir="$_log_base_dir/$base"
    # 拼接具体日志目录路径

    if [[ -d "$dir" ]]; then
      # 如果目录存在，则执行清理操作

      find "$dir" -type f -name "*.log" -printf '%T@ %p\n' | sort -nr | \
      # 查找所有日志文件，按文件修改时间（时间戳）排序，最新排前面
      tail -n +$((_log_max_files + 1)) | awk '{print $2}' | xargs -r rm -f --
      # 保留最新的 _log_max_files 个日志，删除更旧的日志文件

      find "$dir" -type d -empty -delete
      # 删除日志目录中空的子目录，保持整洁
    fi

    _log_cleanup_done_map[$base]=1
    # 标记该 base 日志目录已清理，避免重复清理
  fi
}

log_usage() {
  cat << EOF >&2
用法: log 日志级别 日志消息
  日志级别必须是以下之一：debug, success, info, warn, error, fatal
  日志消息是你想记录的文本内容

示例:
  log info "这是一条信息日志"
  log warn "这是警告信息"
  log error "发生了错误"
EOF
}
# 打印日志使用说明到标准错误流，方便用户了解如何调用 log 函数

log() {
  local level message symbol base ts_dir log_dir log_file ts
  # 定义函数局部变量，分别用于存储日志级别、日志消息、符号、基础目录名、时间戳目录、日志目录、日志文件路径、时间字符串

  case "$1" in
    debug|success|info|warn|error|fatal)
      level="$1"
      shift
      ;;
    *)
      echo "无效的日志级别: $1" >&2
      log_usage
      return 1
      ;;
  esac
  # 根据第一个参数判断是否是有效日志级别，若无效则打印用法并返回错误
  # 若有效则保存日志级别变量，并将参数指针右移（剩余为日志消息）

  message="$*"
  # 将剩余参数作为日志消息整体保存（支持带空格的多词消息）

  base=$(_log_get_caller_base)
  # 调用私有函数获取调用脚本的基础名称

  case "$level" in
    debug)   symbol="🐞" ;;
    success) symbol="🎉" ;;
    info)    symbol="✅" ;;
    warn)    symbol="⚠️" ;;
    error)   symbol="❌" ;;
    fatal)   symbol="💀" ;;
  esac
  # 根据日志级别选择对应的 Emoji 符号，用于标记日志类型

  # 下面是日志写入逻辑（保持不变）
  if [[ -z "${_log_file_map[$base]}" ]]; then
    # 如果当前调用脚本没有已打开的日志文件路径，则创建新的日志文件
    ts_dir="$(date '+%Y/%m/%d')"
    # 生成按年月日划分的目录结构，如 2025/07/15

    log_dir="$_log_base_dir/$base/$ts_dir"
    # 拼接完整日志目录路径：基础日志目录 + 调用脚本名 + 日期目录

    mkdir -p "$log_dir"
    # 创建目录，包含中间不存在的目录

    local unique_id="${base}_$(date '+%H时%M分%S秒')"
    # 生成日志文件名唯一标识，包含脚本名 + 当前时间时分秒 + 当前进程号

    _log_file_map[$base]="$log_dir/${unique_id}.log"
    # 记录当前调用脚本对应的日志文件完整路径
  fi

  log_file="${_log_file_map[$base]}"
  # 取出当前调用脚本对应的日志文件路径

  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  # 生成当前时间戳，格式为 年-月-日 时:分:秒

  echo "[$ts] [$base] $symbol $message" >> "$log_file"
  # 以追加方式写入日志，格式示例：
  # [2025-07-15 22:30:45] [myscript] ✅ 这是一条信息日志

  _log_cleanup_once "$base"
  # 执行一次清理旧日志的操作（但实际只有第一次调用时执行）
}
