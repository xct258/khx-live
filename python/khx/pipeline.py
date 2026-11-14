"""处理流水线：从录制目录到 B 站稿件。

一场录播被拆成 8 个幂等步骤，每步完成后写状态文件：
    scan -> remux -> duration_check -> encode -> cover -> upload -> archive -> cleanup_after

设计原则：
    - 任一步失败立即停止，状态里能看出失败在哪一步；
    - 重跑时已完成步骤直接跳过（retry 命令会重置失败步骤及之后步骤）；
    - 所有主播相关的参数都来自 StreamerConfig，代码里不出现具体主播名。
"""

from __future__ import annotations

import os
import shutil
import time
from datetime import date, datetime, timedelta
from pathlib import Path

from .config import Config, StreamerConfig
from .danmaku import encode, xml_to_ass
from .log import get_logger
from .media import (
    CoverInfo,
    duration_diff,
    parse_recording_name,
    pick_cover,
    probe,
    remux_to_mp4,
)
from .state import (
    Job,
    begin,
    date_parts,
    fail,
    finish,
    job_file,
    job_id_from_start_time,
    list_jobs,
    load_job,
    save_job,
    skip,
)
from .upload import render_desc, render_title, upload
from .util import ensure_dir, human_size

# 小于这个大小的视频视为录制碎片，整组（视频+XML）删除
SMALL_FILE_BYTES = 10 * 1024 * 1024

# 步骤顺序；retry 时从失败步骤开始重置
STEPS = (
    "scan",
    "remux",
    "duration_check",
    "encode",
    "cover",
    "upload",
    "archive",
    "cleanup_after",
)

# 每个步骤返回 (说明, 是否跳过)
StepResult = tuple[str, bool]


# ---------------------------------------------------------------------------
# 主播匹配与目录发现
# ---------------------------------------------------------------------------


def find_streamer(
    config: Config, raw_name: str, directory: Path
) -> StreamerConfig | None:
    """把录制文件里的主播名映射到配置里的主播。

    匹配顺序：
        1. 名字命中 aliases / name / id，且目录在该主播声明的 source_folders 内；
        2. 目录只属于一个声明了 source_folders 的主播（录播姬昵称和配置不一致时兜底）。
    """
    enabled = config.enabled_streamers()

    for streamer in enabled:
        if streamer.source_folders and not _is_under(directory, streamer.source_folders):
            continue
        if streamer.matches(raw_name):
            return streamer

    owners = [
        streamer
        for streamer in enabled
        if streamer.source_folders and _is_under(directory, streamer.source_folders)
    ]
    if len(owners) == 1:
        return owners[0]

    return None


def _is_under(path: Path, roots: list[Path]) -> bool:
    """判断 path 是否在任意一个 root 目录下。"""
    try:
        resolved = path.resolve()
    except OSError:
        resolved = path
    for root in roots:
        try:
            if resolved.is_relative_to(root.resolve()):
                return True
        except OSError:
            continue
    return False


def discover_dirs(config: Config) -> list[Path]:
    """找出所有直接包含视频文件的目录。

    全局 source_folders 和主播自己的 source_folders 会合并去重。
    """
    roots = set(config.watch.source_folders)
    for streamer in config.enabled_streamers():
        roots.update(streamer.source_folders)

    result: list[Path] = []
    for root in roots:
        if not root.is_dir():
            continue
        for current, _subdirs, files in os.walk(root):
            if any(name.lower().endswith((".flv", ".mp4")) for name in files):
                result.append(Path(current))
    return sorted(set(result))


def is_idle(directory: Path, idle_minutes: int) -> bool:
    """目录里所有文件超过 idle_minutes 没有写入，视为录制结束。"""
    latest = 0.0
    for path in directory.rglob("*"):
        if path.is_file():
            latest = max(latest, path.stat().st_mtime)
    if latest == 0.0:
        return True
    return latest <= time.time() - idle_minutes * 60


# ---------------------------------------------------------------------------
# 任务构建
# ---------------------------------------------------------------------------


def build_job(
    config: Config, source_dir: Path, logger=None
) -> Job | None:
    """根据录制目录生成任务。

    返回 None 表示目录里没有视频、文件名无法解析，或主播没有配置。
    """
    logger = logger or get_logger("khx.pipeline")
    videos = sorted(source_dir.glob("*.flv")) + sorted(source_dir.glob("*.mp4"))
    if not videos:
        return None

    first = min(videos, key=lambda path: path.stat().st_mtime)
    try:
        name = parse_recording_name(first.name)
    except ValueError as exc:
        logger.warning("跳过无法解析的文件：%s（%s）", first.name, exc)
        return None

    streamer = find_streamer(config, name.streamer, source_dir)
    if streamer is None:
        logger.warning(
            "未配置的主播：%s（目录 %s）。请在 config.toml 的 [[streamers]] 中添加。",
            name.streamer or "未知",
            source_dir,
        )
        return None

    start_time = name.start_time or _mtime_as_start_time(first)
    job_id = f"{streamer.id}-{job_id_from_start_time(start_time)}"

    return Job(
        id=job_id,
        streamer_id=streamer.id,
        platform=name.platform or "未知",
        streamer=streamer.name,
        stream_title=name.stream_title,
        start_time=start_time,
        source_dir=str(source_dir),
        work_dir=str(config.general.work_dir / streamer.name / start_time),
    )


def _mtime_as_start_time(path: Path) -> str:
    """文件名没有时间戳时，用文件修改时间兜底。"""
    stamp = datetime.fromtimestamp(path.stat().st_mtime)
    return stamp.strftime("%Y年%m月%d日%H点%M分%S秒")


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


def process_source_dir(config: Config, source_dir: Path, logger=None) -> bool:
    """处理一个录制目录；已处理过或上次失败的会跳过。

    这个函数给 watch/once 使用；手动重试请用 retry()。
    """
    logger = logger or get_logger("khx.pipeline")
    job = build_job(config, source_dir, logger)
    if job is None:
        return False

    state_path = job_file(config.general.data_dir, job.id)
    if state_path.is_file():
        existing = load_job(state_path)
        if has_failure(existing):
            logger.warning("任务 %s 上次失败，等待手动 retry，不自动重跑", existing.id)
            return False
        if is_finished(existing):
            logger.info("任务 %s 已完成，跳过", existing.id)
            return False
        job = existing
    else:
        save_job(config.general.data_dir, job)

    return process_job(config, job, logger)


def process_job(config: Config, job: Job, logger=None) -> bool:
    """按步骤执行任务。返回 True 表示全部完成。"""
    logger = logger or get_logger("khx.pipeline")
    streamer = config.streamer_by_id(job.streamer_id)
    if streamer is None:
        raise RuntimeError(f"任务 {job.id} 的主播配置已不存在：{job.streamer_id}")

    reset_running(job)
    save_job(config.general.data_dir, job)

    handlers = {
        "scan": step_scan,
        "remux": step_remux,
        "duration_check": step_duration_check,
        "encode": step_encode,
        "cover": step_cover,
        "upload": step_upload,
        "archive": step_archive,
        "cleanup_after": step_cleanup_after,
    }

    for step in STEPS:
        if job.is_done(step):
            logger.info("跳过已完成步骤：%s", step)
            continue

        logger.info("===== [%s] 开始 %s =====", job.id, step)
        begin(job, step)
        save_job(config.general.data_dir, job)

        try:
            detail, was_skipped = handlers[step](config, streamer, job, logger)
        except Exception as exc:  # 单步失败不应让守护进程退出
            logger.exception("步骤 %s 失败：%s", step, exc)
            fail(job, step, str(exc))
            save_job(config.general.data_dir, job)
            return False

        if was_skipped:
            skip(job, step, detail)
            logger.info("步骤 %s 已跳过：%s", step, detail)
        else:
            finish(job, step, detail)
            logger.info("步骤 %s 完成：%s", step, detail)

        save_job(config.general.data_dir, job)

    logger.info("任务 %s 全部完成", job.id)
    return True


def retry(config: Config, job_id: str, logger=None) -> bool:
    """手动重试：从第一个失败/未完成步骤开始执行。"""
    logger = logger or get_logger("khx.pipeline")
    path = job_file(config.general.data_dir, job_id)
    if not path.is_file():
        logger.error("找不到任务：%s", job_id)
        return False

    job = load_job(path)
    if is_finished(job):
        logger.info("任务 %s 已完成，无需重试", job_id)
        return True

    reset_from_failure(job)
    return process_job(config, job, logger)


def resume_incomplete_jobs(config: Config, logger=None) -> int:
    """恢复“执行到一半进程被杀”的任务。

    只处理既没有失败、也还没完成的（running 会在 process_job 里重置为 pending），
    失败任务仍然需要人工 retry，避免自动重试把错误放大。
    """
    logger = logger or get_logger("khx.pipeline")
    resumed = 0
    for job in list_jobs(config.general.data_dir):
        if is_finished(job) or has_failure(job):
            continue
        if not Path(job.work_dir).is_dir():
            continue
        logger.info("发现未完成任务 %s，继续执行", job.id)
        process_job(config, job, logger)
        resumed += 1
    return resumed


def has_failure(job: Job) -> bool:
    return any(info.get("status") == "failed" for info in job.steps.values())


def is_finished(job: Job) -> bool:
    return all(
        job.status_of(step) in ("done", "skipped") for step in STEPS
    )


def reset_running(job: Job) -> None:
    """把上次崩溃残留的 running 状态改回 pending。"""
    for info in job.steps.values():
        if info.get("status") == "running":
            info["status"] = "pending"
            info["detail"] = "上次执行中断，已重置"


def reset_from_failure(job: Job) -> None:
    """把第一个失败步骤及其后续步骤重置为 pending。"""
    failed_index = None
    for index, step in enumerate(STEPS):
        if job.status_of(step) == "failed":
            failed_index = index
            break
    start_index = failed_index if failed_index is not None else 0
    for step in STEPS[start_index:]:
        job.steps.pop(step, None)


# ---------------------------------------------------------------------------
# 各步骤实现
# ---------------------------------------------------------------------------


def step_scan(
    config: Config, streamer: StreamerConfig, job: Job, logger
) -> StepResult:
    """把源目录文件搬进缓存目录，并清理录制碎片。"""
    work_dir = Path(job.work_dir)
    source_dir = Path(job.source_dir)
    ensure_dir(work_dir)

    moved = 0
    moved_bytes = 0
    if source_dir.resolve() != work_dir.resolve() and source_dir.is_dir():
        for path in sorted(source_dir.iterdir()):
            if not path.is_file():
                continue
            target = work_dir / path.name
            moved_bytes += path.stat().st_size
            shutil.move(str(path), str(target))
            moved += 1
        # 源目录空了就删掉，避免一直在监控列表里
        try:
            source_dir.rmdir()
        except OSError:
            pass

    # ---- 清理碎片：视频 <10MB 的整组删除 ----
    removed = 0
    for video in list(work_dir.glob("*.flv")) + list(work_dir.glob("*.mp4")):
        if video.stat().st_size >= SMALL_FILE_BYTES:
            continue
        logger.info("清理录制碎片：%s（%s）", video.name, human_size(video.stat().st_size))
        video.unlink(missing_ok=True)
        video.with_suffix(".xml").unlink(missing_ok=True)
        removed += 1

    # ---- 清理没有视频的孤儿 XML ----
    for xml_path in work_dir.glob("*.xml"):
        if not any(
            xml_path.with_suffix(suffix).is_file() for suffix in (".mp4", ".flv")
        ):
            logger.info("清理孤儿弹幕：%s", xml_path.name)
            xml_path.unlink(missing_ok=True)
            removed += 1

    kept = sorted(path.name for path in work_dir.iterdir() if path.is_file())
    if not any(name.lower().endswith((".mp4", ".flv")) for name in kept):
        raise RuntimeError("缓存目录里没有有效视频文件")

    job.outputs["files"] = kept
    detail = (
        f"搬入 {moved} 个文件（{human_size(moved_bytes)}），"
        f"清理 {removed} 个碎片，保留 {len(kept)} 个"
    )
    return detail, False


def step_remux(
    config: Config, streamer: StreamerConfig, job: Job, logger
) -> StepResult:
    """FLV -> MP4 无损封装。

    统一转成 MP4 有两个好处：biliup 上传更稳，弹幕压制少一次解码兼容问题。
    """
    work_dir = Path(job.work_dir)
    flv_files = sorted(work_dir.glob("*.flv"))
    if not flv_files:
        return "没有需要封装的 FLV", True

    done = 0
    for flv_path in flv_files:
        mp4_path = flv_path.with_suffix(".mp4")
        # 断点续跑：上次已经封装成功，直接删掉 FLV
        if mp4_path.is_file() and mp4_path.stat().st_size > 0:
            flv_path.unlink(missing_ok=True)
            done += 1
            continue

        remux_to_mp4(flv_path, mp4_path)
        flv_path.unlink(missing_ok=True)
        done += 1

    return f"封装 {done} 个 FLV", False


def step_duration_check(
    config: Config, streamer: StreamerConfig, job: Job, logger
) -> StepResult:
    """检查视频时长和最后一条弹幕的时间差。

    差值过大通常意味着录制分段、网络波动或弹幕文件不完整，
    此时强行压制会出现弹幕整体偏移，所以直接跳过这一P。
    """
    if not streamer.danmaku.enabled:
        return "弹幕压制已关闭，跳过时长校验", True

    work_dir = Path(job.work_dir)
    videos = sorted(work_dir.glob("*.mp4"))
    if not videos:
        raise RuntimeError("没有 MP4 文件可校验")

    pairs = []
    for video in videos:
        xml_path = video.with_suffix(".xml")
        entry = {"video": video.name, "xml": xml_path.name, "ok": False, "reason": ""}

        if not xml_path.is_file():
            entry["reason"] = "缺少弹幕文件"
        else:
            try:
                diff = duration_diff(video, xml_path)
            except Exception as exc:  # 探测失败也按不通过处理
                diff = None
                entry["reason"] = f"时长探测失败：{exc}"

            if diff is None and not entry["reason"]:
                entry["reason"] = "无法解析弹幕时间"
            elif diff is not None:
                entry["diff"] = round(diff, 3)
                if abs(diff) > streamer.danmaku.max_diff_seconds:
                    entry["reason"] = (
                        f"时间差 {diff:+.1f}s 超过 {streamer.danmaku.max_diff_seconds}s"
                    )
                else:
                    entry["ok"] = True

        if not entry["ok"]:
            logger.warning("跳过压制：%s（%s）", video.name, entry["reason"])
        pairs.append(entry)

    job.outputs["pairs"] = pairs
    passed = sum(1 for pair in pairs if pair["ok"])
    return f"{passed}/{len(pairs)} 个视频通过时长校验", False


def step_encode(
    config: Config, streamer: StreamerConfig, job: Job, logger
) -> StepResult:
    """生成投稿版：XML -> ASS -> 烧进画面。"""
    if not streamer.danmaku.enabled:
        return "弹幕压制已关闭，跳过", True

    work_dir = Path(job.work_dir)
    pairs = [pair for pair in job.outputs.get("pairs", []) if pair.get("ok")]
    if not pairs:
        return "没有通过校验的视频，跳过压制", True

    encoded: list[str] = []
    failures: list[str] = []

    for pair in pairs:
        video = work_dir / pair["video"]
        xml_path = work_dir / pair["xml"]
        if not video.is_file() or not xml_path.is_file():
            failures.append(f"{pair['video']}: 文件缺失")
            continue

        try:
            ass_path = xml_to_ass(xml_path, streamer.danmaku)
            output = work_dir / f"投稿版-{video.name}"
            info = probe(video)
            encode(video, ass_path, output, streamer.encode, info.duration)
            encoded.append(str(output))
        except Exception as exc:
            logger.error("压制失败：%s（%s）", video.name, exc)
            failures.append(f"{video.name}: {exc}")

    if not encoded:
        raise RuntimeError("全部视频压制失败：" + "；".join(failures))

    job.outputs["encoded"] = encoded
    total = sum(Path(path).stat().st_size for path in encoded if Path(path).is_file())
    detail = f"压制 {len(encoded)} 个视频，共 {human_size(total)}"
    if failures:
        detail += f"，失败 {len(failures)} 个"
    return detail, False


def step_cover(
    config: Config, streamer: StreamerConfig, job: Job, logger
) -> StepResult:
    """从弹幕峰值处抽封面。"""
    cover: CoverInfo | None = pick_cover(Path(job.work_dir), logger)
    if cover is None:
        return "未找到可用的弹幕/视频，跳过封面", True

    job.outputs["cover"] = {
        "path": str(cover.path),
        "danmaku_count": cover.danmaku_count,
        "cover_time": cover.cover_time,
        "cover_p": cover.cover_p,
    }
    return f"封面：{cover.path.name}（弹幕 {cover.danmaku_count} 条）", False


def step_upload(
    config: Config, streamer: StreamerConfig, job: Job, logger
) -> StepResult:
    """按主播配置投稿。"""
    if not streamer.upload.enabled:
        return "该主播未启用投稿", True

    files = upload_candidates(job, streamer)
    if not files:
        return "没有可投稿的文件", True

    cover_info = job.outputs.get("cover") or {}
    date_cn = date_parts(job.start_time)[0]
    title = render_title(
        streamer.upload.title_template,
        date=date_cn,
        title=job.stream_title or job.id,
        streamer=job.streamer,
    )
    description = render_desc(
        streamer.upload.desc_template,
        title=job.stream_title,
        streamer=job.streamer,
        platform=job.platform,
        danmaku_count=int(cover_info.get("danmaku_count", 0)),
        cover_time=str(cover_info.get("cover_time", "")),
        cover_p=int(cover_info.get("cover_p", 0)),
    )
    cover_path = Path(cover_info["path"]) if cover_info.get("path") else None

    result = upload(
        streamer.upload,
        files,
        title=title,
        description=description,
        cover=cover_path,
    )
    job.outputs["upload"] = {
        "ok": result.ok,
        "detail": result.detail,
        "title": title,
        "files": [str(path) for path in files],
    }
    if not result.ok:
        raise RuntimeError(f"投稿失败：{result.detail[-300:]}")

    return f"投稿成功：{title}", False


def upload_candidates(job: Job, streamer: StreamerConfig) -> list[Path]:
    """确定要投稿的文件。

    优先级：
        1. 弹幕压制开启 -> 投稿版
        2. 弹幕压制关闭 -> 原视频 MP4
        3. 之前已经归档过 -> 使用归档路径（支持投稿失败后单独重试）
    """
    if streamer.danmaku.enabled:
        encoded = [Path(path) for path in job.outputs.get("encoded", [])]
        existing = sorted(path for path in encoded if path.is_file())
        if existing:
            return existing
        work_dir = Path(job.work_dir)
        if work_dir.is_dir():
            pressed = sorted(work_dir.glob("投稿版-*.mp4"))
            if pressed:
                return pressed
    else:
        work_dir = Path(job.work_dir)
        if work_dir.is_dir():
            raw = sorted(work_dir.glob("*.mp4"))
            if raw:
                return raw

    archived = [Path(path) for path in job.outputs.get("upload_files", [])]
    return sorted(path for path in archived if path.is_file())


def step_archive(
    config: Config, streamer: StreamerConfig, job: Job, logger
) -> StepResult:
    """把压制版和原文件移到归档目录。"""
    work_dir = Path(job.work_dir)
    pressed_dir, raw_dir = archive_dirs(config, streamer, job.start_time)

    pressed_moved: list[Path] = []
    for path in sorted(work_dir.glob("投稿版-*.mp4")):
        ensure_dir(pressed_dir)
        target = pressed_dir / path.name
        shutil.move(str(path), str(target))
        pressed_moved.append(target)

    raw_moved: list[Path] = []
    for suffix in ("*.mp4", "*.flv", "*.xml"):
        for path in sorted(work_dir.glob(suffix)):
            ensure_dir(raw_dir)
            target = raw_dir / path.name
            shutil.move(str(path), str(target))
            raw_moved.append(target)

    # ASS 是中间产物，不归档
    for ass_path in work_dir.glob("*.ass"):
        ass_path.unlink(missing_ok=True)

    # 封面也归档：投稿失败重试时还要用
    cover_info = dict(job.outputs.get("cover") or {})
    for cover_path in sorted(work_dir.glob("*.jpg")):
        target_dir = pressed_dir if pressed_moved else raw_dir
        ensure_dir(target_dir)
        target = target_dir / cover_path.name
        shutil.move(str(cover_path), str(target))
        if cover_info.get("path") == str(cover_path):
            cover_info["path"] = str(target)
            job.outputs["cover"] = cover_info

    # 记录投稿文件路径：投稿失败重试时还能找到文件
    job.outputs["archive"] = {
        "pressed_dir": str(pressed_dir),
        "raw_dir": str(raw_dir),
    }
    job.outputs["upload_files"] = [
        str(path) for path in (pressed_moved or [path for path in raw_moved if path.suffix == ".mp4"])
    ]

    _remove_empty_dirs(work_dir)
    try:
        work_dir.rmdir()
    except OSError:
        pass

    return (
        f"归档：压制版 {len(pressed_moved)} 个，原文件 {len(raw_moved)} 个"
    ), False


def step_cleanup_after(
    config: Config, streamer: StreamerConfig, job: Job, logger
) -> StepResult:
    """投稿成功后按配置删除本地文件。"""
    if not streamer.archive.delete_after_upload:
        return "未启用“投稿后删除”，保留本地文件", True

    upload_info = job.outputs.get("upload") or {}
    if not upload_info.get("ok"):
        return "投稿未成功，保留本地文件", True

    deleted = 0
    for path in [Path(item) for item in job.outputs.get("upload_files", [])]:
        if path.is_file():
            path.unlink()
            deleted += 1

    archive_info = job.outputs.get("archive") or {}
    raw_dir = Path(archive_info.get("raw_dir", "")) if archive_info.get("raw_dir") else None
    if raw_dir and raw_dir.is_dir():
        for path in raw_dir.iterdir():
            if path.is_file():
                path.unlink()
                deleted += 1

    # 清理空目录时从主播根目录开始，才能把空的日期目录一起删掉
    _remove_empty_dirs(config.general.videos_dir / streamer.name)

    return f"已删除本地文件 {deleted} 个", False


# ---------------------------------------------------------------------------
# 归档目录与清理
# ---------------------------------------------------------------------------


def archive_dirs(
    config: Config, streamer: StreamerConfig, start_time: str
) -> tuple[Path, Path]:
    """返回 (压制版目录, 原文件目录)。

    目录结构：<videos_dir>/<主播>/压制版|原文件/YYYY/MM/YYYY-MM-DD/
    """
    _, year, month, day = date_parts(start_time)
    base = config.general.videos_dir / streamer.name
    return (
        base / "压制版" / year / month / day,
        base / "原文件" / year / month / day,
    )


def cleanup_archives(config: Config, logger=None) -> int:
    """按自然日清理旧录播，返回删除的日期目录数量。

    保护措施：
        - 只处理严格的 YYYY-MM-DD 目录；
        - 每个主播最多删除 max_delete_per_run 个；
        - 删除后清理空目录，但不动 videos 根目录。
    """
    logger = logger or get_logger("khx.pipeline")
    today = date.today()
    total = 0

    for streamer in config.enabled_streamers():
        archive = streamer.archive
        if not archive.cleanup_enabled:
            continue

        # 保留 N 天含当天，所以截止日期是 today-(N-1)
        cutoff = today - timedelta(days=archive.retention_days - 1)
        deleted = 0
        base = config.general.videos_dir / streamer.name

        for kind in ("压制版", "原文件"):
            kind_dir = base / kind
            if not kind_dir.is_dir():
                continue

            for directory in sorted(kind_dir.glob("*/*/*"), reverse=True):
                if deleted >= archive.max_delete_per_run:
                    logger.warning(
                        "主播 %s 本次已删除 %s 个目录，达到上限，停止清理",
                        streamer.id,
                        archive.max_delete_per_run,
                    )
                    break
                try:
                    directory_date = date.fromisoformat(directory.name)
                except ValueError:
                    continue
                if directory_date >= cutoff:
                    continue

                size = _dir_size(directory)
                shutil.rmtree(directory)
                logger.info(
                    "清理旧录播：%s（%s）", directory, human_size(size)
                )
                deleted += 1
                total += 1

        _remove_empty_dirs(base)

    _remove_empty_dirs(config.general.work_dir)
    return total


def _dir_size(directory: Path) -> int:
    total = 0
    for path in directory.rglob("*"):
        if path.is_file():
            total += path.stat().st_size
    return total


def _remove_empty_dirs(root: Path) -> None:
    """自底向上删除空目录，root 本身保留。"""
    if not root.is_dir():
        return
    for current, _subdirs, _files in os.walk(root, topdown=False):
        path = Path(current)
        if path == root:
            continue
        try:
            path.rmdir()
        except OSError:
            pass
