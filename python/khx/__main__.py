"""khx-live Python 版：命令行入口。

用法示例：
    python -m khx --config config.toml check
    python -m khx --config config.toml once --dir /rec/录播姬/video/某主播/2026-11-13
    python -m khx --config config.toml watch
    python -m khx --config config.toml status
    python -m khx --config config.toml retry 2026-11-13_195657
    python -m khx --config config.toml cleanup
    python -m khx --config config.toml sync
"""

from __future__ import annotations

import argparse
import fcntl
import shutil
import sys
import time
from pathlib import Path

from .config import Config, ConfigError, load_config
from .log import setup_logging
from .pipeline import (
    cleanup_archives,
    discover_dirs,
    is_idle,
    process_source_dir,
    resume_incomplete_jobs,
    retry,
)
from .recorder import sync_all
from .state import job_file, list_jobs, load_job
from .util import ensure_dir

# 清理旧录播的间隔（秒）。守护进程每小时跑一次即可。
CLEANUP_INTERVAL = 3600


# ---------------------------------------------------------------------------
# 子命令
# ---------------------------------------------------------------------------


def cmd_watch(config: Config, config_path: Path, logger) -> int:
    """常驻监控：录制结束 -> 自动处理。"""
    _acquire_watch_lock(config, logger)

    logger.info("开始监控：%s", ", ".join(str(path) for path in config.watch.source_folders))
    logger.info("轮询间隔 %s 秒，静默判定 %s 分钟", config.watch.poll_seconds, config.watch.idle_minutes)

    last_cleanup = 0.0
    config_mtime = config_path.stat().st_mtime

    while True:
        try:
            # ---- 配置热加载：改完 config.toml 不用重启 ----
            current_mtime = config_path.stat().st_mtime
            if current_mtime != config_mtime:
                config = load_config(config_path)
                config_mtime = current_mtime
                logger.info("配置已重新加载")

            # ---- 恢复上次中断的任务 ----
            resume_incomplete_jobs(config, logger)

            # ---- 处理已下播的目录 ----
            for directory in discover_dirs(config):
                if not is_idle(directory, config.watch.idle_minutes):
                    logger.debug("仍在写入，跳过：%s", directory)
                    continue
                process_source_dir(config, directory, logger)

            # ---- 定期清理 ----
            if time.time() - last_cleanup >= CLEANUP_INTERVAL:
                deleted = cleanup_archives(config, logger)
                logger.info("旧录播清理完成，删除 %s 个日期目录", deleted)
                last_cleanup = time.time()

        except Exception:  # 守护进程不能因为单次异常退出
            logger.exception("监控循环异常，%s 秒后重试", config.watch.poll_seconds)

        time.sleep(config.watch.poll_seconds)


def cmd_once(config: Config, directory: Path, logger) -> int:
    """手动处理一个录制目录，不等待静默判定。"""
    if not directory.is_dir():
        logger.error("目录不存在：%s", directory)
        return 1
    if not is_idle(directory, config.watch.idle_minutes):
        logger.warning("目录里仍有近期写入，请确认录制已结束：%s", directory)

    ok = process_source_dir(config, directory, logger)
    return 0 if ok else 1


def cmd_status(config: Config, job_id: str | None, logger) -> int:
    """查看任务状态。"""
    if job_id:
        path = job_file(config.general.data_dir, job_id)
        if not path.is_file():
            logger.error("找不到任务：%s", job_id)
            return 1
        jobs = [load_job(path)]
    else:
        jobs = list_jobs(config.general.data_dir)
        if not jobs:
            logger.info("还没有任务记录")
            return 0

    for job in jobs:
        print(f"\n任务 {job.id}  主播={job.streamer}  标题={job.stream_title or '-'}")
        print(f"  开播时间：{job.start_time}")
        print(f"  缓存目录：{job.work_dir}")
        for step, info in job.steps.items():
            status = info.get("status", "pending")
            detail = info.get("detail", "")
            marker = {
                "done": "✅",
                "skipped": "⏭️",
                "failed": "❌",
                "running": "⏳",
            }.get(status, "·")
            print(f"  {marker} {step:<15} {status:<8} {detail}")

        upload_info = job.outputs.get("upload") or {}
        if upload_info:
            print(f"  投稿：{'成功' if upload_info.get('ok') else '失败'}")
    return 0


def cmd_retry(config: Config, job_id: str, logger) -> int:
    return 0 if retry(config, job_id, logger) else 1


def cmd_cleanup(config: Config, logger) -> int:
    deleted = cleanup_archives(config, logger)
    logger.info("清理完成，删除 %s 个日期目录", deleted)
    return 0


def cmd_sync(config: Config, logger) -> int:
    changed = sync_all(config, logger)
    logger.info("同步完成（%s）", "有更新" if changed else "无变化")
    return 0


def cmd_check(config: Config, logger) -> int:
    """部署前自检：外部命令、cookies、目录权限。"""
    errors = 0

    for command in ("ffmpeg", "ffprobe"):
        if shutil.which(command):
            logger.info("✅ %s 已安装", command)
        else:
            logger.error("❌ 找不到 %s", command)
            errors += 1

    for streamer in config.enabled_streamers():
        logger.info("---- 主播 %s（%s）----", streamer.id, streamer.name)

        if streamer.danmaku.enabled and not streamer.danmaku.factory.is_file():
            logger.error("❌ DanmakuFactory 不存在：%s", streamer.danmaku.factory)
            errors += 1

        if streamer.upload.enabled:
            if not streamer.upload.biliup.is_file():
                logger.error("❌ biliup 不存在：%s", streamer.upload.biliup)
                errors += 1
            if not streamer.upload.cookies.is_file():
                logger.error("❌ 投稿 cookies 不存在：%s", streamer.upload.cookies)
                errors += 1

        if streamer.room_id is not None and not config.recorder.config_path.is_file():
            logger.warning("⚠️ 录播姬配置不存在，sync 会跳过：%s", config.recorder.config_path)

    # 目录可写检查：真正写一个临时文件，比只看权限位可靠
    for directory in (
        config.general.work_dir,
        config.general.videos_dir,
        config.general.data_dir,
        config.general.log_dir,
    ):
        try:
            ensure_dir(directory)
            probe_file = directory / ".khx_write_test"
            probe_file.write_text("ok", encoding="utf-8")
            probe_file.unlink()
            logger.info("✅ 目录可写：%s", directory)
        except OSError as exc:
            logger.error("❌ 目录不可写：%s（%s）", directory, exc)
            errors += 1

    if errors:
        logger.error("自检失败，共 %s 个问题", errors)
        return 1
    logger.info("自检通过")
    return 0


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------


def _acquire_watch_lock(config: Config, logger) -> None:
    """保证同一时间只有一个 watch 进程，避免重复处理。"""
    lock_path = ensure_dir(config.general.data_dir) / "khx.watch.lock"
    handle = lock_path.open("w")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        logger.error("已有 watch 进程在运行（锁文件 %s）", lock_path)
        raise SystemExit(1)
    # 把句柄挂在模块上，进程存活期间不释放
    global _WATCH_LOCK_HANDLE
    _WATCH_LOCK_HANDLE = handle


_WATCH_LOCK_HANDLE = None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="khx",
        description="通用直播录播处理：录制监控 -> 弹幕压制 -> B站投稿 -> 归档清理",
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=Path("config.toml"),
        help="配置文件路径（默认 ./config.toml）",
    )
    parser.add_argument("--verbose", action="store_true", help="控制台输出 DEBUG 日志")

    # 让 --config/--verbose 也能写在子命令后面：
    # 子解析器用 SUPPRESS 默认值，避免把主解析器的值覆盖成 None。
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--config", type=Path, default=argparse.SUPPRESS)
    common.add_argument("--verbose", action="store_true", default=argparse.SUPPRESS)

    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser(
        "watch", parents=[common], help="常驻监控，录制结束后自动处理"
    )

    once = subparsers.add_parser(
        "once", parents=[common], help="立即处理一个录制目录"
    )
    once.add_argument("--dir", type=Path, required=True, help="录制目录")

    status = subparsers.add_parser("status", parents=[common], help="查看任务状态")
    status.add_argument("job_id", nargs="?", help="任务 id；不填则列出全部")

    retry_parser = subparsers.add_parser(
        "retry", parents=[common], help="重试失败任务"
    )
    retry_parser.add_argument("job_id", help="任务 id")

    subparsers.add_parser("cleanup", parents=[common], help="按保留天数清理旧录播")
    subparsers.add_parser("sync", parents=[common], help="同步 cookies 和录播姬房间配置")
    subparsers.add_parser("check", parents=[common], help="部署前自检")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        config = load_config(args.config)
    except ConfigError as exc:
        print(f"配置错误：{exc}", file=sys.stderr)
        return 2

    logger = setup_logging(config.general.log_dir, verbose=args.verbose)
    logger.info("khx-live 启动（配置：%s，服务器：%s）", args.config, config.general.server_name)

    if args.command == "watch":
        return cmd_watch(config, args.config, logger)
    if args.command == "once":
        return cmd_once(config, args.dir, logger)
    if args.command == "status":
        return cmd_status(config, args.job_id, logger)
    if args.command == "retry":
        return cmd_retry(config, args.job_id, logger)
    if args.command == "cleanup":
        return cmd_cleanup(config, logger)
    if args.command == "sync":
        return cmd_sync(config, logger)
    if args.command == "check":
        return cmd_check(config, logger)

    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
