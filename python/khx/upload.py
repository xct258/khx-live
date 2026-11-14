"""B 站投稿：封装 biliup 命令行。

为什么不直接调 B 站 API：
    biliup 已经处理了分P、封面、简介、断点续传等细节，
    这里只负责拼参数、透传输出、判断成败，保持和旧版行为一致。

biliup 成功时会在输出里打印“投稿成功”，这是目前唯一稳定的成功标志。
如果以后升级 biliup 改了文案，只需要改 SUCCESS_KEYWORDS。
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .config import UploadConfig
from .log import get_logger
from .util import human_size

# 判断投稿成功的输出关键字
SUCCESS_KEYWORDS = ("投稿成功",)


@dataclass
class UploadResult:
    ok: bool
    detail: str


def render_title(template: str, *, date: str, title: str, streamer: str) -> str:
    """按模板生成标题。

    使用 str.replace 而不是 str.format：
    直播标题里可能自带花括号，format 会直接抛异常。
    """
    return (
        template.replace("{date}", date)
        .replace("{title}", title)
        .replace("{streamer}", streamer)
        .strip()
    )


def render_desc(
    template: str,
    *,
    title: str,
    streamer: str,
    platform: str,
    danmaku_count: int,
    cover_time: str,
    cover_p: int,
) -> str:
    """按模板生成简介，占位符与旧版保持一致。"""
    replacements = {
        "{title}": title,
        "{streamer}": streamer,
        "{platform}": platform,
        "{danmaku_count}": str(danmaku_count),
        "{cover_time}": cover_time,
        "{cover_p}": str(cover_p),
    }
    result = template
    for placeholder, value in replacements.items():
        result = result.replace(placeholder, value)
    return result


def upload(
    config: UploadConfig,
    files: list[Path],
    *,
    title: str,
    description: str,
    cover: Path | None = None,
) -> UploadResult:
    """调用 biliup 投稿。

    参数：
        config:      投稿配置（账号 cookies、分区、标签等）
        files:       要投稿的视频文件，顺序即分P顺序
        title:       稿件标题
        description: 稿件简介
        cover:       封面图片，None 或文件不存在时不传封面

    返回：
        UploadResult(ok, detail)，detail 是最后几行输出，便于写进任务状态。
    """
    logger = get_logger("khx.upload")

    # ---- 前置检查：错误尽早暴露，避免 biliup 跑到一半才失败 ----
    if not files:
        return UploadResult(False, "没有可投稿的文件")
    missing = [str(path) for path in files if not path.is_file()]
    if missing:
        return UploadResult(False, f"文件不存在：{', '.join(missing)}")
    if not config.cookies.is_file():
        return UploadResult(False, f"投稿 cookies 不存在：{config.cookies}")
    if not config.biliup.is_file():
        return UploadResult(False, f"biliup 不存在：{config.biliup}")
    if not os.access(config.biliup, os.X_OK):
        return UploadResult(False, f"biliup 不可执行：{config.biliup}")

    total_size = sum(path.stat().st_size for path in files)
    logger.info(
        "开始投稿：%s（%s，共 %s）",
        title,
        f"{len(files)}P",
        human_size(total_size),
    )

    cmd = [
        str(config.biliup),
        "-u", str(config.cookies),
        "upload",
        "--copyright", str(config.copyright),
        "--tid", str(config.tid),
        "--title", title,
        "--desc", description,
    ]

    # 封面：只有文件真实存在时才传，否则 biliup 会直接报错
    if cover and cover.is_file():
        cmd += ["--cover", str(cover)]

    if config.source:
        cmd += ["--source", config.source]
    if config.tags:
        cmd += ["--tag", ",".join(config.tags)]

    cmd += [str(path) for path in files]
    logger.debug("投稿命令：%s", " ".join(cmd))

    # ---- 流式读取输出，避免长时间无日志 ----
    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
    except OSError as exc:
        return UploadResult(False, f"启动 biliup 失败：{exc}")

    output_lines: list[str] = []
    assert process.stdout is not None
    for raw_line in process.stdout:
        line = raw_line.strip()
        if not line:
            continue
        output_lines.append(line)
        # 控制台只打印关键行，完整输出留给任务状态
        if any(keyword in line for keyword in SUCCESS_KEYWORDS) or "%" in line:
            logger.info("biliup: %s", line)

    return_code = process.wait()
    output = "\n".join(output_lines[-40:])
    ok = any(keyword in output for keyword in SUCCESS_KEYWORDS)

    if ok:
        logger.info("投稿成功")
    else:
        logger.error("投稿失败（退出码 %s）", return_code)
        for line in output_lines[-10:]:
            logger.error("biliup: %s", line)

    detail = output[-1200:] if output else f"退出码 {return_code}，无输出"
    return UploadResult(ok, detail)
