import os
import asyncio
import json
import time
import re
import shutil
import subprocess
import mimetypes
import threading
from datetime import datetime
from uuid import uuid4
from pathlib import Path
from typing import List, Optional
from collections import deque
from fastapi import FastAPI, HTTPException, Request, BackgroundTasks, Body, Form, File, UploadFile # pyright: ignore[reportMissingImports]
from fastapi.responses import HTMLResponse, StreamingResponse, FileResponse # pyright: ignore[reportMissingImports]
from fastapi.staticfiles import StaticFiles # pyright: ignore[reportMissingImports]
from fastapi.templating import Jinja2Templates # pyright: ignore[reportMissingImports]
from pydantic import BaseModel, Field # pyright: ignore[reportMissingImports]

try:
    import pty  # type: ignore
except Exception:  # pragma: no cover
    pty = None

# ------------------ 配置 ------------------
BASE_DIR = Path(__file__).parent.resolve()
VIDEO_DIR = Path("/rec/videos")
TMP_OUTPUT_DIR = BASE_DIR / "clips_tmp"
# all final outputs now live in the finished directory; OUTPUT_DIR is aliased
FINISHED_DIR = Path("/rec/videos/切片成品")
OUTPUT_DIR = FINISHED_DIR
# prefix included in returned paths that points to FINISHED_DIR (legacy compat)
FINISHED_PREFIX = "成品/"

COVER_DIR = OUTPUT_DIR / "covers"  # store uploaded cover images separately (now same as finished dir)
TEMPLATE_DIR = BASE_DIR / "templates"
STATIC_DIR = BASE_DIR / "static"
THUMB_CACHE_DIR = BASE_DIR / "thumb_cache"
ALLOWED_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".m4v"}

# 脚本内测试模式开关：设为 True 则上传进入测试模式（只返回命令预览），False正常上传
UPLOAD_TEST_MODE = True

for d in [VIDEO_DIR, TMP_OUTPUT_DIR, OUTPUT_DIR, FINISHED_DIR, COVER_DIR, TEMPLATE_DIR, STATIC_DIR, THUMB_CACHE_DIR]:
    d.mkdir(parents=True, exist_ok=True)

MERGE_STATE_PATH = BASE_DIR / "merge_state.json"
_merge_state_lock = threading.Lock()

UPLOAD_STATE_PATH = BASE_DIR / "upload_state.json"
_upload_state_lock = threading.Lock()

STATS_STATE_PATH = BASE_DIR / "stats_state.json"
_stats_state_lock = threading.Lock()

# 取消合并：由于本服务一次只允许一个合并任务运行，这里用全局 event + 当前进程句柄即可。
_merge_cancel_event = threading.Event()
_merge_runtime_lock = threading.Lock()
_merge_runtime_job_id: Optional[str] = None
_merge_runtime_proc: Optional[subprocess.Popen] = None

_upload_runtime_lock = threading.Lock()
_upload_runtime_proc: Optional[subprocess.Popen] = None


# 目录树懒加载缓存：避免前端频繁展开/折叠导致重复扫描同一层目录
_tree_cache_lock = threading.Lock()
_tree_cache: dict[str, tuple[float, List[dict]]] = {}


class MergeCancelled(RuntimeError):
    pass


def _set_merge_runtime(job_id: Optional[str] = None, proc: Optional[subprocess.Popen] = None) -> None:
    global _merge_runtime_job_id, _merge_runtime_proc
    with _merge_runtime_lock:
        if job_id is not None:
            _merge_runtime_job_id = job_id
        _merge_runtime_proc = proc


def _terminate_current_merge_proc() -> bool:
    """尝试终止当前正在运行的 ffmpeg 进程。返回是否找到并触发了终止。"""
    proc: Optional[subprocess.Popen] = None
    with _merge_runtime_lock:
        proc = _merge_runtime_proc

    if proc is None:
        return False

    try:
        if proc.poll() is None:
            try:
                proc.terminate()
            except Exception:
                pass
            # 给一点时间优雅退出；不行再 kill
            for _ in range(20):
                if proc.poll() is not None:
                    break
                time.sleep(0.05)
            if proc.poll() is None:
                try:
                    proc.kill()
                except Exception:
                    pass
        return True
    except Exception:
        return False


def _set_upload_runtime(proc: Optional[subprocess.Popen] = None) -> None:
    global _upload_runtime_proc
    with _upload_runtime_lock:
        _upload_runtime_proc = proc


def _terminate_current_upload_proc() -> bool:
    """尝试终止当前正在运行的 biliup 进程。返回是否找到并触发了终止。"""
    proc: Optional[subprocess.Popen] = None
    with _upload_runtime_lock:
        proc = _upload_runtime_proc

    if proc is None:
        return False

    try:
        if proc.poll() is None:
            try:
                proc.terminate()
            except Exception:
                pass
            for _ in range(30):
                if proc.poll() is not None:
                    break
                time.sleep(0.05)
            if proc.poll() is None:
                try:
                    proc.kill()
                except Exception:
                    pass
        return True
    except Exception:
        return False


def _read_merge_state_unlocked() -> dict:
    if not MERGE_STATE_PATH.exists():
        return {"running": False}
    try:
        with MERGE_STATE_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {"running": False}
        if "running" not in data:
            data["running"] = False
        return data
    except Exception:
        return {"running": False}


def _write_merge_state_unlocked(state: dict) -> None:
    tmp_path = MERGE_STATE_PATH.with_suffix(".json.tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, MERGE_STATE_PATH)


def _get_merge_state() -> dict:
    with _merge_state_lock:
        return _read_merge_state_unlocked()


def _update_merge_state(**updates) -> dict:
    with _merge_state_lock:
        state = _read_merge_state_unlocked()
        state.update(updates)
        _write_merge_state_unlocked(state)
        return state


def _read_upload_state_unlocked() -> dict:
    if not UPLOAD_STATE_PATH.exists():
        return {"running": False}
    try:
        with UPLOAD_STATE_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {"running": False}
        if "running" not in data:
            data["running"] = False
        return data
    except Exception:
        return {"running": False}


def _write_upload_state_unlocked(state: dict) -> None:
    tmp_path = UPLOAD_STATE_PATH.with_suffix(".json.tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, UPLOAD_STATE_PATH)


def _get_upload_state() -> dict:
    with _upload_state_lock:
        return _read_upload_state_unlocked()


def _update_upload_state(**updates) -> dict:
    with _upload_state_lock:
        state = _read_upload_state_unlocked()
        state.update(updates)
        _write_upload_state_unlocked(state)
        return state


def _normalize_stats_state(data: Optional[dict] = None) -> dict:
    src = data if isinstance(data, dict) else {}

    def _to_nonneg_int(v) -> int:
        try:
            iv = int(v)
            return iv if iv >= 0 else 0
        except Exception:
            return 0

    return {
        "visit_count": _to_nonneg_int(src.get("visit_count")),
        "merge_success_count": _to_nonneg_int(src.get("merge_success_count")),
        "download_count": _to_nonneg_int(src.get("download_count")),
    }


def _read_stats_state_unlocked() -> dict:
    if not STATS_STATE_PATH.exists():
        return _normalize_stats_state()
    try:
        with STATS_STATE_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return _normalize_stats_state(data)
    except Exception:
        return _normalize_stats_state()


def _write_stats_state_unlocked(state: dict) -> None:
    tmp_path = STATS_STATE_PATH.with_suffix(".json.tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(_normalize_stats_state(state), f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, STATS_STATE_PATH)


def _get_stats_state() -> dict:
    with _stats_state_lock:
        return _read_stats_state_unlocked()


def _increment_stat(field: str, delta: int = 1) -> dict:
    if field not in {"visit_count", "merge_success_count", "download_count"}:
        return _get_stats_state()

    inc = int(delta)
    if inc == 0:
        return _get_stats_state()

    with _stats_state_lock:
        state = _read_stats_state_unlocked()
        state[field] = max(0, int(state.get(field, 0)) + inc)
        _write_stats_state_unlocked(state)
        return state


def _repair_stale_upload_state_on_startup() -> None:
    """服务重启时，之前的 biliup 进程不可能继续存在。

    若 upload_state.json 里仍是 running=true，则将其标记为已中断，避免前端永远显示“投稿中”。
    """
    try:
        with _upload_state_lock:
            state = _read_upload_state_unlocked()
            if not isinstance(state, dict):
                return
            if state.get("running") is not True:
                return

            logs = state.get("logs")
            if not isinstance(logs, list):
                logs = []
            logs.append("[server] 服务重启，投稿任务已中断")

            state.update(
                {
                    "running": False,
                    "status": "cancelled",
                    "cancel_requested": True,
                    "cancel_reason": "server_restart",
                    "error": "服务重启，投稿任务已中断",
                    "updated_at": int(time.time()),
                    "logs": logs[-1200:],
                }
            )
            _write_upload_state_unlocked(state)
    except Exception:
        # 不影响启动
        pass


def _upload_token_ok(token: Optional[str]) -> bool:
    t = (token or "").strip()
    if not t:
        return False
    state = _get_upload_state()
    return str(state.get("upload_token") or "").strip() == t


# 模块加载时修复“遗留 running=true 的投稿状态”
_repair_stale_upload_state_on_startup()


_BILIUP_PROGRESS_RE = re.compile(
    r"(?P<cur>\d+(?:\.\d+)?)\s*(?P<cur_u>KiB|MiB|GiB|TiB)\s*/\s*(?P<tot>\d+(?:\.\d+)?)\s*(?P<tot_u>KiB|MiB|GiB|TiB)"
)
_BILIUP_SPEED_ETA_RE = re.compile(r"\((?P<speed>[^,]+),\s*(?P<eta>[^\)]*)")
_ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")

# 参考用户脚本：从任意进度行里抓“数字+单位”片段
_BILIUP_ANY_UNIT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*([KMGT]iB)(/s)?")
_BILIUP_ETA_RE = re.compile(r"(\d+[hms](?:\d+[ms])?)")


def _unit_to_bytes(value: float, unit: str) -> float:
    u = (unit or "").strip()
    mul = 1.0
    if u == "KiB":
        mul = 1024.0
    elif u == "MiB":
        mul = 1024.0 ** 2
    elif u == "GiB":
        mul = 1024.0 ** 3
    elif u == "TiB":
        mul = 1024.0 ** 4
    return float(value) * mul


def _parse_biliup_progress(text: str) -> dict:
    """从 biliup 输出中尽量解析进度/速度/ETA。解析失败则返回空 dict。"""
    s = (text or "").strip("\r\n")
    # biliup 可能带 ANSI 控制符/光标控制，先剔除再解析
    s = _ANSI_ESCAPE_RE.sub("", s)
    out: dict = {}

    m = _BILIUP_PROGRESS_RE.search(s)
    if m:
        cur = float(m.group("cur"))
        tot = float(m.group("tot"))
        cur_b = _unit_to_bytes(cur, m.group("cur_u"))
        tot_b = _unit_to_bytes(tot, m.group("tot_u"))
        out["transferred_bytes"] = cur_b
        out["total_bytes"] = tot_b
        if tot_b > 0:
            out["percent"] = max(0.0, min(1.0, cur_b / tot_b))

    m2 = _BILIUP_SPEED_ETA_RE.search(s)
    if m2:
        out["speed"] = m2.group("speed").strip()
        out["eta"] = m2.group("eta").strip()

    # 兜底：按“数字+单位”抓取 current/total/speed，提升匹配覆盖率
    if "percent" not in out or ("speed" not in out and "eta" not in out):
        parts = list(_BILIUP_ANY_UNIT_RE.finditer(s))
        if parts:
            # 顺序通常是：已传 / 总量 / 速度
            cur_b = None
            tot_b = None
            speed_str = None
            for m in parts:
                v = float(m.group(1))
                u = m.group(2)
                is_speed = bool(m.group(3))
                if is_speed and speed_str is None:
                    speed_str = f"{m.group(1)} {u}/s"
                    continue
                # 只拿前两个非 /s
                if cur_b is None:
                    cur_b = _unit_to_bytes(v, u)
                elif tot_b is None:
                    tot_b = _unit_to_bytes(v, u)
            if cur_b is not None:
                out.setdefault("transferred_bytes", cur_b)
            if tot_b is not None:
                out.setdefault("total_bytes", tot_b)
                if tot_b > 0:
                    out.setdefault("percent", max(0.0, min(1.0, float(cur_b or 0.0) / tot_b)))
            if speed_str:
                out.setdefault("speed", speed_str)
            if "eta" not in out or not str(out.get("eta") or "").strip():
                m_eta = _BILIUP_ETA_RE.search(s)
                if m_eta:
                    out["eta"] = m_eta.group(1)

    return out


def _start_biliup_upload_job(cmd: list[str], upload_token: str, meta: dict) -> None:
    """启动 biliup 上传进程并持续写入 upload_state.json（日志 + 进度）。"""
    # 初始化状态
    _update_upload_state(
        running=True,
        status="uploading",
        percent=0.0,
        speed="",
        eta="",
        transferred_bytes=0.0,
        total_bytes=0.0,
        progress_line="",
        logs=[],
        started_at=int(time.time()),
        updated_at=int(time.time()),
        upload_token=upload_token,
        cancel_requested=False,
        cancel_reason="",
        **(meta or {}),
    )

    def _worker() -> None:
        proc: Optional[subprocess.Popen] = None
        master_fd: Optional[int] = None
        slave_fd: Optional[int] = None
        try:
            # 关键：使用 PTY 让 biliup 以 TTY 模式输出进度条（\r 刷新）。
            if pty is not None:
                master_fd, slave_fd = pty.openpty()
                proc = subprocess.Popen(
                    cmd,
                    stdin=slave_fd,
                    stdout=slave_fd,
                    stderr=slave_fd,
                    bufsize=0,
                )
                try:
                    os.close(slave_fd)
                except Exception:
                    pass
                slave_fd = None
            else:
                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    bufsize=0,
                )
            _set_upload_runtime(proc)

            logs = deque(maxlen=1200)
            progress_line = ""
            buf = b""
            last_flush = 0.0
            last_prog: dict = {}

            while True:
                if master_fd is not None:
                    try:
                        chunk = os.read(master_fd, 4096)
                    except OSError:
                        break
                else:
                    assert proc.stdout is not None
                    chunk = os.read(proc.stdout.fileno(), 4096)
                if not chunk:
                    break
                buf += chunk

                # 按 \n / \r 切分，\r 通常是进度刷新
                parts = re.split(rb"[\r\n]", buf)
                buf = parts.pop() if parts else b""
                for p in parts:
                    if not p:
                        continue
                    try:
                        text = p.decode("utf-8", errors="replace")
                    except Exception:
                        continue

                    # 清理 ANSI 控制符，尽量保留“命令本身输出”可读性
                    clean = _ANSI_ESCAPE_RE.sub("", text).strip("\r\n")

                    # 解析进度（不一定每行都有）
                    prog = _parse_biliup_progress(clean)
                    if prog:
                        last_prog.update(prog)

                    # 进度刷新行（通常来自 \r）：只保留最新一条，避免刷屏但让用户能看到原始进度输出
                    is_progress_line = bool(prog) or bool(_BILIUP_ANY_UNIT_RE.search(clean)) or bool(_BILIUP_ETA_RE.search(clean))
                    line = clean.strip()
                    if line:
                        if is_progress_line:
                            progress_line = line
                        else:
                            logs.append(line)

                    now = time.time()
                    # 限频写状态（避免频繁 IO）
                    if now - last_flush >= 0.6:
                        updates = {
                            "logs": list(logs),
                            "progress_line": progress_line,
                            "updated_at": int(now),
                        }
                        # 使用 last_prog，避免“写入时刚好没解析到进度行”导致进度长时间不动
                        if last_prog:
                            updates.update(last_prog)
                        _update_upload_state(**updates)
                        last_flush = now

            # 处理残留 buffer（避免最后一段日志丢失）
            try:
                tail = _ANSI_ESCAPE_RE.sub("", buf.decode("utf-8", errors="replace")).strip()
                if tail:
                    tail_prog = _parse_biliup_progress(tail)
                    if tail_prog:
                        last_prog.update(tail_prog)
                    if bool(tail_prog) or bool(_BILIUP_ANY_UNIT_RE.search(tail)) or bool(_BILIUP_ETA_RE.search(tail)):
                        progress_line = tail
                    else:
                        logs.append(tail)
            except Exception:
                pass

            # 进程结束
            rc = proc.wait(timeout=5)
            st = _get_upload_state()
            cancel_requested = bool(st.get("cancel_requested"))
            cancel_reason = str(st.get("cancel_reason") or "").strip()
            status = "done" if rc == 0 and not cancel_requested else ("cancelled" if cancel_requested else "error")
            final_updates = {
                "running": False,
                "status": status,
                "exit_code": int(rc),
                "updated_at": int(time.time()),
                "logs": list(logs),
                "progress_line": progress_line,
            }
            if cancel_requested:
                final_updates["cancel_reason"] = cancel_reason or "user"
            # done 时补齐 percent
            if status == "done":
                final_updates["percent"] = 1.0
            _update_upload_state(**final_updates)
        except Exception as e:
            _update_upload_state(
                running=False,
                status="error",
                error=str(e),
                progress_line="",
                updated_at=int(time.time()),
            )
        finally:
            _set_upload_runtime(None)
            try:
                if proc and proc.stdout:
                    proc.stdout.close()
            except Exception:
                pass
            try:
                if master_fd is not None:
                    os.close(master_fd)
            except Exception:
                pass
            try:
                if slave_fd is not None:
                    os.close(slave_fd)
            except Exception:
                pass

    t = threading.Thread(target=_worker, daemon=True)
    t.start()


def _format_eta_seconds(seconds: Optional[float]) -> str:
    if seconds is None:
        return ""
    try:
        s = float(seconds)
    except Exception:
        return ""
    if s <= 0:
        return ""  # 已接近完成

    s_int = int(round(s))
    if s_int < 60:
        return f"约 {s_int} 秒"
    m = s_int // 60
    sec = s_int % 60
    if m < 60:
        return f"约 {m} 分 {sec} 秒"
    h = m // 60
    m2 = m % 60
    return f"约 {h} 小时 {m2} 分"


def _estimate_eta_seconds(state: dict) -> Optional[float]:
    """根据已处理时长/已用时间估算剩余时间（秒）。"""
    if not isinstance(state, dict):
        return None
    if state.get("running") is not True:
        return None
    try:
        total = float(state.get("total_seconds") or 0.0)
        processed = float(state.get("processed_seconds") or 0.0)
    except Exception:
        return None
    remaining = max(0.0, total - processed)
    if remaining <= 0:
        return 0.0

    try:
        started_at = int(state.get("started_at") or 0)
    except Exception:
        started_at = 0
    elapsed = float(max(0, int(time.time()) - started_at))
    # rate: “视频秒/真实秒”，例如 2.0 表示 1 秒真实处理 2 秒视频
    if elapsed <= 3.0 or processed <= 1.0:
        # 刚开始时波动大：先按 1x 粗估
        return remaining

    rate = processed / elapsed
    # 防止异常值导致 ETA 爆炸
    if rate <= 0.05:
        rate = 0.05
    if rate > 20.0:
        rate = 20.0
    return remaining / rate

# ------------------ 工具函数 ------------------
def ffmpeg_exists() -> bool:
    return shutil.which("ffmpeg") is not None

def sanitize_name(name: str) -> Path:
    p = name.lstrip("/\\")
    # 括弧笑bilibili/压制版 或 括弧笑bilibili/原版
    # 如果路径不以 "括弧笑bilibili" 开头，则补上默认前缀
    if p and not p.startswith("括弧笑bilibili"):
        if p.startswith("压制版") or p.startswith("原版"):
            p = "括弧笑bilibili/" + p
        else:
            p = "括弧笑bilibili/压制版/" + p
        
    path = (VIDEO_DIR / p).resolve()
    if not str(path).startswith(str(VIDEO_DIR.resolve())):
        raise HTTPException(400, "非法路径")
    return path


def sanitize_output_name(name: str) -> Path:
    """Return a normalized path for an output file.

    Clients may send a relative name that either refers to ``OUTPUT_DIR`` or,
    after the new move-feature, ``FINISHED_DIR``.  A prefixed value
    (``{FINISHED_PREFIX}...``) hints that the latter should be used.  If no
    prefix is provided both bases are searched, returning the first existing
    file.
    """
    p = name.lstrip("/\\")

    # prefix handling remains for backwards compatibility, but everything lives under FINISHED_DIR now
    if p.startswith(FINISHED_PREFIX):
        rel = p[len(FINISHED_PREFIX):]
        path = (FINISHED_DIR / rel).resolve()
        if not str(path).startswith(str(FINISHED_DIR.resolve())):
            raise HTTPException(400, "非法路径")
        return path

    # simply resolve against finished directory and return; ignore OUTPUT_DIR since it's the same
    path = (FINISHED_DIR / p).resolve()
    if not str(path).startswith(str(FINISHED_DIR.resolve())):
        raise HTTPException(400, "非法路径")
    return path

def iter_file_range(path: Path, start: int = 0, end: Optional[int] = None, chunk_size: int = 1024*1024):
    with path.open('rb') as f:
        f.seek(start)
        remaining = None if end is None else end - start + 1
        while True:
            read_size = chunk_size if remaining is None else min(chunk_size, remaining)
            data = f.read(read_size)
            if not data:
                break
            if remaining is not None:
                remaining -= len(data)
                if remaining <= 0:
                    yield data
                    break
            yield data


def _rel_output_path(path: Path) -> str:
    """Return a relative path string for ``path``.

    When the file lives in ``FINISHED_DIR`` include the special
    ``FINISHED_PREFIX`` so that clients know to look there.  Older state
    entries without the prefix remain supported.
    """
    # every output lives inside FINISHED_DIR; ignore OUTPUT_DIR alias
    try:
        rel = path.relative_to(FINISHED_DIR)
        return FINISHED_PREFIX + str(rel).replace("\\", "/")
    except Exception:
        # fallback if something is outside (unlikely)
        return str(path)


def _ffprobe_duration(path: Path) -> float:
    try:
        cmd = [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(path)
        ]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=3.0)
        if res.returncode != 0:
            return 0.0
        val = (res.stdout or "").strip()
        if not val or val == "N/A":
            return 0.0
        d = float(val)
        return d if d > 0 else 0.0
    except Exception:
        return 0.0


def _build_thumb_marks(duration: float, step_sec: int) -> list[float]:
    d = max(0.0, float(duration))
    if d <= 0:
        return []

    step = max(1, int(step_sec or 1))

    marks: list[float] = []
    t = 0.0
    while t < d:
        marks.append(round(t, 3))
        t += step

    tail = max(0.0, d - 0.1)
    if not marks or abs(marks[-1] - tail) > 0.2:
        marks.append(round(tail, 3))

    return marks


def _thumb_bucket_dir(
    video_path: Path,
    duration: float,
    step_sec: int,
    width: int,
    height: int,
    quality: int,
) -> Path:
    base_name = video_path.name or "unknown-video"
    safe_name = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "_", base_name).strip(" .")
    if not safe_name:
        safe_name = "unknown-video"
    out_dir = THUMB_CACHE_DIR / safe_name
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir


def _ensure_thumb_file(video_path: Path, out_file: Path, t_sec: float, width: int, height: int, quality: int) -> bool:
    if out_file.exists() and out_file.stat().st_size > 0:
        return True

    vf = f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        f"{max(0.0, float(t_sec)):.3f}",
        "-i",
        str(video_path),
        "-frames:v",
        "1",
        "-vf",
        vf,
        "-q:v",
        str(int(quality)),
        "-y",
        str(out_file),
    ]
    try:
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10.0)
        if res.returncode != 0:
            return False
    except Exception:
        return False

    return out_file.exists() and out_file.stat().st_size > 0

PREVIEW_PREFIX = "预览版-"
ENCODE_PREFIX = "投稿版-"

# ------------------ 数据模型 ------------------
class SliceRequest(BaseModel):
    start: float = Field(ge=0)
    end: float = Field(gt=0)

class VideoClip(BaseModel):
    name: str
    clips: List[SliceRequest]

class MultiVideoRequest(BaseModel):
    videos: List[VideoClip]
    out_basename: Optional[str] = None
    username: str  # 新增字段
    source_mode: str = "encode"  # encode | original
    cut_mode: str = "fast"  # fast | precise

class SliceJob(BaseModel):
    id: str
    source: str
    status: str = Field(default="queued")
    out_path: Optional[str] = None
    error: Optional[str] = None


class CancelMergeRequest(BaseModel):
    job_id: Optional[str] = None
    merge_token: Optional[str] = None


class DeleteOutputRequest(BaseModel):
    file: str

# ------------------ FastAPI 应用 ------------------
app = FastAPI(title="Multi-Video Slicer", version="1.4")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/thumb-cache", StaticFiles(directory=THUMB_CACHE_DIR), name="thumb-cache")
templates = Jinja2Templates(directory=TEMPLATE_DIR)
JOBS: dict[str, SliceJob] = {}


@app.on_event("startup")
def _startup_merge_state_reconcile():
    # 服务重启后若发现上一次任务仍标记 running，自动置为 error，避免死锁
    with _merge_state_lock:
        state = _read_merge_state_unlocked()
        if state.get("running") is True:
            state["running"] = False
            state["status"] = "error"
            state.setdefault("started_at", int(time.time()))
            state["error"] = "服务重启，已自动将 running 任务标记为 error"
            state["finished_at"] = int(time.time())
            _write_merge_state_unlocked(state)

    # 启动时清理可能遗留的临时切片文件，避免 TMP_OUTPUT_DIR 长期累积
    try:
        for p in TMP_OUTPUT_DIR.iterdir():
            try:
                if p.is_file():
                    p.unlink()
                elif p.is_dir():
                    shutil.rmtree(p, ignore_errors=True)
            except Exception:
                pass
    except Exception:
        pass

    # 同时清理封面目录，避免旧封面无主堆积
    try:
        for p in COVER_DIR.iterdir():
            try:
                if p.is_file():
                    p.unlink()
                elif p.is_dir():
                    shutil.rmtree(p, ignore_errors=True)
            except Exception:
                pass
    except Exception:
        pass


@app.get("/api/merge_status")
async def merge_status(merge_token: Optional[str] = None):
    state = _get_merge_state()
    token = (merge_token or "").strip()
    state_token = str(state.get("merge_token") or "").strip()
    authed = bool(token and state_token and token == state_token)

    # 未授权：不返回进度/输出/错误等信息（避免其他用户看到“合并进度条”等无意义信息）
    if not authed:
        return {"running": False}

    eta_seconds = _estimate_eta_seconds(state)
    eta_human = _format_eta_seconds(eta_seconds)

    full = dict(state)
    if "running" not in full:
        full["running"] = False
    full["eta_seconds"] = eta_seconds
    full["eta_human"] = eta_human
    return full


@app.post("/api/cancel_merge")
async def cancel_merge(body: CancelMergeRequest = Body(...)):
    """取消当前合并任务。

    约束：服务只允许单任务运行。
    """
    state = _get_merge_state()
    if state.get("running") is not True:
        return {"ok": True, "status": "idle"}

    req_job_id = (getattr(body, "job_id", None) or "").strip()
    req_token = (getattr(body, "merge_token", None) or "").strip()
    cur_job_id = str(state.get("job_id") or "").strip()
    cur_token = str(state.get("merge_token") or "").strip()

    if cur_token and (not req_token or req_token != cur_token):
        raise HTTPException(status_code=403, detail="只能取消自己发起的合并任务")
    if req_job_id and cur_job_id and req_job_id != cur_job_id:
        raise HTTPException(status_code=409, detail="任务已变更，请刷新后重试")

    _merge_cancel_event.set()
    _update_merge_state(
        status="cancelling",
        stage=state.get("stage") or "running",
        cancel_requested=True,
        cancel_requested_at=int(time.time()),
    )
    _terminate_current_merge_proc()
    return {"ok": True, "status": "cancelling"}

# ------------------ 视频列表与流 ------------------
@app.get("/api/videos")
async def list_videos() -> List[dict]:
    files = []
    for p in VIDEO_DIR.rglob("*"):
        if p.is_file() and p.suffix.lower() in ALLOWED_EXTS and p.name.startswith(PREVIEW_PREFIX):
            rel_path = p.relative_to(VIDEO_DIR)
            files.append({
                "name": str(rel_path),
                "size": p.stat().st_size,
                "modified": int(p.stat().st_mtime)
            })
    files.sort(key=lambda x: x["name"].lower())
    return files

@app.get("/api/video/{name:path}")
async def stream_video(name: str, request: Request):
    path = sanitize_name(name)
    if not path.exists():
        raise HTTPException(404, "Video not found")
    file_size = path.stat().st_size
    headers = {}
    range_header = request.headers.get('Range')
    if range_header:
        try:
            units, rng = range_header.split("=")
            start_s, end_s = rng.split("-")
            start = int(start_s) if start_s else 0
            end = int(end_s) if end_s else file_size - 1
            end = min(end, file_size - 1)
            if start > end or start < 0:
                raise ValueError
        except Exception:
            raise HTTPException(416, "Invalid Range header")
        headers.update({
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(end - start + 1)
        })
        return StreamingResponse(
            iter_file_range(path, start, end),
            media_type=mimetypes.guess_type(str(path))[0] or "application/octet-stream",
            status_code=206,
            headers=headers
        )
    headers.update({'Accept-Ranges': 'bytes', 'Content-Length': str(file_size)})
    return StreamingResponse(
        iter_file_range(path),
        media_type=mimetypes.guess_type(str(path))[0] or "application/octet-stream",
        headers=headers
    )


@app.get("/api/thumb_manifest")
async def thumb_manifest(
    name: str,
    step: int = 30,
    width: int = 128,
    height: int = 72,
    quality: int = 8,
):
    if not ffmpeg_exists():
        raise HTTPException(status_code=500, detail="ffmpeg not found in PATH")

    path = sanitize_name(name)
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Video not found")

    step = 30
    width = max(64, min(480, int(width or 128)))
    height = max(36, min(270, int(height or 72)))
    quality = max(4, min(25, int(quality or 8)))

    duration = _ffprobe_duration(path)
    if duration <= 0:
        return {"thumbs": [], "duration": 0, "effective_step": step}

    marks = _build_thumb_marks(duration, step)
    out_dir = _thumb_bucket_dir(path, duration, step, width, height, quality)
    bucket = out_dir.name

    thumbs: list[dict] = []
    for i, t in enumerate(marks):
        file_name = f"{i:04d}.jpg"
        file_path = out_dir / file_name
        ok = await asyncio.to_thread(_ensure_thumb_file, path, file_path, t, width, height, quality)
        if not ok:
            continue
        thumbs.append({"time": t, "url": f"/thumb-cache/{bucket}/{file_name}"})

    return {
        "thumbs": thumbs,
        "duration": duration,
        "effective_step": step,
    }


@app.get("/api/thumb_manifest_stream")
async def thumb_manifest_stream(
    request: Request,
    name: str,
    step: int = 30,
    width: int = 128,
    height: int = 72,
    quality: int = 8,
):
    if not ffmpeg_exists():
        raise HTTPException(status_code=500, detail="ffmpeg not found in PATH")

    path = sanitize_name(name)
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Video not found")

    step = 30
    width = max(64, min(480, int(width or 128)))
    height = max(36, min(270, int(height or 72)))
    quality = max(4, min(25, int(quality or 8)))

    duration = _ffprobe_duration(path)
    if duration <= 0:
        return StreamingResponse(iter([json.dumps({"type": "done", "thumbs": 0}, ensure_ascii=False) + "\n"]), media_type="application/x-ndjson")

    marks = _build_thumb_marks(duration, step)
    out_dir = _thumb_bucket_dir(path, duration, step, width, height, quality)
    bucket = out_dir.name

    async def _iter_lines():
        meta = {
            "type": "meta",
            "duration": duration,
            "effective_step": step,
            "total": len(marks),
        }
        yield json.dumps(meta, ensure_ascii=False) + "\n"

        emitted = 0
        for i, t in enumerate(marks):
            if await request.is_disconnected():
                break
            file_name = f"{i:04d}.jpg"
            file_path = out_dir / file_name
            ok = await asyncio.to_thread(_ensure_thumb_file, path, file_path, t, width, height, quality)
            if not ok:
                continue
            emitted += 1
            item = {
                "type": "thumb",
                "index": i,
                "time": t,
                "url": f"/thumb-cache/{bucket}/{file_name}",
            }
            yield json.dumps(item, ensure_ascii=False) + "\n"

        yield json.dumps({"type": "done", "thumbs": emitted}, ensure_ascii=False) + "\n"

    return StreamingResponse(_iter_lines(), media_type="application/x-ndjson")


# ------------------ 音频波形 ------------------
WAVEFORM_CACHE_DIR = BASE_DIR / "waveform_cache"
WAVEFORM_CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _waveform_cache_path(video_path: Path, duration: float, samples: int) -> Path:
    base_name = video_path.name or "unknown-video"
    safe_name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", base_name).strip(" .")
    if not safe_name:
        safe_name = "unknown-video"
    return WAVEFORM_CACHE_DIR / f"{safe_name}__{int(duration)}__{samples}.json"


def _extract_waveform(video_path: Path, duration: float, samples: int) -> list[float]:
    """Use ffmpeg to extract peak amplitude per sample bucket from the audio track."""
    if duration <= 0 or samples <= 0:
        return []

    cache_file = _waveform_cache_path(video_path, duration, samples)
    if cache_file.exists():
        try:
            data = json.loads(cache_file.read_text("utf-8"))
            if isinstance(data, list) and len(data) == samples:
                return data
        except Exception:
            pass

    # Use ffmpeg astats filter to get per-frame peak levels; alternatively
    # use "aformat" to downsample + raw PCM output to compute peaks ourselves.
    # Fastest approach: decode audio to raw s16le mono, read peak per bucket.
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-i", str(video_path),
        "-vn",              # no video
        "-ac", "1",         # mono
        "-ar", "8000",      # 8 kHz (enough for waveform visualisation)
        "-f", "s16le",      # raw signed 16-bit little-endian
        "-",                # stdout
    ]

    try:
        res = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=max(30, duration / 4),
        )
        if res.returncode != 0 or not res.stdout:
            return []
    except Exception:
        return []

    import struct

    raw = res.stdout
    total_samples_raw = len(raw) // 2  # 2 bytes per s16le sample
    if total_samples_raw == 0:
        return []

    bucket_size = max(1, total_samples_raw // samples)
    peaks: list[float] = []

    for i in range(samples):
        start = i * bucket_size * 2
        end = min(start + bucket_size * 2, len(raw))
        if start >= len(raw):
            peaks.append(0.0)
            continue

        chunk = raw[start:end]
        n = len(chunk) // 2
        if n == 0:
            peaks.append(0.0)
            continue

        max_abs = 0
        for j in range(n):
            val = struct.unpack_from("<h", chunk, j * 2)[0]
            a = abs(val)
            if a > max_abs:
                max_abs = a

        peaks.append(round(max_abs / 32768.0, 4))

    # normalise to 0..1
    max_peak = max(peaks) if peaks else 0
    if max_peak > 0:
        peaks = [round(p / max_peak, 4) for p in peaks]

    try:
        cache_file.write_text(json.dumps(peaks, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass

    return peaks


@app.get("/api/waveform")
async def waveform_api(name: str, samples: int = 800):
    if not ffmpeg_exists():
        raise HTTPException(status_code=500, detail="ffmpeg not found in PATH")

    path = sanitize_name(name)
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Video not found")

    samples = max(100, min(4000, int(samples or 800)))
    duration = _ffprobe_duration(path)
    if duration <= 0:
        return {"peaks": [], "duration": 0, "samples": 0}

    peaks = await asyncio.to_thread(_extract_waveform, path, duration, samples)
    return {"peaks": peaks, "duration": duration, "samples": len(peaks)}


# ------------------ 视频目录树 ------------------
@app.get("/api/tree")
async def video_tree(path: str = ""):
    """按需（懒加载）返回 VIDEO_DIR 下某个目录的一层子节点。

    - path 为空时表示根目录。
    - 只扫描一层，不递归，避免一次性扫描全盘。
    - dir 节点返回 hasChildren，用于前端决定是否可展开。
    """

    def _dir_has_preview_files(dir_path: Path) -> bool:
        """递归检查目录下是否存在预览版文件。"""
        try:
            for entry in dir_path.iterdir():
                try:
                    if entry.is_file() and entry.suffix.lower() in ALLOWED_EXTS and entry.name.startswith(PREVIEW_PREFIX):
                        return True
                    if entry.is_dir():
                        if _dir_has_preview_files(entry):
                            return True
                except Exception:
                    continue
        except Exception:
            pass
        return False

    # 逻辑根目录强制设为"括弧笑bilibili/压制版"
    encode_root = VIDEO_DIR / "括弧笑bilibili" / "压制版"
    
    # 将前端传入的相对路径映射到逻辑根目录下
    target_dir = (encode_root / path.strip("/\\")).resolve()
    
    # 安全性检查：确保仍然在 encode_root 范围内
    if not str(target_dir).startswith(str(encode_root.resolve())):
         raise HTTPException(status_code=400, detail="非法路径")

    if not target_dir.exists() or not target_dir.is_dir():
        return []

    cache_key = str(target_dir)
    now = time.time()
    with _tree_cache_lock:
        cached = _tree_cache.get(cache_key)
        if cached is not None:
            ts, data = cached
            if now - ts <= 5.0:
                return data

    dirs: List[Path] = []
    files: List[Path] = []
    try:
        for p in target_dir.iterdir():
            try:
                if p.is_dir():
                    if not _dir_has_preview_files(p):
                        continue
                    dirs.append(p)
                elif p.is_file() and p.suffix.lower() in ALLOWED_EXTS and p.name.startswith(PREVIEW_PREFIX):
                    files.append(p)
            except Exception:
                continue
    except Exception:
        raise HTTPException(status_code=500, detail="无法读取目录")

    dirs.sort(key=lambda x: x.name.lower(), reverse=True)
    files.sort(key=lambda x: x.name.lower())

    tree: List[dict] = []
    for d in dirs:
        # 返回相对于 encode_root 的路径（不含"压制版"）
        rel = str(d.relative_to(encode_root)).replace("\\", "/")
        tree.append(
            {
                "type": "dir",
                "name": d.name,
                "path": rel,
                "hasChildren": True,
            }
        )

    for f in files:
        # 返回相对于 encode_root 的路径
        rel_file = str(f.relative_to(encode_root)).replace("\\", "/")
        st = f.stat()
        tree.append(
            {
                "type": "file",
                "name": rel_file,
                "basename": f.name,
                "size": st.st_size,
                "mtime": st.st_mtime,
                "duration": 0,
            }
        )

    with _tree_cache_lock:
        _tree_cache[cache_key] = (now, tree)
        # 简单限长，防止目录过多导致缓存无限增长
        if len(_tree_cache) > 512:
            # 删除最旧的一批
            oldest = sorted(_tree_cache.items(), key=lambda kv: kv[1][0])[:128]
            for k, _ in oldest:
                _tree_cache.pop(k, None)

    return tree

@app.get("/api/dir_durations")
async def get_dir_durations(path: str = ""):
    target_dir = sanitize_name(path)
    if not target_dir.exists() or not target_dir.is_dir():
        return {}

    res_map = {}
    for f in target_dir.iterdir():
        # 简单过滤，只处理常见视频格式，且只处理预览版文件（与前端列表保持一致，避免全量扫描）
        if f.is_file() and f.suffix.lower() in ALLOWED_EXTS and f.name.startswith(PREVIEW_PREFIX):
            try:
                cmd = ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(f)]
                # 设置超时，如果文件太多或太大，前端也是异步请求
                res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=1.0)
                if res.returncode == 0:
                    val = res.stdout.strip()
                    if val and val != "N/A":
                        res_map[f.name] = float(val)
            except:
                pass
    return res_map


# ------------------ 批量合并 ------------------
@app.post("/api/slice_merge_all")
async def slice_merge_all(body: MultiVideoRequest = Body(...), bg: BackgroundTasks = None):
    # 按切割模式设置总时长上限（单位：秒） - fast: 120 分钟, precise: 30 分钟
    if getattr(body, "cut_mode", "fast") == "precise":
        MAX_TOTAL_SECONDS = 30 * 60
    else:
        MAX_TOTAL_SECONDS = 120 * 60

    # 空片段校验：避免前端误提交导致 ffmpeg 报错
    total_clips = sum(len(v.clips) for v in (body.videos or []))
    if total_clips <= 0:
        raise HTTPException(400, "请至少添加一个视频片段")

    # 基础校验
    total_seconds = 0.0
    for vid in body.videos:
        for clip in vid.clips:
            if clip.end <= clip.start:
                raise HTTPException(400, f"片段结束时间必须大于开始时间: {vid.name}")
            total_seconds += float(clip.end - clip.start)

    # 总时长限制：按切割模式限制（fast: 120 分钟，precise: 30 分钟）
    if total_seconds > MAX_TOTAL_SECONDS:
        max_minutes = MAX_TOTAL_SECONDS // 60
        raise HTTPException(400, f"最终合并总时长不能超过{max_minutes}分钟（当前约 {int(total_seconds)} 秒）")

    username = getattr(body, "username", None) or "user"
    # 简单对用户名做文件名安全处理，避免目录穿越或者特殊字符
    safe_user = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "_", username).strip(" .")
    if not safe_user:
        safe_user = "user"

    if not ffmpeg_exists():
        raise HTTPException(500, "ffmpeg not found in PATH")
    
    ts = datetime.now().strftime("%Y%m%d_%H%M")
    # 输出文件名改为：用户名-原本名字-时间戳.mp4，并放在用户子目录中
    out_basename_base = f"{username}-{body.out_basename or 'merged'}-{ts}"
    out_basename = out_basename_base
    user_dir = FINISHED_DIR / safe_user  # directly write into finished directory
    user_dir.mkdir(parents=True, exist_ok=True)
    out_path = user_dir / f"{out_basename}.mp4"
    # 避免覆盖同名文件（例如同一秒内连续提交）
    suffix = 1
    while out_path.exists():
        out_basename = f"{out_basename_base}-{suffix}"
        out_path = OUTPUT_DIR / f"{out_basename}.mp4"
        suffix += 1

    job_id = f"job_{ts}_{os.getpid()}_{uuid4().hex[:6]}"
    merge_token = uuid4().hex
    # 存储相对于 OUTPUT_DIR 的路径，方便前端展示
    rel_out = _rel_output_path(out_path)
    job = SliceJob(id=job_id, source="multiple", status="queued", out_path=rel_out)
    JOBS[job_id] = job

    # ---- 全局并发限制 + 持久化写入 running 状态（同一把锁，避免竞争） ----
    with _merge_state_lock:
        cur_state = _read_merge_state_unlocked()
        if cur_state.get("running") is True:
            eta_human = _format_eta_seconds(_estimate_eta_seconds(cur_state))
            msg = "已有合并任务正在进行中，请稍后再试"
            if eta_human:
                msg = f"{msg}（预计剩余：{eta_human}）"
            raise HTTPException(status_code=409, detail=msg)
        # record the output path relative to whichever base currently holds it
        state = {
            "running": True,
            "job_id": job_id,
            "merge_token": merge_token,
            "username": username,
            "status": "running",
            "started_at": int(time.time()),
            "out_file": _rel_output_path(out_path),
            "stage": "queued",
            "total_clips": int(total_clips),
            "done_clips": 0,
            "total_seconds": float(total_seconds),
            "processed_seconds": 0.0,
            "percent": 0.0,
        }
        _write_merge_state_unlocked(state)

    # 新任务启动：清理上一轮可能残留的取消标志/运行态
    _merge_cancel_event.clear()
    _set_merge_runtime(job_id=job_id, proc=None)

    def run_merge(job: SliceJob, videos: List[VideoClip], out_path: Path, total_seconds_all: float, total_clips_all: int):
        job.status = "running"
        temp_files = []
        list_file: Optional[Path] = None
        processed_seconds = 0.0
        done_clips = 0

        # 运行线程启动时也写入运行态（便于取消时校验/诊断）
        _set_merge_runtime(job_id=job.id, proc=None)

        def _safe_percent(processed: float) -> float:
            if not total_seconds_all or total_seconds_all <= 0:
                return 0.0
            p = processed / float(total_seconds_all)
            if p < 0:
                return 0.0
            if p > 1:
                return 1.0
            return float(p)

        def _run_ffmpeg_with_progress(cmd: list, clip_duration: float, current_label: str):
            """Run ffmpeg and periodically update merge_state.json using ffmpeg -progress output.

            Rewritten for robustness while preserving cancellation and percent updates.
            """
            if _merge_cancel_event.is_set():
                raise MergeCancelled("用户取消合并")

            def _stop_proc(p: subprocess.Popen) -> None:
                try:
                    if p.poll() is None:
                        try:
                            p.terminate()
                        except Exception:
                            pass
                        for _ in range(25):
                            if p.poll() is not None:
                                break
                            time.sleep(0.05)
                        if p.poll() is None:
                            try:
                                p.kill()
                            except Exception:
                                pass
                except Exception:
                    pass

            # Prepare command and ensure -progress is present (avoid duplicate)
            cmd_with_progress = list(cmd)
            if "-progress" not in cmd_with_progress:
                try:
                    insert_at = next(i for i, v in enumerate(cmd_with_progress) if v == "-i")
                except StopIteration:
                    insert_at = len(cmd_with_progress)
                cmd_with_progress[insert_at:insert_at] = [
                    "-loglevel", "error",
                    "-nostats",
                    "-progress", "pipe:1",
                ]

            last_update = 0.0
            out_time_sec = 0.0
            tail = deque(maxlen=200)

            proc = subprocess.Popen(
                cmd_with_progress,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                universal_newlines=True,
            )
            _set_merge_runtime(proc=proc)
            assert proc.stdout is not None

            for raw_line in proc.stdout:
                if _merge_cancel_event.is_set():
                    _stop_proc(proc)
                    try:
                        proc.wait(timeout=0.5)
                    except Exception:
                        pass
                    raise MergeCancelled("用户取消合并")

                line = (raw_line or "").strip()
                if line:
                    tail.append(line)

                # parse key=value progress lines (out_time_ms/out_time_us)
                if "=" in line:
                    k, v = line.split("=", 1)
                    k = k.strip()
                    v = v.strip()
                    if k == "out_time_ms":
                        try:
                            out_time_sec = max(0.0, int(v) / 1_000_000.0)
                        except Exception:
                            pass
                    elif k == "out_time_us":
                        try:
                            out_time_sec = max(0.0, int(v) / 1_000_000.0)
                        except Exception:
                            pass

                # periodic state update (throttled)
                now_mono = time.monotonic()
                if now_mono - last_update >= 0.5:
                    effective = out_time_sec
                    if clip_duration and clip_duration > 0 and effective > clip_duration:
                        effective = clip_duration
                    processed_now = processed_seconds + float(effective)
                    _update_merge_state(
                        stage="slicing",
                        current=current_label,
                        total_clips=int(total_clips_all),
                        done_clips=int(done_clips),
                        total_seconds=float(total_seconds_all),
                        processed_seconds=float(processed_now),
                        percent=_safe_percent(processed_now),
                    )
                    last_update = now_mono

            rc = proc.wait()
            _set_merge_runtime(proc=None)

            if _merge_cancel_event.is_set():
                raise MergeCancelled("用户取消合并")

            if rc != 0:
                tail_txt = "\n".join(list(tail)[-60:])
                raise RuntimeError("ffmpeg 失败：" + tail_txt)


        def _run_ffmpeg_concat_with_cancel(cmd: list):
            if _merge_cancel_event.is_set():
                raise MergeCancelled("用户取消合并")

            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                universal_newlines=True,
            )
            _set_merge_runtime(proc=proc)

            try:
                while True:
                    if _merge_cancel_event.is_set():
                        try:
                            if proc.poll() is None:
                                proc.terminate()
                        except Exception:
                            pass
                        try:
                            proc.wait(timeout=0.5)
                        except Exception:
                            pass
                        raise MergeCancelled("用户取消合并")

                    rc = proc.poll()
                    if rc is not None:
                        out, err = proc.communicate(timeout=0.2)
                        
                        if _merge_cancel_event.is_set():
                            raise MergeCancelled("用户取消合并")

                        if rc != 0:
                            tail = (err or out or "").strip()
                            if len(tail) > 4000:
                                tail = tail[-4000:]
                            raise RuntimeError("ffmpeg 合并失败：" + ("\n" + tail if tail else ""))
                        return
                    time.sleep(0.2)
            finally:
                _set_merge_runtime(proc=None)

        try:
            _update_merge_state(
                status="running",
                stage="slicing",
                total_clips=int(total_clips_all),
                done_clips=0,
                total_seconds=float(total_seconds_all),
                processed_seconds=0.0,
                percent=0.0,
            )

            for vid_idx, vid in enumerate(videos):
                if _merge_cancel_event.is_set():
                    raise MergeCancelled("用户取消合并")
                
                # ----------------- 源文件版本替换逻辑（新版目录结构） -----------------
                target_name = vid.name
                # 如果前端传来的路径没带“括弧笑bilibili/压制版”，补上它以便后续替换逻辑生效
                if target_name and not target_name.startswith("括弧笑bilibili"):
                    if target_name.startswith("压制版") or target_name.startswith("原版"):
                        target_name = "括弧笑bilibili/" + target_name
                    else:
                        target_name = "括弧笑bilibili/压制版/" + target_name
                
                p = Path(target_name)

                if p.name.startswith(PREVIEW_PREFIX):

                    bare_name = p.name[len(PREVIEW_PREFIX):]  # 去掉“预览版-”
                    parts = list(p.parts)  # ['括弧笑bilibili','压制版','2026','02','22','预览版-1.mp4']

                    if body.source_mode == "encode":
                        # 压制版目录保持不变，只替换文件名前缀
                        new_filename = ENCODE_PREFIX + bare_name
                        new_path = Path(*parts).parent / new_filename

                    elif body.source_mode == "original":
                        # 目录结构: 括弧笑bilibili/压制版/... -> 括弧笑bilibili/原版/...
                        if parts and len(parts) >= 2 and parts[0] == "括弧笑bilibili" and parts[1] == "压制版":
                            parts[1] = "原文件"
                        else:
                            raise HTTPException(400, f"无法识别压制版目录结构: {vid.name}")

                        new_filename = bare_name  # 原版没有前缀
                        new_path = Path(*parts).parent / new_filename

                    else:
                        raise HTTPException(400, f"unsupported source_mode: {body.source_mode}")

                    target_name = str(new_path).replace("\\", "/")
                src = sanitize_name(target_name)
                if not src.exists():
                    raise FileNotFoundError(f"找不到源文件 (模式: {body.source_mode}): {target_name}")
                for i, clip in enumerate(vid.clips):
                    if _merge_cancel_event.is_set():
                        raise MergeCancelled("用户取消合并")
                    if clip.end <= clip.start:
                        raise ValueError(f"Clip end <= start in {vid.name}")
                    tmp = TMP_OUTPUT_DIR / f"{job.id}_{vid_idx}_{i}.ts"
                    # 先加入清理列表：避免取消/失败发生在 temp_files.append 之前导致残留
                    if tmp not in temp_files:
                        temp_files.append(tmp)
                    duration = clip.end - clip.start
                    
                    # 根据切割模式选择不同的编码策略
                    cut_mode = getattr(body, "cut_mode", "fast")

                    if cut_mode == "precise":
                        # 精准切割（优化性能）：采用 "预跳（input -ss）+ 精调（post -ss）" 的混合策略。
                        fast_seek = max(0.0, float(clip.start) - 1.0)
                        delta = float(clip.start) - fast_seek

                        cmd = ["ffmpeg", "-y"]
                        if fast_seek > 0:
                            cmd += ["-ss", f"{fast_seek:.3f}"]
                        cmd += ["-i", str(src)]
                        if delta > 0:
                            cmd += ["-ss", f"{delta:.3f}"]
                        cmd += [
                            "-t", f"{float(duration):.3f}",
                            "-c:v", "libx264",
                            "-preset", "veryfast",
                            "-crf", "23",
                            "-pix_fmt", "yuv420p",
                            "-c:a", "copy",
                            "-avoid_negative_ts", "1",
                            "-f", "mpegts",
                            str(tmp)
                        ]
                    else:
                        # 快速切割：使用 ffmpeg 流复制（更快但切点为关键帧对齐）
                        cmd = [
                            "ffmpeg", "-y",
                            "-ss", f"{float(clip.start):.3f}",
                            "-i", str(src),
                            "-t", f"{float(duration):.3f}",
                            "-c", "copy",
                            "-avoid_negative_ts", "1",
                            "-f", "mpegts",
                            str(tmp)
                        ]

                    current_label = f"{vid.name} 片段 {i+1}/{len(vid.clips)}"
                    _update_merge_state(
                        stage="slicing",
                        current=current_label,
                        total_clips=int(total_clips_all),
                        done_clips=int(done_clips),
                        total_seconds=float(total_seconds_all),
                        processed_seconds=float(processed_seconds),
                        percent=_safe_percent(processed_seconds),
                    )

                    _run_ffmpeg_with_progress(cmd, float(duration), current_label)

                    done_clips += 1
                    processed_seconds += float(duration)
                    _update_merge_state(
                        stage="slicing",
                        current=current_label,
                        total_clips=int(total_clips_all),
                        done_clips=int(done_clips),
                        total_seconds=float(total_seconds_all),
                        processed_seconds=float(processed_seconds),
                        percent=_safe_percent(processed_seconds),
                    )
            
            list_file = TMP_OUTPUT_DIR / f"{job.id}_list.txt"
            with list_file.open("w", encoding="utf-8") as f:
                for tmp in temp_files:
                    f.write(f"file '{tmp.name}'\n")

            _update_merge_state(
                stage="merging",
                current="合并中",
                percent=max(_safe_percent(processed_seconds), 0.98),
            )

            cmd_concat = ["ffmpeg","-hide_banner","-y","-f","concat","-safe","0","-i",str(list_file),"-c","copy","-bsf:a","aac_adtstoasc",str(out_path)]
            _run_ffmpeg_concat_with_cancel(cmd_concat)
            job.status = "done"

            # ---------- new feature: relocate merged result to finished directory ----------
            try:
                dest_base = FINISHED_DIR
                dest_base.mkdir(parents=True, exist_ok=True)
                try:
                    rel = out_path.relative_to(OUTPUT_DIR)
                except Exception:
                    rel = out_path.name
                dest = dest_base / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(out_path), str(dest))
                out_path = dest
            except Exception:
                # moving is best-effort; failure should not break the job
                pass

            # compute the path string that will be sent to frontend
            rel_out = _rel_output_path(out_path)
            job.out_path = rel_out

            _update_merge_state(
                running=False,
                status="done",
                stage="done",
                current=None,
                finished_at=int(time.time()),
                out_file=rel_out,
                percent=1.0,
                error=None,
            )
            _increment_stat("merge_success_count")
        except Exception as e:
            if isinstance(e, MergeCancelled):
                job.status = "cancelled"
                job.error = str(e)
                _update_merge_state(
                    running=False,
                    status="cancelled",
                    stage="cancelled",
                    current=None,
                    finished_at=int(time.time()),
                    out_file=None,
                    percent=_safe_percent(processed_seconds),
                    error=str(e),
                )
            else:
                job.status = "error"
                job.error = str(e)
                _update_merge_state(
                    running=False,
                    status="error",
                    stage="error",
                    current=None,
                    finished_at=int(time.time()),
                    out_file=str(out_path.relative_to(OUTPUT_DIR)),
                    percent=_safe_percent(processed_seconds),
                    error=str(e),
                )
        finally:
            _set_merge_runtime(proc=None)
            _merge_cancel_event.clear()

            def _unlink_with_retries(p: Path, retries: int = 20, delay: float = 0.1) -> None:
                for _ in range(max(1, retries)):
                    try:
                        if p.exists():
                            p.unlink()
                        return
                    except Exception:
                        time.sleep(delay)

            # 取消时：删除可能已经产生的半成品输出文件
            if getattr(job, "status", None) == "cancelled":
                try:
                    if out_path is not None and out_path.exists():
                        _unlink_with_retries(out_path)
                except Exception:
                    pass

            cleanup_targets = list(temp_files)
            if list_file is not None:
                cleanup_targets.append(list_file)

            # 兜底：按 job_id 模式把可能遗漏的临时文件也删掉（例如取消发生在写入列表之前）
            try:
                for p in TMP_OUTPUT_DIR.glob(f"{job.id}_*.ts"):
                    cleanup_targets.append(p)
                for p in TMP_OUTPUT_DIR.glob(f"{job.id}_list.txt"):
                    cleanup_targets.append(p)
            except Exception:
                pass

            # 去重
            seen = set()
            uniq_targets: list[Path] = []
            for p in cleanup_targets:
                try:
                    key = str(p)
                except Exception:
                    continue
                if key in seen:
                    continue
                seen.add(key)
                uniq_targets.append(p)

            for tmp in uniq_targets:
                try:
                    _unlink_with_retries(tmp)
                except Exception:
                    pass
    
    bg.add_task(run_merge, job, body.videos, out_path, float(total_seconds), int(total_clips))
    return {"job_id": job_id, "out_file": job.out_path, "merge_token": merge_token}


@app.get("/api/job/{job_id}")
async def job_status(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job.model_dump()

@app.get("/clips/{name:path}")
async def get_clip(name: str):
    # sanitize and ensure file is under OUTPUT_DIR (username subfolders supported)
    path = sanitize_output_name(name)
    if not path.exists():
        raise HTTPException(404, "Clip not found")
    _increment_stat("download_count")
    return FileResponse(path, filename=path.name)


@app.get("/api/stats")
async def get_stats():
    return _get_stats_state()


@app.post("/api/delete_output")
async def delete_output(body: DeleteOutputRequest = Body(...)):
    file_name = (getattr(body, "file", None) or "").strip()
    if not file_name:
        raise HTTPException(400, "缺少文件名")

    path = sanitize_output_name(file_name)
    if not path.exists():
        return {"ok": True, "deleted": False, "reason": "not_found"}
    if not path.is_file():
        raise HTTPException(400, "目标不是文件")

    try:
        path.unlink()
    except Exception as e:
        raise HTTPException(500, f"删除失败: {e}")

    return {"ok": True, "deleted": True}


@app.get("/api/check_file/{name:path}")
async def check_file(name: str):
    """检查输出文件是否存在

    "path" 参数允许包含斜杠，这样客户端传入诸如
    "成品/用户名/xxx.mp4" 的值时不会因为路由不匹配而返回 404。
    参数仍然会经过 `sanitize_output_name` 验证。"""
    try:
        path = sanitize_output_name(name)
        exists = path.exists() and path.is_file()
        return {"exists": exists, "file": name}
    except Exception:
        return {"exists": False, "file": name}

@app.get("/api/upload_status")
async def upload_status(upload_token: Optional[str] = None):
    # 未持有 token 的用户不返回任何状态（避免他人看到投稿进度/日志）
    if not _upload_token_ok(upload_token):
        return {"running": False}
    state = _get_upload_state()
    # 不回传 token
    state = dict(state)
    state.pop("upload_token", None)
    return state


class CancelUploadRequest(BaseModel):
    upload_token: Optional[str] = None


@app.post("/api/cancel_upload")
async def cancel_upload(body: CancelUploadRequest = Body(...)):
    token = (getattr(body, "upload_token", None) or "").strip()
    if not _upload_token_ok(token):
        raise HTTPException(403, "无权限")

    st = _get_upload_state()
    if st.get("running") is not True:
        return {"ok": True, "stopped": False, "reason": "not_running"}

    _update_upload_state(status="cancelling", cancel_requested=True, cancel_reason="user", updated_at=int(time.time()))
    stopped = _terminate_current_upload_proc()
    return {"ok": True, "stopped": bool(stopped)}

# ------------------ B站投稿（测试模式） ------------------
@app.post("/api/upload_bili")
async def upload_bili(
    file: str = Form(...),
    title: str = Form(...),
    description: str = Form(""),
    tags: str = Form(""),
    cover: Optional[UploadFile] = File(None)
):
    file_name = file
    title = title.strip()
    description = description.strip()
    tags = tags.strip()

    if not file_name or not title:
        return {"success": False, "message": "文件名或标题不能为空"}
    if not tags:
        return {"success": False, "message": "投稿必须至少包含一个标签"}

    # 只允许 OUTPUT_DIR 下文件，避免路径穿越
    try:
        video_path = sanitize_output_name(file_name)
    except Exception:
        return {"success": False, "message": "非法文件名"}
    if not video_path.exists():
        return {"success": False, "message": "视频不存在"}

    # 同一时间只允许一个投稿任务
    cur = _get_upload_state()
    if cur.get("running") is True:
        return {"success": False, "message": "已有投稿正在进行中，请先停止或等待完成"}

    # 处理封面图片
    cover_path_str = None
    if cover:
        # 校验封面图片
        if not cover.content_type.startswith("image/"):
             return {"success": False, "message": "封面只能是图片格式"}
        
        # 检查大小（虽非严格准确，但对 SpooledTemporaryFile 有效）
        # 先 seek 到末尾获取大小，再 seek 回头
        cover.file.seek(0, 2)
        size = cover.file.tell()
        cover.file.seek(0)
        
        if size > 5 * 1024 * 1024:
             return {"success": False, "message": "封面图片大小不能超过 5MB"}

        try:
            # 使用 UUID 生成唯一临时文件名，保存到 COVER_DIR 下以便集中管理
            COVER_DIR.mkdir(parents=True, exist_ok=True)
            ext = Path(cover.filename).suffix if cover.filename else ".jpg"
            cover_temp_name = f"cover_{uuid4().hex}{ext}"
            cover_path = COVER_DIR / cover_temp_name
            with cover_path.open("wb") as f:
                shutil.copyfileobj(cover.file, f)
            cover_path_str = str(cover_path)
        except Exception as e:
            return {"success": False, "message": f"封面保存失败: {e}"}

    # 构建将要执行的命令
    cmd = [
        "/rec/biliup/biliup",
        "-u", "/rec/cookies/bilibili/cookies-烦心事远离.json",
        "upload",
        "--copyright", "2",
        "--source", "https://live.bilibili.com/1962720",
        "--tid", "17",
        "--title", title,
        "--desc", description,
        "--tag", tags,
    ]
    
    if cover_path_str:
        cmd.extend(["--cover", cover_path_str])
        
    cmd.append(str(video_path))

    # 测试模式：不真正执行，返回命令字符串
    # return {
    #     "success": True,
    #     "message": "测试模式，不会实际上传",
    #     "cmd_preview": " ".join(cmd)
    # }

    # 脚本内开关控制测试模式
    if UPLOAD_TEST_MODE:
        # 测试模式下如果不真实执行，需要手动清理封面临时文件
        # if cover_path_str:
        #      try:
        #          Path(cover_path_str).unlink(missing_ok=True)
        #      except:
        #          pass
        return {
            "success": True,
            "message": "测试模式，不会实际上传",
            "cmd_preview": " ".join(cmd)
        }

    # 真实上传：启动后台进程，前端轮询状态
    upload_token = uuid4().hex
    meta = {
        "file": file_name,
        "title": title,
        "description": description,
        "tags": tags,
        "has_cover": bool(cover_path_str),
        "cmd": " ".join(cmd),
    }
    
    # 注意：真实上传结束后需要清理 cover_temp_file。
    # 这里暂不传递清理逻辑给 upload_job，依靠系统定期清理或下次重启清理，
    # 或者可以在 upload_job done/error 逻辑里通过 meta 里的 cover path 进行清理。
    # 若要严格清理，可以将 cover path 放入 meta，并在 backend task 结束时执行清理。
    # 鉴于 _start_biliup_upload_job 逻辑较复杂，为降低风险，这里暂不侵入其内部清理逻辑，
    # 而是在 meta 中记录 cover_path，后续可增加自动清理机制。
    # 简单做法：让用户下次重启时清理，或者积累在 clips 目录下用户可手动删。
    # 优化：启动一个延时任务清理（但不知道上传何时结束）。
    # 最优解：修改 _start_biliup_upload_job 的 finally 块。
    # 本次修改不触碰 _start_biliup_upload_job，仅通过 meta 传递信息。
    if cover_path_str:
        meta["cover_temp_path"] = cover_path_str

    _start_biliup_upload_job(cmd, upload_token, meta)
    return {"success": True, "upload_token": upload_token}

# ------------------ 前端 HTML & CSS ------------------

# HTML template and CSS static files are now separated.

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    stats = _increment_stat("visit_count")
    return templates.TemplateResponse("index.html", {"request": request, "stats": stats})