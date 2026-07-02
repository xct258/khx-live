
# khx-live

`khx-live` 是括弧笑的直播录制、备份与管理容器化解决方案。基于 Debian 镜像，整合 **录播姬 (BililiveRecorder)**、**biliup**、**DanmakuFactory** 等工具，提供从直播获取、弹幕压制、B站投稿到网盘备份的全自动流程。可选附带**在线切片**与**语音识别**服务。

> 本项目主要自用，依赖 B 站及相关工具的接口，使用时请遵守平台规则。全部代码由 AI 生成。

---

## 目录

- [架构概览](#架构概览)
- [容器数据布局](#容器数据布局)
- [快速开始](#快速开始)
- [配置参考](#配置参考)
- [环境变量](#环境变量)
- [功能详解](#功能详解)
  - [录播姬自动录制](#录播姬自动录制)
  - [视频处理与上传备份](#视频处理与上传备份)
  - [在线切片 (可选)](#在线切片-可选)
  - [语音识别 (可选)](#语音识别-可选)
- [构建与发布](#构建与发布)
- [常见问题](#常见问题)

---

## 架构概览

```
┌─────────────────────────────────────────────────────┐
│                    Docker 容器                        │
│  ┌──────────┐  ┌────────────┐  ┌─────────────────┐  │
│  │ 录播姬   │  │ 视频处理   │  │ 在线切片(可选)  │  │
│  │ :2356    │  │ 脚本定期   │  │ FastAPI :8186   │  │
│  │ 自动录制 │  │ 上传+备份  │  │ 浏览器裁剪视频 │  │
│  └──────────┘  └────────────┘  └─────────────────┘  │
│  ┌──────────────────┐  ┌────────────────────────┐   │
│  │ biliup           │  │ 语音识别(可选)         │   │
│  │ 投稿到B站        │  │ Whisper ASR :8286      │   │
│  └──────────────────┘  └────────────────────────┘   │
│                    host 网络模式                      │
└─────────────────────────────────────────────────────┘
         │
         ▼
   ┌──────────┐
   │ /rec     │  (宿主机挂载，数据持久化)
   │ 配置文件 │
   │ 录制视频 │
   │ cookies  │
   └──────────┘
```

---

## 容器数据布局

容器运行时所有持久化数据统一存放在宿主机挂载的 `/rec` 目录下：

| 子目录 | 说明 |
|---|---|
| `/rec/录播姬` | 录播姬录制的原始视频 |
| `/rec/biliup` | biliup 程序 + 后处理脚本 |
| `/rec/脚本` | 视频处理脚本集合 (自动同步) |
| `/rec/apps` | 额外可执行文件 (DanmakuFactory 等) |
| `/rec/在线切片` | 在线切片 Web 应用 |
| `/rec/语音识别` | Whisper 语音识别服务 |
| `/rec/cookies` | B 站 cookies (通过私有仓库下载) |
| `/rec/logs` | 脚本运行日志 |
| `/rec/config.conf` | **核心配置文件** |

---

## 快速开始


### docker-compose

```yaml
# docker-compose.yml
services:
  khx-live:
    image: xct258/khx-live
    container_name: khx-live
    network_mode: host
    environment:
      XCT258_GITHUB_TOKEN: ""
      Bililive_USER: "xct258"
      Bililive_PASS: "xct258"
    volumes:
      - ./data:/rec
    restart: always
```

首次启动后，编辑 `/rec/config.conf` 按需开启功能，然后重启容器。

### 访问服务

| 服务 | 地址 | 说明 |
|---|---|---|
| 录播姬管理界面 | `http://<host>:2356` | HTTP Basic 认证 |
| 在线切片 | `http://<host>:8186` | 需启用 `ENABLE_WEBCLIP=true` |
| 语音识别 | `http://<host>:8286` | 需启用 `ENABLE_OPENCC=true` |

---

## 配置参考

核心配置位于 `/rec/config.conf`，容器自动生成默认版本。主要配置项：

### 通用开关

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `ENABLE_UPLOAD_SCRIPT` | `true` | 启用视频上传备份流程 |
| `ENABLE_WEBCLIP` | `false` | 启用在线切片 (需重启) |
| `ENABLE_OPENCC` | `false` | 启用语音识别 (需重启) |
| `ENABLE_INTEL_GPU` | `false` | 安装 Intel 核显驱动 (需重启) |
| `WEBCLIP_PORT` | `8186` | 在线切片监听端口 |

### 视频处理与上传

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `source_folders` | `("/rec/biliup/video" "/rec/录播姬/video")` | 监控的录制源目录 |
| `update_servers` | `("录播姬")` | 需要处理的录制平台 |
| `ENABLE_DANMAKU_OVERLAY` | `false` | 启用弹幕压制 |
| `CONVERT_FLV_TO_MP4` | `false` | FLV→MP4 封装转换 |
| `MAX_DIFF_LIMIT` | `20` | 视频与弹幕允许的最大时间差(秒) |
| `ENABLE_VIDEO_UPLOAD` | `false` | 启用 B 站投稿 |
| `ENABLE_RCLONE_UPLOAD` | `false` | 启用 rclone 网盘备份 |
| `ENABLE_CLEANUP` | `false` | 启用自动清理旧视频 |
| `RETENTION_DAYS` | `3` | 视频保留天数 |
| `ENABLE_AUDIO_EXTRACT` | `false` | 提取视频音频 |
| `ENABLE_ASR_SUBMIT` | `false` | 提交音频到语音识别后端 |

完整配置项见 [`视频处理脚本/config.conf`](视频处理脚本/config.conf)。

---

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `XCT258_GITHUB_TOKEN` | 空 | GitHub 私有仓库 Token，用于下载 cookies、rclone 配置等敏感文件 |
| `Bililive_USER` | `xct258` | 录播姬 HTTP Basic 用户名 |
| `Bililive_PASS` | 随机生成 | 录播姬 HTTP Basic 密码 |

无 Token 时容器仍可正常运行，但需要自行配置 cookies 和 rclone。

---

## 功能详解

### 录播姬自动录制

容器启动后自动运行 `BililiveRecorder.Cli`，绑定 `:2356` 端口：

- 录制文件存放于 `/rec/录播姬`
- 支持自动更新录制配置（通过 `更新录播姬配置文件.py` 从 B 站 API 同步关注列表）
- 首次启动时自动创建默认录播姬配置文件
- 文件名格式：`录播姬_yyyy年MM月dd日HH点mm分_{标题}_{主播}.flv`

录制原画需要有效的 B 站 cookies，格式：
```
SESSDATA=xxx;DedeUserID=xxx;DedeUserID__ckMd5=xxx
```

### 视频处理与上传备份

自动监控录制目录的写入状态，检测到录制结束后自动执行处理流程：

1. **清理小视频** — 自动删除 `<10MB` 的视频片段及关联弹幕 XML
2. **FLV→MP4 转换** — 可选使用 ffmpeg copy 模式极速封装
3. **弹幕压制** — 时间差校验 → DanmakuFactory 转换 ASS → ffmpeg 叠加（支持 GPU 加速）
4. **B 站投稿** — 自动选择封面（弹幕密度最高时刻）、生成描述，调用 `biliup` 上传
5. **音频提取** — 提取原始视频音频（支持提交到外部语音识别服务）
6. **网盘备份** — 通过 `rclone` 自动选择剩余容量最大的 OneDrive 网盘进行备份
7. **自动清理** — 按自然日删除过期视频（带数量保护，默认最多删 8 个目录）
8. **自动更新 cookies** — 定期刷新 B 站 cookies

核心脚本：
- [`录播上传备份脚本.sh`](视频处理脚本/录播上传备份脚本.sh) — 主流程
- [`压制视频.py`](视频处理脚本/压制视频.py) — 弹幕压制 + 高能进度条
- [`视频信息获取.py`](视频处理脚本/视频信息获取.py) — 自动选取封面
- [`对比视频和弹幕的时长.sh`](视频处理脚本/对比视频和弹幕的时长.sh) — 时间差校验

### 在线切片 (可选)

基于 FastAPI 的 Web 应用，可在浏览器中预览 `/rec/videos` 下的视频并进行时间段裁剪。

启用方式：设置 `ENABLE_WEBCLIP=true`，重启容器，访问 `http://<host>:8186`。

功能：
- 目录树浏览视频文件
- 拖动选择时间范围进行裁剪切片
- 支持多视频合并输出
- 预览版/投稿版/原文件 三模式
- 字幕编辑（SRT/TXT）
- 合并队列管理 + 实时进度

### 语音识别 (可选)

基于 faster-whisper 的语音转写服务，支持 GPU 加速。

启用方式：
1. 下载语音识别模型放入 `/rec/语音识别/models/turbo/`
2. 设置 `ENABLE_OPENCC=true`，重启容器
3. 访问 `http://<host>:8286` 使用 Web 控制台

提交转写任务：
```sh
curl -X POST http://localhost:8286/submit_task \
  -H "Content-Type: application/json" \
  -d '{"audio_path": "/rec/videos/xxx.aac", "device": "auto"}'
```

---

## 构建与发布

GitHub Actions 工作流位于 `.github/workflows/main.yml`：

- 每月 1 日 UTC 00:00 自动触发构建
- 支持 `workflow_dispatch` 手动触发
- 多平台构建：`linux/amd64` + `linux/arm64`
- 镜像推送到 Docker Hub `xct258/khx-live:latest`

构建流程由 `Dockerfile` + `init-components.sh` 完成：
1. 安装系统依赖（ffmpeg、rclone、python3、字体等）
2. 下载录播姬、biliup、7zz、DanmakuFactory 等二进制
3. 下载所有处理脚本
4. 写入构建版本信息

---

## 常见问题

**录播姬无法启动？**
查看 `docker logs khx-live`，检查是否有权限或缺少 `BililiveRecorder.Cli`。

**视频文件未出现在 /rec？**
确认宿主机路径正确挂载且容器有写权限。

**在线切片访问失败？**
确认 `/rec/config.conf` 中 `ENABLE_WEBCLIP=true`，端口映射正确，服务文件存在。

**私有配置下载失败？**
检查 `XCT258_GITHUB_TOKEN` 是否有效，容器网络是否可访问 GitHub。

**投稿失败？**
检查 cookies 是否过期（运行 `/rec/脚本/自动更新cookie.sh`），日志文件位于 `/rec/logs`。

**如何查看处理日志？**
日志文件位于 `/rec/logs/`，按日期和脚本名称分文件记录，同时输出到 `/rec/备份脚本执行日志.log`。

---

## 参与开发

欢迎提交 PR：
- 新功能或脚本
- Bug 修复
- 文档改进

项目地址：<https://github.com/xct258/khx-live>
