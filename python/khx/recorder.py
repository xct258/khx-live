"""录播姬配置与 cookies 同步。

两件事：
    1. 从私有 GitHub 仓库下载 B 站 cookies（可选，按 md5 判断是否变化）；
    2. 把录制账号 cookies 和所有主播的房间号写进录播姬的 config.json。

为什么需要第 2 步：
    录播姬录制原画需要有效 cookies；房间号、自动录制开关也在这里统一维护，
    新增主播时只要在 config.toml 里加 room_id，再跑一次 sync 即可。
"""

from __future__ import annotations

import hashlib
import json
import os
import urllib.parse
import urllib.request
from pathlib import Path

from .config import Config, ConfigError
from .log import get_logger
from .util import atomic_write_bytes, atomic_write_json, read_json

# 录播姬默认的文件名模板，保证后续解析逻辑一致
DEFAULT_FILENAME_TEMPLATE = (
    "video/{{ name}}/{{ \"now\" | time_zone: \"Asia/Shanghai\" | format_date: \"yyy-MM-dd\" }}"
    "/{{ \"now\" | time_zone: \"Asia/Shanghai\" | format_date: \"录播姬_yyy年MM月dd日HH点mm分ss秒\" }}"
    "_{{ title }}_{{ name}}.flv"
)


# ---------------------------------------------------------------------------
# cookies 文本
# ---------------------------------------------------------------------------


def normalize_cookie(value: str) -> str:
    """把 "a=1;  b=2 ;" 规范成 "a=1; b=2"，便于比较。"""
    parts = [part.strip() for part in value.strip().split(";")]
    return "; ".join(part for part in parts if part)


def cookie_string_from_json(path: Path) -> str:
    """从 B 站 cookie JSON 生成 "name=value; ..." 字符串。

    JSON 结构：{"cookie_info": {"cookies": [{"name": ..., "value": ...}, ...]}}
    """
    if not path.is_file():
        raise ConfigError(f"cookie 文件不存在：{path}")

    data = read_json(path)
    cookies = data.get("cookie_info", {}).get("cookies", [])
    if not isinstance(cookies, list) or not cookies:
        raise ConfigError(f"cookie 文件格式不正确（缺少 cookie_info.cookies）：{path}")

    pairs = []
    for item in sorted(cookies, key=lambda cookie: cookie.get("name", "")):
        name = item.get("name")
        value = item.get("value")
        if name and value:
            pairs.append(f"{name}={value}")
    if not pairs:
        raise ConfigError(f"cookie 文件里没有有效条目：{path}")
    return "; ".join(pairs)


# ---------------------------------------------------------------------------
# GitHub 同步
# ---------------------------------------------------------------------------


def sync_cookies(config: Config, logger=None) -> bool:
    """按配置下载 cookies。

    返回 True 表示至少更新了一个文件；False 表示跳过或全部无变化。
    下载失败不会抛异常，只记录错误并继续，避免挡住后面的录制配置同步。
    """
    logger = logger or get_logger("khx.recorder")
    github = config.github
    if not github.enabled:
        logger.info("未启用 GitHub cookie 同步，跳过")
        return False

    token = _github_token(config)
    if not token:
        logger.error("未找到 GitHub Token（环境变量 XCT258_GITHUB_TOKEN 或 %s），跳过同步", github.token_file)
        return False

    changed = False
    for source in github.sources:
        remote = urllib.parse.quote(source.remote)
        url = (
            f"https://raw.githubusercontent.com/{github.repo}/{github.branch}/{remote}"
        )
        logger.info("下载 cookies：%s", source.remote)

        request = urllib.request.Request(
            url,
            headers={
                "Authorization": f"token {token}",
                "User-Agent": "khx-live-py",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                remote_bytes = response.read()
        except OSError as exc:
            logger.error("下载失败：%s（%s）", source.remote, exc)
            continue

        if _md5(remote_bytes) == _md5_file(source.local):
            logger.info("内容未变化：%s", source.local.name)
            continue

        atomic_write_bytes(source.local, remote_bytes)
        logger.info("已更新：%s", source.local)
        changed = True

    return changed


def _github_token(config: Config) -> str:
    """优先环境变量，其次 token 文件。"""
    from_env = os.environ.get("XCT258_GITHUB_TOKEN", "").strip()
    if from_env:
        return from_env
    token_file = config.github.token_file
    if token_file.is_file():
        return token_file.read_text(encoding="utf-8").strip()
    return ""


def _md5(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def _md5_file(path: Path) -> str:
    if not path.is_file():
        return ""
    return _md5(path.read_bytes())


# ---------------------------------------------------------------------------
# 录播姬 config.json
# ---------------------------------------------------------------------------


def sync_recorder_config(config: Config, logger=None) -> bool:
    """把 cookies 和房间列表同步到录播姬配置。

    返回 True 表示文件有改动，False 表示已经一致。
    """
    logger = logger or get_logger("khx.recorder")
    config_path = config.recorder.config_path

    if not config_path.is_file():
        logger.error("录播姬配置不存在：%s", config_path)
        return False

    try:
        recorder_config = read_json(config_path)
        new_cookie = cookie_string_from_json(config.recorder.record_cookie_json)
    except (OSError, ValueError, ConfigError) as exc:
        logger.error("读取配置失败：%s", exc)
        return False

    if not isinstance(recorder_config, dict):
        logger.error("录播姬配置格式不正确：%s", config_path)
        return False

    global_config = recorder_config.setdefault("global", {})
    _ensure_global_defaults(global_config)

    # ---- cookie ----
    cookie_node = global_config.setdefault("Cookie", {"HasValue": True, "Value": ""})
    existing = normalize_cookie(str(cookie_node.get("Value", "") or ""))
    canonical = normalize_cookie(new_cookie)
    cookie_changed = existing != canonical
    if cookie_changed:
        cookie_node["HasValue"] = True
        cookie_node["Value"] = canonical

    # ---- 房间 ----
    rooms_changed = _ensure_rooms(recorder_config, config)

    if not cookie_changed and not rooms_changed:
        logger.info("录播姬配置已是最新，无需修改")
        return False

    atomic_write_json(config_path, recorder_config)
    logger.info(
        "录播姬配置已更新（cookies %s，房间 %s）",
        "有变化" if cookie_changed else "无变化",
        "有变化" if rooms_changed else "无变化",
    )
    return True


def _ensure_global_defaults(global_config: dict) -> None:
    """补齐录制弹幕、礼物、文件名模板等必需开关。"""
    for key in ("RecordDanmaku", "RecordDanmakuGift"):
        node = global_config.get(key)
        if not isinstance(node, dict) or node.get("Value") is not True:
            global_config[key] = {"HasValue": True, "Value": True}

    template = global_config.get("FileNameRecordTemplate")
    if not isinstance(template, dict) or not template.get("Value"):
        global_config["FileNameRecordTemplate"] = {
            "HasValue": True,
            "Value": DEFAULT_FILENAME_TEMPLATE,
        }


def _ensure_rooms(recorder_config: dict, config: Config) -> bool:
    """把配置里的房间号合并进录播姬的 rooms 列表。

    已有房间保持原样，只补缺失的；不会删除用户手动添加的房间。
    """
    changed = False
    rooms = recorder_config.get("rooms")
    if not isinstance(rooms, list):
        rooms = []
        recorder_config["rooms"] = rooms
        changed = True

    existing_ids = set()
    for room in rooms:
        room_id = room.get("RoomId", {})
        if isinstance(room_id, dict):
            existing_ids.add(room_id.get("Value"))

    for streamer in config.enabled_streamers():
        if streamer.room_id is None or streamer.room_id in existing_ids:
            continue
        rooms.append(
            {
                "RoomId": {"HasValue": True, "Value": streamer.room_id},
                "AutoRecord": {"HasValue": True, "Value": True},
            }
        )
        existing_ids.add(streamer.room_id)
        changed = True

    return changed


# ---------------------------------------------------------------------------
# 对外入口
# ---------------------------------------------------------------------------


def sync_all(config: Config, logger=None) -> bool:
    """执行完整的同步流程。返回 True 表示有改动。"""
    logger = logger or get_logger("khx.recorder")
    cookies_changed = sync_cookies(config, logger)
    recorder_changed = sync_recorder_config(config, logger)
    return cookies_changed or recorder_changed


def dump_recorder_config(config: Config) -> dict:
    """读取当前录播姬配置，供 check 命令展示（不修改文件）。"""
    return json.loads(config.recorder.config_path.read_text(encoding="utf-8"))
