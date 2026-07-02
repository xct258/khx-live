#!/bin/bash

# 防止重复加载
[[ -n "${_LOG_LOADED}" ]] && return
# 如果变量 _LOG_LOADED 已定义且非空，说明脚本已加载过，直接返回，避免重复执行

readonly _LOG_LOADED=1
# 设置 _LOG_LOADED 为只读变量并赋值为1，标记脚本已加载

# 日志保留数量：支持外部通过 LOG_MAX_FILES 环境变量指定，未指定则默认为 30
_log_max_files="${LOG_MAX_FILES:-30}"

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
======================================================================
📖 Bash 日志模块 (Logger) 使用说明
======================================================================

【引入方式】
  此脚本为模块库，请勿直接运行。必须在你的业务脚本中引入：
  source /path/to/logger.sh

【基本用法】
  命令: log <日志级别> <日志消息>

  支持的日志级别及效果：
    debug   -> 🐞 (调试信息)
    success -> 🎉 (成功消息)
    info    -> ✅ (常规信息)
    warn    -> ⚠️ (警告信息)
    error   -> ❌ (错误信息)
    fatal   -> 💀 (致命错误)

【环境变量配置】(可选，需在调用前定义)
  LOG_BASE_DIR   自定义日志存储的根目录。
                 默认值: 引入该模块的脚本所在目录下的 logs/ 文件夹
  LOG_MAX_FILES  自定义单个脚本保留的最大历史日志文件数量。
                 默认值: 30

【高级功能】
  命令: log_reset_session
  作用: 清除当前脚本的日志文件路径和清理标记缓存。
  场景: 专为“无限循环/常驻后台”的脚本设计。在脚本循环体中检测到跨天
        (日期变化) 时调用此命令，即可强制生成新日期的日志文件，并自动
        触发旧日志的清理机制。

【示例代码】
  # 1. 常规使用
  log info "正在连接数据库..."
  log error "数据库连接超时！"

  # 2. 自定义配置并引入
  export LOG_MAX_FILES=7
  export LOG_BASE_DIR="/var/log/my_app"
  source ./logger.sh
  log success "服务已启动，日志最多保留7天"

  # 3. 常驻后台脚本跨天自动轮转
  if [[ "\$(date '+%d')" != "\$LAST_DAY" ]]; then
      log_reset_session
      LAST_DAY="\$(date '+%d')"
  fi
======================================================================
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

  # 分配 Emoji 和 终端颜色
  local color_reset="\033[0m"
  local color_code=""

  case "$level" in
    debug)   symbol="🐞"; color_code="\033[38;5;244m" ;; # 灰色
    success) symbol="🎉"; color_code="\033[32m" ;;       # 绿色
    info)    symbol="✅"; color_code="\033[36m" ;;       # 青色
    warn)    symbol="⚠️"; color_code="\033[33m" ;;       # 黄色
    error)   symbol="❌"; color_code="\033[31m" ;;       # 红色
    fatal)   symbol="💀"; color_code="\033[41;37m" ;;    # 红底白字
  esac

  # 下面是日志写入逻辑（保持不变）
  if [[ -z "${_log_file_map[$base]}" ]]; then
    # 如果当前调用脚本没有已打开的日志文件路径，则创建新的日志文件
    ts_dir="$(date '+%Y/%m/%d')"
    # 生成按年月日划分的目录结构，如 2025/07/15

    log_dir="$_log_base_dir/$base/$ts_dir"
    # 拼接完整日志目录路径：基础日志目录 + 调用脚本名 + 日期目录

    mkdir -p "$log_dir"
    # 创建目录，包含中间不存在的目录

    local unique_id="${base}_$(date '+%H时%M分%S秒')_$$"
    # 生成日志文件名唯一标识，包含脚本名 + 当前时间时分秒 + 当前进程号

    _log_file_map[$base]="$log_dir/${unique_id}.log"
    # 记录当前调用脚本对应的日志文件完整路径
  fi

  log_file="${_log_file_map[$base]}"

  # 取出当前调用脚本对应的日志文件路径

  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  # 生成当前时间戳，格式为 年-月-日 时:分:秒

  # 1. 组装纯文本日志，追加到日志文件
  local plain_log="[$ts] [$base] $symbol $message"
  echo "$plain_log" >> "$log_file"

  # 2. 如果当前是在终端交互执行（而不是后台静默运行），则输出带颜色的日志
  if [ -t 1 ]; then
    echo -e "${color_code}[$ts] [$base] $symbol $message${color_reset}"
  fi

  _log_cleanup_once "$base"
}

# 公开：允许外部常驻脚本手动重置日志文件和清理状态
log_reset_session() {
  local caller="${BASH_SOURCE[1]}"
  local base
  base="$(basename "$caller" .sh)"

  # 彻底清除当前调用脚本的缓存和清理标记
  unset "_log_file_map[$base]"
  unset "_log_cleanup_done_map[$base]"
}

# ==========================================
# 模块独立运行处理
# ==========================================
# 判断当前脚本是被直接执行（./logger.sh），还是被 source 引入
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "💡 提示: 这是一个日志模块库文件，请在其他脚本中使用 'source' 引入它，而不是直接运行。" >&2
  echo "----------------------------------------------------------------------" >&2

  # 调用已定义的函数打印使用方法
  log_usage 

  # 正常退出，不执行任何业务逻辑
  exit 0
fi
