"""通用工具：子进程、文件原子写入、大小格式化。

这里不放业务逻辑。所有模块统一从本文件取基础能力，
避免 subprocess / json / 路径处理散落各处。
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Sequence


def human_size(num_bytes: int | float) -> str:
    """把字节数转成 13.5GB 这种可读形式，只用于日志。"""
    size = float(num_bytes)
    if size < 1024:
        return f"{int(size)}B"
    for unit in ("KB", "MB", "GB", "TB"):
        size /= 1024
        if size < 1024:
            return f"{size:.1f}{unit}"
    return f"{size:.1f}PB"


def ensure_dir(path: Path) -> Path:
    """创建目录（含父目录），已存在时直接返回。"""
    path.mkdir(parents=True, exist_ok=True)
    return path


def atomic_write_text(path: Path, text: str) -> None:
    """原子写文本：临时文件 + os.replace。

    压制任务一跑就是几小时，进程随时可能被 kill。
    状态文件和录播姬配置都用这个函数写，避免留下半截内容。
    """
    ensure_dir(path.parent)

    # mkstemp 保证临时文件在同一目录（跨文件系统 os.replace 会失败）
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_name, path)
    finally:
        # os.replace 成功后临时文件已不存在，这里只处理异常分支
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)


def atomic_write_json(path: Path, data: Any) -> None:
    """原子写 JSON，保留中文不转义，便于人眼排查。"""
    atomic_write_text(path, json.dumps(data, ensure_ascii=False, indent=2))


def atomic_write_bytes(path: Path, data: bytes) -> None:
    """原子写二进制（用于下载 cookie 文件）。"""
    ensure_dir(path.parent)
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_name, path)
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)



def read_json(path: Path) -> Any:
    """读 JSON；文件不存在或内容损坏时抛异常，由调用方决定怎么处理。"""
    return json.loads(path.read_text(encoding="utf-8"))


def run(
    cmd: Sequence[str],
    logger: logging.Logger | None = None,
    *,
    check: bool = True,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    """执行一条命令并收集输出。

    参数：
        cmd:   命令与参数列表（不要传字符串，避免 shell 注入和引号问题）
        check: 为 True 时，返回码非 0 抛 RuntimeError
        timeout: 超时秒数，None 表示不限制

    返回 CompletedProcess，stdout/stderr 都是 str。
    """
    if logger:
        logger.debug("执行命令: %s", " ".join(cmd))

    result = subprocess.run(
        list(cmd),
        capture_output=True,
        text=True,
        timeout=timeout,
    )

    if check and result.returncode != 0:
        # 只保留 stderr 末尾，完整内容进日志
        tail = (result.stderr or result.stdout or "").strip().splitlines()[-5:]
        detail = "\n".join(tail)
        raise RuntimeError(
            f"命令失败（退出码 {result.returncode}）：{' '.join(cmd)}\n{detail}"
        )

    return result
