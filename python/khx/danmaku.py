"""弹幕处理：XML -> ASS，以及把 ASS 烧进视频。

只做“投稿版”（无高能进度条），因此不依赖 numpy/matplotlib/scipy。
编码优先尝试 Intel QSV，失败后自动回退 CPU x264。

两个外部依赖：
    DanmakuFactory  XML 转 ASS
    ffmpeg          ass 滤镜 + x264/qsv 编码
"""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

from .config import DanmakuConfig, EncodeConfig
from .log import get_logger
from .media import FFMPEG, MediaError
from .util import human_size

# /dev/dri 存在才可能有 Intel 核显；没有就直接走 CPU，省掉一次必然失败的尝试。
DRI_PATH = Path("/dev/dri")


class DanmakuError(RuntimeError):
    """DanmakuFactory 或 ffmpeg 执行失败。"""


def escape_filter_path(path: Path) -> str:
    """转义 ffmpeg 滤镜里的文件路径。

    规则：先转义反斜杠和单引号，再用单引号包起来。
    这样中文、空格、逗号、冒号都不会被滤镜语法误解析。
    """
    text = str(path).replace("\\", "\\\\").replace("'", "\\'")
    return f"'{text}'"


# ---------------------------------------------------------------------------
# XML -> ASS
# ---------------------------------------------------------------------------


def xml_to_ass(xml_path: Path, config: DanmakuConfig) -> Path:
    """调用 DanmakuFactory 生成同名的 .ass 文件。

    参数：
        xml_path: 录播姬生成的弹幕 XML
        config:   弹幕配置（字体大小、不透明度）

    异常：
        DanmakuError: 可执行文件缺失、无执行权限或转换失败
    """
    logger = get_logger("khx.danmaku")
    factory = config.factory

    if not factory.is_file():
        raise DanmakuError(f"DanmakuFactory 不存在：{factory}")
    if not os.access(factory, os.X_OK):
        raise DanmakuError(f"DanmakuFactory 不可执行：{factory}")

    ass_path = xml_path.with_suffix(".ass")
    logger.info(
        "转换弹幕：%s（字号 %s，不透明度 %s）",
        xml_path.name,
        config.font_size,
        config.opacity,
    )

    result = subprocess.run(
        [
            str(factory),
            "-i", str(xml_path),
            "-o", str(ass_path),
            "-S", str(config.font_size),   # 字号
            "-O", str(config.opacity),     # 不透明度 0-255
            "--ignore-warnings",
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").strip()[-500:]
        raise DanmakuError(f"弹幕转换失败：{xml_path.name}\n{tail}")
    if not ass_path.is_file() or ass_path.stat().st_size == 0:
        raise DanmakuError(f"弹幕转换未生成有效 ASS：{ass_path}")

    logger.info("弹幕转换完成：%s（%s）", ass_path.name, human_size(ass_path.stat().st_size))
    return ass_path


# ---------------------------------------------------------------------------
# 压制
# ---------------------------------------------------------------------------


def encode(
    video: Path,
    ass_path: Path,
    output: Path,
    encode_config: EncodeConfig,
    duration: float,
) -> None:
    """把 ASS 弹幕烧进画面，输出投稿版 MP4。

    参数：
        video:         输入视频（通常是 remux 后的 mp4）
        ass_path:      弹幕字幕
        output:        输出文件
        encode_config: 编码参数
        duration:      视频时长（秒），只用于进度百分比

    异常：
        DanmakuError: QSV 和 CPU 都失败
    """
    logger = get_logger("khx.danmaku")

    # 有核显时先试 QSV。速度快很多，但驱动/参数不对会立即失败。
    if encode_config.try_qsv and DRI_PATH.exists():
        logger.info("尝试 Intel QSV 硬件编码")
        if _run_encode(video, ass_path, output, encode_config, duration, encoder="qsv"):
            return
        logger.warning("QSV 编码失败，删除半成品并回退 CPU")
        output.unlink(missing_ok=True)

    logger.info(
        "使用 CPU x264 编码（crf=%s preset=%s）",
        encode_config.crf,
        encode_config.preset,
    )
    if not _run_encode(video, ass_path, output, encode_config, duration, encoder="cpu"):
        raise DanmakuError(f"视频压制失败：{video.name}")

    if not output.is_file() or output.stat().st_size == 0:
        raise DanmakuError(f"压制未生成有效文件：{output}")


def _run_encode(
    video: Path,
    ass_path: Path,
    output: Path,
    config: EncodeConfig,
    duration: float,
    *,
    encoder: str,
) -> bool:
    """执行一次 ffmpeg 编码，成功返回 True。

    说明：
        -filter_complex "[0:v]ass=... [vout]"  把字幕烧进画面
        -map "[vout]" -map "0:a?"              输出视频 + 原音频（没有音频也不报错）
        -c:a copy                              音频不重编码，保持原样
        -progress pipe:1                       用机器可读格式输出进度
    """
    logger = get_logger("khx.danmaku")

    cmd = [
        FFMPEG,
        "-hide_banner",
        "-nostdin",
        "-loglevel", "warning",
        "-y",
        "-i", str(video),
        "-filter_complex", f"[0:v]ass={escape_filter_path(ass_path)}[vout]",
        "-map", "[vout]",
        "-map", "0:a?",
    ]

    if encoder == "qsv":
        cmd += [
            "-c:v", "h264_qsv",
            "-global_quality", str(config.qsv_quality),
            "-preset", config.qsv_preset,
        ]
    else:
        cmd += [
            "-c:v", "libx264",
            "-crf", str(config.crf),
            "-profile:v", config.profile,
            "-preset", config.preset,
        ]
        if config.threads > 0:
            cmd += ["-threads", str(config.threads)]

    cmd += [
        "-c:a", "copy",
        "-progress", "pipe:1",
        "-nostats",
        str(output),
    ]

    logger.debug("编码命令：%s", " ".join(cmd))

    # 进度在 stdout，错误在 stderr；合并到一个管道，避免 stderr 写满导致死锁。
    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    last_report = 0.0
    out_time = 0.0
    speed = ""
    error_lines: list[str] = []

    assert process.stdout is not None
    for raw_line in process.stdout:
        line = raw_line.strip()
        if not line:
            continue

        # ---- 解析 -progress 的键值行 ----
        if line.startswith(("out_time_us=", "out_time_ms=")):
            try:
                # ffmpeg 的 out_time_ms 实际单位是微秒，这里统一按微秒处理
                out_time = float(line.split("=", 1)[1]) / 1_000_000
            except ValueError:
                pass
        elif line.startswith("speed="):
            speed = line.split("=", 1)[1]
        elif line.startswith("progress="):
            continue
        elif line.startswith(("frame=", "fps=", "stream_", "bitrate=", "total_size=", "dup_frames=", "drop_frames=")):
            continue
        else:
            # 其余都是 ffmpeg 的警告/错误，留最后 20 行用于报错
            error_lines.append(line)
            if len(error_lines) > 20:
                error_lines.pop(0)

        # ---- 每 30 秒汇报一次 ----
        now = time.monotonic()
        if duration > 0 and now - last_report >= 30:
            last_report = now
            percent = min(100.0, out_time / duration * 100)
            logger.info(
                "压制进度 %.1f%%（已处理 %s / %s，速度 %s）",
                percent,
                _hms(out_time),
                _hms(duration),
                speed or "未知",
            )

    return_code = process.wait()
    process.stdout.close()
    if return_code != 0:
        tail = "\n".join(error_lines[-10:])
        logger.error("ffmpeg 退出码 %s：%s", return_code, tail or "无错误输出")
        return False

    if not output.is_file() or output.stat().st_size == 0:
        logger.error("ffmpeg 成功退出但输出为空：%s", output)
        return False

    logger.info("压制完成：%s（%s）", output.name, human_size(output.stat().st_size))
    return True


def _hms(seconds: float) -> str:
    """秒数 -> H:MM:SS，用于进度日志。"""
    total = max(0, int(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


# 供 pipeline 做空文件检查
def file_ok(path: Path) -> bool:
    return path.is_file() and path.stat().st_size > 0


__all__ = ["DanmakuError", "MediaError", "encode", "escape_filter_path", "file_ok", "xml_to_ass"]
