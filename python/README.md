# khx-live Python 版

通用直播录播处理工具：**录制监控 → 碎片清理 → FLV→MP4 → 弹幕压制 → B 站投稿 → 归档 → 按天清理**。

和旧版 shell 脚本相比，这一版的重点是：

- **通用多主播**：主播名、房间号、投稿账号、标题/简介模板全部在 `config.toml` 里配置，代码里不出现任何具体主播；
- **可恢复**：每场录播拆成 8 个幂等步骤，状态写入 JSON，失败后 `retry` 从断点继续；
- **零第三方依赖**：只用 Python 3.11+ 标准库（`tomllib` / `argparse` / `logging`），外部依赖仍是 ffmpeg、DanmakuFactory、biliup；
- **日志可读**：结构化日志按天轮转，单个任务有独立日志文件，不再有 `set -x` 刷屏。

## 目录结构

```
python/
├── config.example.toml     # 配置样例（含多主播示例）
├── pyproject.toml
├── khx/
│   ├── __main__.py         # CLI：watch / once / status / retry / cleanup / sync / check
│   ├── config.py           # TOML 解析 + 校验 + 主播默认值继承
│   ├── state.py            # 任务 JSON 状态与步骤流转
│   ├── media.py            # 文件名解析、ffprobe、remux、时长校验、封面
│   ├── danmaku.py          # XML→ASS、QSV/CPU 压制
│   ├── upload.py           # biliup 封装与标题/简介模板
│   ├── recorder.py         # cookies 下载、录播姬配置同步
│   ├── pipeline.py         # 8 步流水线、归档、清理
│   ├── log.py              # 日志初始化
│   └── util.py             # 子进程、原子写文件
└── tests/                  # 标准库 unittest，无需 ffmpeg
```

## 依赖

运行时只需要：

| 依赖 | 用途 | 说明 |
|---|---|---|
| Python 3.11+ | 运行 | 需要 `tomllib` |
| ffmpeg / ffprobe | 封装、压制、抽帧 | 必须在 `PATH` 中 |
| DanmakuFactory | XML→ASS | 路径在 `[danmaku].factory` 配置 |
| biliup | B 站投稿 | 路径在 `[upload].biliup` 配置 |
| 录播姬 | 录制（可选） | 本工具只同步它的配置，不负责启动 |

Python 侧**不需要 pip install**，直接 `python -m khx` 即可。

## 快速开始

```bash
cd python
cp config.example.toml config.toml
# 按需修改路径、主播、投稿账号
python -m khx --config config.toml check     # 自检
python -m khx --config config.toml sync      # 同步 cookies + 录播姬房间
python -m khx --config config.toml watch     # 常驻监控
```

手动处理一场已有的录播：

```bash
python -m khx --config config.toml once --dir "/rec/录播姬/video/某主播/2026-11-13"
```

查看状态 / 重试：

```bash
python -m khx --config config.toml status
python -m khx --config config.toml retry <任务id>
```

## 配置多主播

全局段 `[danmaku]`、`[encode]`、`[upload]`、`[archive]` 是默认值，每个 `[[streamers]]` 只需写差异：

```toml
[[streamers]]
id = "anchor-a"
name = "主播A"                       # 归档目录名
aliases = ["直播间昵称", "另一个昵称"]  # 匹配录制文件名
room_id = 1962720                    # 录播姬房间号；省略则不同步
# source_folders = ["/rec/录播姬/video/主播A"]  # 可选：按目录归属

[streamers.upload]
cookies = "/rec/cookies/bilibili/账号A.json"
source = "https://live.bilibili.com/1962720"
tags = ["直播回放"]
desc_template = """录制平台：{platform}
弹幕总数：{danmaku_count}
封面时间：{cover_p}P {cover_time}"""

[streamers.encode]
crf = 20                             # 单独覆盖编码质量
```

新增主播时只需要追加一段 `[[streamers]]`，不需要改代码。

**匹配规则**：

1. 录制文件名里的主播名命中 `aliases` / `name` / `id`；
2. 或目录属于该主播的 `source_folders`，且只有一个主播声明了该目录。

匹配不到会跳过并打印提示，不会误处理成别人的录播。

## 任务状态

状态文件：`<data_dir>/jobs/<主播id>-<时间>.json`

```json
{
  "id": "anchor-a-2026-11-13_195657",
  "streamer_id": "anchor-a",
  "steps": {
    "scan":   { "status": "done", "detail": "搬入 2 个文件…" },
    "remux":  { "status": "done" },
    "encode": { "status": "running" }
  }
}
```

步骤：`scan → remux → duration_check → encode → cover → upload → archive → cleanup_after`

- 失败步骤会记录 `failed` 和原因，`watch` 不会自动重跑失败任务；
- `retry` 会把第一个失败步骤及其后续步骤重置后继续，不会重复压制已完成的视频；
- `status` 用 ✅ / ⏭️ / ❌ / ⏳ 标记每一步。

## 归档结构

```
<videos_dir>/<主播名>/
├── 压制版/YYYY/MM/YYYY-MM-DD/投稿版-xxx.mp4
└── 原文件/YYYY/MM/YYYY-MM-DD/xxx.mp4、xxx.xml
```

中间文件放在 `<work_dir>/<主播名>/<开播时间>/`，处理完自动删除。

## 部署

### 复用现有 khx-live 镜像（推荐）

镜像里已经有 ffmpeg、DanmakuFactory、biliup、python3：

```bash
docker run -d --name khx-py \
  --network host \
  --restart unless-stopped \
  -v /mnt/ssd-1/xct258/khx-live:/rec \
  -v /mnt/ssd-1/xct258/khx-live-py:/app \
  -w /app/python \
  --entrypoint python3 \
  xct258/khx-live -m khx --config /app/python/config.toml watch
```

> 注意：新容器不要再启动录播姬进程（镜像入口已被 `--entrypoint` 覆盖），
> 录制继续由原来的 `khx-live` 容器负责，两个容器共享 `/rec`。
> 如果让新容器接管，需要额外处理录播姬端口冲突。

### systemd

宿主机需要安装 ffmpeg，并保证 biliup / DanmakuFactory 路径正确：

```ini
[Unit]
Description=khx-live python watcher
After=network-online.target

[Service]
WorkingDirectory=/opt/khx-live/python
ExecStart=/usr/bin/python3 -m khx --config /opt/khx-live/python/config.toml watch
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

## 和旧版的关系

旧版脚本（`视频处理脚本/`）**保持不动**，这一版放在 `python/`，可以并行灰度：

1. 用同一个 `/rec` 数据目录跑 `once --dir` 对比产物；
2. 确认压制版时长、封面、投稿标题/简介一致后，再让新服务接管 `watch`；
3. 回滚只需停掉新服务、恢复旧容器，状态文件不影响旧脚本。

## v1 未实现

- 预览版 / 高能进度条（只出投稿版）
- 按月追加原版到合集稿件
- rclone 网盘备份与弹幕 XML 上传
- 音频提取 / 语音识别
- 在线切片、Web 管理界面

这些在旧版里仍是默认关闭的功能，需要时可以按模块补回。
