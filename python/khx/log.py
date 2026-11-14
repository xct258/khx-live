"""日志初始化。

约定：
  - 全局 logger 名称固定为 "khx"，其余模块用 logging.getLogger("khx.xxx")。
  - 控制台只输出 INFO 以上，方便 docker logs 直接看进度。
  - 文件输出 DEBUG，按 10MB 轮转，保留 5 份。
  - 处理单个任务时，额外写一份 logs/jobs/<job_id>.log，
    方便只拿一场录播的日志去排查。
"""

from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

from .util import ensure_dir

LOG_FORMAT = "[%(asctime)s] [%(levelname)s] %(message)s"
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"


def setup_logging(
    log_dir: Path, job_id: str | None = None, *, verbose: bool = False
) -> logging.Logger:
    """创建/重建 khx logger。

    每次调用都会先清空旧 handler，这样测试里反复初始化不会重复打印。

    参数：
        log_dir: 日志根目录
        job_id:  任务 id；传入时额外生成按任务拆分的日志文件
        verbose: 控制台是否输出 DEBUG
    """
    logger = logging.getLogger("khx")
    logger.setLevel(logging.DEBUG)
    logger.propagate = False

    # 清空旧 handler，避免重复输出
    for handler in list(logger.handlers):
        logger.removeHandler(handler)
        handler.close()

    formatter = logging.Formatter(LOG_FORMAT, datefmt=DATE_FORMAT)

    # ---- 控制台 ----
    console = logging.StreamHandler()
    console.setLevel(logging.DEBUG if verbose else logging.INFO)
    console.setFormatter(formatter)
    logger.addHandler(console)

    # ---- 主日志文件 ----
    ensure_dir(log_dir)
    main_file = RotatingFileHandler(
        log_dir / "khx.log",
        maxBytes=10 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    main_file.setLevel(logging.DEBUG)
    main_file.setFormatter(formatter)
    logger.addHandler(main_file)

    # ---- 单任务日志 ----
    if job_id:
        job_dir = ensure_dir(log_dir / "jobs")
        job_file = RotatingFileHandler(
            job_dir / f"{job_id}.log",
            maxBytes=10 * 1024 * 1024,
            backupCount=2,
            encoding="utf-8",
        )
        job_file.setLevel(logging.DEBUG)
        job_file.setFormatter(formatter)
        logger.addHandler(job_file)

    return logger


def get_logger(name: str = "khx") -> logging.Logger:
    """获取子 logger，例如 get_logger("khx.media")。"""
    return logging.getLogger(name)
