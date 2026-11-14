"""视频/弹幕的基础处理。

职责：
    - 解析录制文件名（平台、开播时间、标题、主播）
    - ffprobe 探测时长/分辨率
    - FLV -> MP4 无损封装
    - 读取 XML 最后一条弹幕时间，做音画同步校验
    - 从弹幕最密集的位置抽封面

不在这里做编码，编码和 ASS 生成在 danmaku.py。
"""

from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .log import get_logger
from .state import date_parts
from .util import human_size, run

# 外部命令名。容器镜像里已经在 PATH 中；如果要换绝对路径，改这里即可。
FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"

# 时长/分辨率探测失败时的常见原因：文件还在写入。
PROBE_ERROR = "无法读取媒体信息"


class MediaError(RuntimeError):
    """媒体文件缺失、损坏或 ffmpeg 执行失败。"""


@dataclass
class MediaInfo:
    duration: float          # 秒
    width: int = 0
    height: int = 0
    fps: float = 0.0


@dataclass
class RecordingName:
    """从录制文件名拆出来的元数据。"""

    platform: str
    start_time: str
    stream_title: str
    streamer: str


@dataclass
class CoverInfo:
    """封面选择结果，字段与 biliup 投稿需要的描述对应。"""

    path: Path
    danmaku_count: int
    cover_time: str
    cover_p: int


# ---------------------------------------------------------------------------
# 文件名
# ---------------------------------------------------------------------------

# 录播姬_2026年11月13日19点56分57秒_脚爹TV_高机动持盾军官.flv
_START_TIME_PATTERN = re.compile(
    r"(\d{4})年(\d{2})月(\d{2})日(\d{2})点(\d{2})分(\d{2})秒"
)


def parse_recording_name(filename: str | Path) -> RecordingName:
    """解析录制文件名。

    约定格式：<平台>_<时间>_<直播标题>_<主播>.flv
    直播标题里可能带下划线，所以按“第 3 段到倒数第 2 段”拼回去。

    解析失败时抛 ValueError，调用方应记录并跳过该文件，而不是猜。
    """
    stem = Path(filename).stem
    parts = stem.split("_")
    if len(parts) < 2:
        raise ValueError(f"文件名不符合约定格式：{stem}")

    platform = parts[0].removeprefix("投稿版-")
    start_time = parts[1] if _START_TIME_PATTERN.search(parts[1]) else ""

    if len(parts) >= 4:
        streamer = parts[-1]
        stream_title = "_".join(parts[2:-1])
    else:
        # 标题为空或主播缺失时，尽量保留能拿到的信息
        streamer = ""
        stream_title = "_".join(parts[2:])

    return RecordingName(
        platform=platform,
        start_time=start_time,
        stream_title=stream_title,
        streamer=streamer,
    )


# ---------------------------------------------------------------------------
# 探测
# ---------------------------------------------------------------------------


def probe(path: Path) -> MediaInfo:
    """用 ffprobe 读取时长、分辨率、帧率。

    参数：
        path: 视频文件

    异常：
        MediaError: 文件不存在或 ffprobe 解析失败
    """
    if not path.is_file():
        raise MediaError(f"媒体文件不存在：{path}")

    result = run(
        [
            FFPROBE,
            "-v", "error",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            str(path),
        ],
        check=False,
    )
    if result.returncode != 0:
        raise MediaError(f"{PROBE_ERROR}：{path}\n{result.stderr.strip()[:300]}")

    try:
        data: dict[str, Any] = json.loads(result.stdout)
        duration = float(data["format"]["duration"])
    except (ValueError, KeyError, TypeError) as exc:
        raise MediaError(f"{PROBE_ERROR}：{path}") from exc

    info = MediaInfo(duration=duration)
    for stream in data.get("streams", []):
        if stream.get("codec_type") != "video":
            continue
        info.width = int(stream.get("width") or 0)
        info.height = int(stream.get("height") or 0)
        info.fps = _parse_rate(stream.get("avg_frame_rate"))
        break
    return info


def _parse_rate(value: str | None) -> float:
    """把 ffprobe 的 60/1 这种帧率转成浮点数。"""
    if not value or "/" not in value:
        return 0.0
    numerator, denominator = value.split("/", 1)
    try:
        return float(numerator) / float(denominator)
    except (ValueError, ZeroDivisionError):
        return 0.0


# ---------------------------------------------------------------------------
# 封装与时长校验
# ---------------------------------------------------------------------------


def remux_to_mp4(src: Path, dst: Path) -> None:
    """FLV -> MP4 无损封装。

    使用 -c copy 不重新编码，几十秒就能完成，画质零损失。
    -fflags +genpts 用来修补部分录播文件缺失的 PTS，避免音画不同步。
    """
    logger = get_logger("khx.media")
    logger.info("封装 FLV -> MP4：%s（%s）", src.name, human_size(src.stat().st_size))

    run(
        [
            FFMPEG,
            "-fflags", "+genpts",
            "-i", str(src),
            "-c:v", "copy",
            "-c:a", "copy",
            "-loglevel", "error",
            "-y", str(dst),
        ]
    )

    if not dst.is_file() or dst.stat().st_size == 0:
        raise MediaError(f"封装失败，输出文件为空：{dst}")


def last_danmaku_seconds(xml_path: Path) -> float | None:
    """读取 XML 里最后一条弹幕的时间（秒）。

    弹幕格式：<d p="12.345,1,25,16777215,...">内容</d>
    使用 iterparse 并清理节点，400MB 的 XML 也不会把内存吃满。
    """
    if not xml_path.is_file():
        return None

    last: float | None = None
    try:
        for _, element in ET.iterparse(str(xml_path), events=("end",)):
            if element.tag != "d":
                continue
            attribute = element.get("p")
            if attribute:
                try:
                    seconds = float(attribute.split(",", 1)[0])
                except ValueError:
                    seconds = None
                if seconds is not None and (last is None or seconds > last):
                    last = seconds
            element.clear()
    except ET.ParseError:
        return None
    return last


def duration_diff(video: Path, xml: Path) -> float | None:
    """返回“视频时长 - 最后一条弹幕时间”。

    正数表示视频比弹幕长，负数表示弹幕比视频长。
    没有弹幕文件或时间解析失败时返回 None。
    """
    last = last_danmaku_seconds(xml)
    if last is None:
        return None
    return probe(video).duration - last


def format_time_cn(seconds: float) -> str:
    """把秒数转成 1小时2分钟3秒，用于投稿简介的封面时间。"""
    total = int(seconds)
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours > 0:
        return f"{hours}小时{minutes}分钟{secs}秒"
    if minutes > 0:
        return f"{minutes}分钟{secs}秒"
    return f"{secs}秒"


# ---------------------------------------------------------------------------
# 封面
# ---------------------------------------------------------------------------


def extract_frame(video: Path, timestamp: float, output: Path) -> bool:
    """在指定时间点抽一帧 JPG。

    -ss 放在 -i 前面是快速定位，对封面场景足够。
    返回 False 表示该时间点抽帧失败（例如超出视频末尾）。
    """
    result = run(
        [
            FFMPEG,
            "-ss", f"{timestamp:.3f}",
            "-i", str(video),
            "-frames:v", "1",
            "-q:v", "2",
            "-y", str(output),
        ],
        check=False,
    )
    return result.returncode == 0 and output.is_file() and output.stat().st_size > 0


def frame_brightness(image: Path) -> float | None:
    """计算一张图片的平均亮度（0-255）。

    用 ffmpeg 的 signalstats 滤镜读取 YAVG，避免依赖 Pillow。
    解析失败返回 None，调用方按“亮度未知”处理，不因为校验失败丢封面。
    """
    result = run(
        [
            FFMPEG,
            "-v", "error",
            "-i", str(image),
            "-vf", "signalstats,metadata=print:file=-",
            "-f", "null",
            "-",
        ],
        check=False,
    )
    if result.returncode != 0:
        return None

    match = re.search(r"lavfi\.signalstats\.YAVG=([0-9.]+)", result.stdout)
    if not match:
        return None
    try:
        return float(match.group(1))
    except ValueError:
        return None


def pick_cover(work_dir: Path, logger=None) -> CoverInfo | None:
    """在弹幕最密集的时刻抽一帧作为封面。

    逻辑（与旧版 shell 版保持一致）：
        1. 逐个 XML 统计每秒弹幕数，找到峰值秒；
        2. 在所有分P里挑峰值最高的那一P；
        3. 从峰值 +0.5 秒开始抽帧，画面过暗/过曝就往前退 1 秒，最多 15 次；
        4. 实在抽不到合格画面，就保留最后一张（总比没有封面好）。

    返回 None 表示目录里没有可用的 XML+视频组合。
    """
    logger = logger or get_logger("khx.media")
    work_dir = Path(work_dir)

    total_danmaku = 0
    best: tuple[int, Path, int, int] | None = None  # (峰值, 视频, 峰值秒, 分P序号)
    part_index = 0

    for xml_path in sorted(work_dir.glob("*.xml")):
        part_index += 1
        video_path = _find_video(xml_path)
        if video_path is None:
            continue

        counts = _danmaku_per_second(xml_path)
        if not counts:
            continue

        total_danmaku += sum(counts.values())
        peak_second, peak_count = max(counts.items(), key=lambda item: item[1])
        if best is None or peak_count > best[0]:
            best = (peak_count, video_path, peak_second, part_index)

    if best is None:
        return None

    _, video_path, peak_second, part_index = best
    output = video_path.with_suffix(".jpg")

    # 从峰值往后 0.5 秒取整开始，逐秒向前退
    timestamp = int(peak_second + 0.5)
    cover_time = timestamp

    for _ in range(15):
        if extract_frame(video_path, float(timestamp), output):
            brightness = frame_brightness(output)
            # 亮度未知（None）时直接采用，避免因探测失败没有封面
            if brightness is None or 25 <= brightness <= 230:
                logger.info(
                    "封面已生成：%s（弹幕峰值 %ss，亮度 %s）",
                    output.name,
                    peak_second,
                    "未知" if brightness is None else f"{brightness:.0f}",
                )
                return CoverInfo(
                    path=output,
                    danmaku_count=total_danmaku,
                    cover_time=format_time_cn(cover_time),
                    cover_p=part_index,
                )
        timestamp -= 1
        cover_time = timestamp

    # 15 次都没找到合格画面：只要文件还在就先用着
    if output.is_file() and output.stat().st_size > 0:
        logger.warning("封面亮度始终不理想，沿用最后一张：%s", output.name)
        return CoverInfo(
            path=output,
            danmaku_count=total_danmaku,
            cover_time=format_time_cn(cover_time),
            cover_p=part_index,
        )

    logger.warning("封面生成失败：%s", video_path.name)
    return None


def _find_video(xml_path: Path) -> Path | None:
    """XML 对应的视频，优先 MP4（压制流程会先封装），其次 FLV。"""
    for suffix in (".mp4", ".flv"):
        candidate = xml_path.with_suffix(suffix)
        if candidate.is_file():
            return candidate
    return None


def _danmaku_per_second(xml_path: Path) -> dict[int, int]:
    """统计每秒弹幕条数，键为整秒。"""
    counts: dict[int, int] = {}
    try:
        for _, element in ET.iterparse(str(xml_path), events=("end",)):
            if element.tag != "d":
                continue
            attribute = element.get("p")
            if attribute:
                try:
                    second = int(float(attribute.split(",", 1)[0]))
                except ValueError:
                    second = -1
                if second >= 0:
                    counts[second] = counts.get(second, 0) + 1
            element.clear()
    except ET.ParseError:
        get_logger("khx.media").warning("弹幕文件解析失败：%s", xml_path.name)
    return counts


# 供 pipeline 使用：根据开播时间生成归档目录（YYYY/MM/YYYY-MM-DD）
def archive_parts(start_time: str) -> tuple[str, str, str, str]:
    return date_parts(start_time)
