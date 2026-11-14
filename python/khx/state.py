"""任务状态：一场录播对应一个 JSON 文件。

为什么不用数据库：
    每天只有一两个任务，状态量很小。JSON 文件可读、可手改、便于排查，
    也省掉连接管理和迁移。写入使用 util.atomic_write_json，
    进程被 kill 时不会留下半截文件。

状态约定：
    pending  还没开始
    running  正在执行（进程崩了下次启动会重置为 pending）
    done     成功
    failed   失败，detail 里有原因
    skipped  按配置或校验规则主动跳过
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from .util import atomic_write_json, ensure_dir, read_json

# 文件名里的时间：录播姬_2026年11月13日19点56分57秒_标题_主播.flv
_START_TIME_PATTERN = re.compile(
    r"(\d{4})年(\d{2})月(\d{2})日(\d{2})点(\d{2})分(\d{2})秒"
)


def now_text() -> str:
    """统一的时间戳格式，写日志和状态都用它。"""
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def job_id_from_start_time(start_time: str) -> str:
    """把 2026年11月13日19点56分57秒 转成 2026-11-13_195657。

    解析失败时退回当前时间，保证任务仍能落盘。
    """
    match = _START_TIME_PATTERN.search(start_time)
    if not match:
        return datetime.now().strftime("%Y-%m-%d_%H%M%S")
    year, month, day, hour, minute, second = match.groups()
    return f"{year}-{month}-{day}_{hour}{minute}{second}"


def date_parts(start_time: str) -> tuple[str, str, str, str]:
    """从文件名时间提取归档需要的信息。

    返回 (中文日期, 年, 月, YYYY-MM-DD)，例如：
        2026年11月13日, 2026, 11, 2026-11-13
    """
    match = _START_TIME_PATTERN.search(start_time)
    if not match:
        today = datetime.now()
        year, month, day = today.strftime("%Y"), today.strftime("%m"), today.strftime("%d")
    else:
        year, month, day = match.group(1), match.group(2), match.group(3)

    return f"{year}年{month}月{day}日", year, month, f"{year}-{month}-{day}"


@dataclass
class Job:
    """一场录播的完整处理状态。"""

    id: str
    streamer_id: str                    # 配置里的主播 id
    platform: str                       # 录制平台，例如“录播姬”
    streamer: str                       # 归档目录名
    stream_title: str                   # 直播标题
    start_time: str                     # 文件名里的开播时间
    source_dir: str                     # 录制源目录（文件搬走后可能为空）
    work_dir: str                       # 处理中的缓存目录
    created_at: str = field(default_factory=now_text)

    # 每一步的状态，结构：{步骤名: {status, started_at, finished_at, detail}}
    steps: dict[str, dict[str, Any]] = field(default_factory=dict)

    # 各步骤产出的附加信息（例如压制版路径、封面、投稿结果）
    outputs: dict[str, Any] = field(default_factory=dict)

    # ---- 便捷访问 ----
    def status_of(self, step: str) -> str:
        return str(self.steps.get(step, {}).get("status", "pending"))

    def is_done(self, step: str) -> bool:
        return self.status_of(step) == "done"

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "streamer_id": self.streamer_id,
            "platform": self.platform,
            "streamer": self.streamer,
            "stream_title": self.stream_title,
            "start_time": self.start_time,
            "source_dir": self.source_dir,
            "work_dir": self.work_dir,
            "created_at": self.created_at,
            "steps": self.steps,
            "outputs": self.outputs,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Job":
        """从 JSON 还原。

        只取已知字段，忽略多余键，方便以后加字段时旧状态文件仍能读。
        """
        return cls(
            id=str(data["id"]),
            streamer_id=str(data.get("streamer_id", "")),
            platform=str(data.get("platform", "录播姬")),
            streamer=str(data.get("streamer", "")),
            stream_title=str(data.get("stream_title", "")),
            start_time=str(data.get("start_time", "")),
            source_dir=str(data.get("source_dir", "")),
            work_dir=str(data.get("work_dir", "")),
            created_at=str(data.get("created_at", now_text())),
            steps=dict(data.get("steps", {})),
            outputs=dict(data.get("outputs", {})),
        )


# ---------------------------------------------------------------------------
# 状态流转
# ---------------------------------------------------------------------------


def begin(job: Job, step: str, detail: str = "") -> None:
    """标记某一步开始执行。重复执行时会覆盖上一次的失败记录。"""
    job.steps[step] = {
        "status": "running",
        "started_at": now_text(),
        "finished_at": None,
        "detail": detail,
    }


def finish(job: Job, step: str, detail: str = "") -> None:
    """标记成功。detail 写人话，例如“压制版 8.2GB，耗时 1h32m”。"""
    info = job.steps.setdefault(step, {})
    info.update(
        {
            "status": "done",
            "finished_at": now_text(),
            "detail": detail,
        }
    )


def fail(job: Job, step: str, error: str) -> None:
    """标记失败，保留 started_at 便于计算耗时。"""
    info = job.steps.setdefault(step, {})
    info.update(
        {
            "status": "failed",
            "finished_at": now_text(),
            "detail": error,
        }
    )


def skip(job: Job, step: str, reason: str) -> None:
    """主动跳过（配置关闭、校验不通过等）。"""
    info = job.steps.setdefault(step, {})
    info.update(
        {
            "status": "skipped",
            "finished_at": now_text(),
            "detail": reason,
        }
    )


def reset_running(job: Job) -> None:
    """把崩溃残留的 running 改回 pending，避免重跑时误以为已完成。"""
    for info in job.steps.values():
        if info.get("status") == "running":
            info["status"] = "pending"
            info["detail"] = "上次执行中断，已重置"


# ---------------------------------------------------------------------------
# 读写
# ---------------------------------------------------------------------------


def job_file(data_dir: Path, job_id: str) -> Path:
    return data_dir / "jobs" / f"{job_id}.json"


def save_job(data_dir: Path, job: Job) -> Path:
    """保存任务状态，返回文件路径。"""
    path = job_file(data_dir, job.id)
    ensure_dir(path.parent)
    atomic_write_json(path, job.to_dict())
    return path


def load_job(path: Path) -> Job:
    return Job.from_dict(read_json(path))


def list_jobs(data_dir: Path) -> list[Job]:
    """按创建时间倒序返回所有任务。"""
    job_dir = data_dir / "jobs"
    if not job_dir.is_dir():
        return []
    jobs = []
    for path in job_dir.glob("*.json"):
        try:
            jobs.append(load_job(path))
        except (OSError, ValueError, KeyError):
            # 单个状态文件损坏不应影响其它任务
            continue
    jobs.sort(key=lambda item: item.created_at, reverse=True)
    return jobs
