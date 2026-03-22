import json
from pathlib import Path
import argparse
import sys

def load_json(path: Path):
    if not path.exists():
        raise FileNotFoundError(f"{path} not found")
    return json.loads(path.read_text(encoding="utf-8"))

def normalize_cookie_value(value: str):
    return ";".join([p.strip() for p in value.strip().split(";") if p.strip()])

def cookie_info_to_string(cookie_info: dict):
    cookies = cookie_info.get("cookies", [])
    if not isinstance(cookies, list):
        raise ValueError("cookie_info.cookies must be a list")
    # 按 name 排序，保持一致性
    cookies_sorted = sorted(cookies, key=lambda c: c.get("name", ""))
    pairs = []
    for c in cookies_sorted:
        name = c.get("name")
        value = c.get("value")
        if name is None or value is None:
            continue
        pairs.append(f"{name}={value}")
    return ";".join(pairs)

def parse_shell_conf(path: Path):
    if not path.exists():
        return {}
    out = {}
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if '=' not in line:
            continue
        k, v = line.split('=', 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k:
            out[k] = v
    return out


def main():
    parser = argparse.ArgumentParser(description="更新录播姬配置文件")
    parser.add_argument('--check', action='store_true', help='仅检测是否需要更新, 不写盘')
    args = parser.parse_args()

    # 从 /rec 目录读取配置文件
    conf_path = Path('/rec/config.conf')
    if not conf_path.is_file():
        print(f"[错误] /rec/config.conf 不存在: {conf_path}")
        sys.exit(3)
    conf = parse_shell_conf(conf_path)

    # 从 /rec/config.conf 获取 cookie 来源路径，必须由 record_cookie_json 或 biliup_up_cookies 提供
    cookie_path_value = conf.get('record_cookie_json') or conf.get('biliup_up_cookies')
    if not cookie_path_value:
        print('[错误] /rec/config.conf 中未设置 record_cookie_json 或 biliup_up_cookies')
        sys.exit(1)

    cookie_json_path = Path(cookie_path_value)
    config_json_path = Path('/rec/录播姬/config.json')

    if not cookie_json_path.is_file():
        print(f"[错误] 源cookie文件不存在: {cookie_json_path}")
        sys.exit(2)
    if not config_json_path.is_file():
        print(f"[错误] 录播姬config文件不存在: {config_json_path}")
        sys.exit(2)

    cookie_data = load_json(cookie_json_path)
    cfg_data = load_json(config_json_path)

    cookie_info = cookie_data.get("cookie_info")
    if cookie_info is None:
        print("[错误] cookie_info 节点不存在")
        sys.exit(3)

    new_cookie_value = cookie_info_to_string(cookie_info).strip()
    if not new_cookie_value:
        print("[错误] 生成cookie字符串为空")
        sys.exit(4)

    g = cfg_data.setdefault("global", {})

    # 确保固定字段存在
    if not isinstance(g.get("RecordDanmaku"), dict) or g.get("RecordDanmaku", {}).get("Value") is not True:
        g["RecordDanmaku"] = {"HasValue": True, "Value": True}
    if not isinstance(g.get("RecordDanmakuGift"), dict) or g.get("RecordDanmakuGift", {}).get("Value") is not True:
        g["RecordDanmakuGift"] = {"HasValue": True, "Value": True}

    # 确保 FileNameRecordTemplate 存在
    if not isinstance(g.get("FileNameRecordTemplate"), dict) or not g.get("FileNameRecordTemplate", {}).get("Value"):
        g["FileNameRecordTemplate"] = {"HasValue": True, "Value": "video/{{ name}}/{{ \"now\" | time_zone: \"Asia/Shanghai\" | format_date: \"yyy-MM-dd\" }}/{{ \"now\" | time_zone: \"Asia/Shanghai\" | format_date: \"录播姬_yyy年MM月dd日HH点mm分\" }}_{{ title }}_{{ name}}.flv"}

    # 确保 rooms 存在并包含默认项
    rooms = cfg_data.get("rooms")
    required_room = {"RoomId": {"HasValue": True, "Value": 1962720}, "AutoRecord": {"HasValue": True, "Value": True}}
    if not isinstance(rooms, list):
        cfg_data["rooms"] = [required_room]
    else:
        has_required = any(r.get("RoomId") == required_room["RoomId"] and r.get("AutoRecord") == required_room["AutoRecord"] for r in rooms)
        if not has_required:
            rooms.append(required_room)
            cfg_data["rooms"] = rooms

    c = g.setdefault("Cookie", {"HasValue": True, "Value": ""})

    existing_cookie_value = normalize_cookie_value(str(c.get("Value", "") or ""))
    canonical_new_value = normalize_cookie_value(new_cookie_value)

    if existing_cookie_value == canonical_new_value:
        print("配置一致，无需修改")
        sys.exit(0)

    if args.check:
        print("有配置需要更新")
        sys.exit(1)

    c["HasValue"] = True
    c["Value"] = canonical_new_value
    cfg_data["global"] = g

    config_json_path.write_text(json.dumps(cfg_data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"更新成功：{config_json_path}")
    print("旧值:", existing_cookie_value)
    print("新值:", canonical_new_value)
    sys.exit(0)

if __name__ == "__main__":
    main()