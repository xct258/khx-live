# 📦 Whisper 转写服务打包发布指南

本指南详细记录了如何将基于 `FastAPI` + `faster-whisper` 的 Python 项目打包为一个**脱离 Python 环境、自带 Web UI、且支持 GPU 加速**的独立绿色版软件。

---

## 一、准备工作

确保开发环境中已安装打包工具：

```bash
pip install pyinstaller
```

项目文件清单：
- `视频转文本.py` — 主服务程序
- `index.html` — Web 控制台前端
- `models/turbo/` — 语音识别模型文件（需手动下载，见第三节）

---

## 二、核心打包命令

在 `视频转文本.py` 所在目录打开终端，清理旧的 `build` 和 `dist` 文件夹（如果有的话），然后执行：

```bash
pyinstaller --name "WhisperService" ^
    --onedir --clean --noconfirm ^
    --collect-all="uvicorn" ^
    --collect-all="faster_whisper" ^
    --collect-all="ctranslate2" ^
    --collect-all="opencc" ^
    --collect-all="nvidia" ^
    --copy-metadata="torch" ^
    --copy-metadata="tqdm" ^
    --add-data "index.html;." ^
    视频转文本.py
```

### 参数说明

| 参数 | 作用 |
|---|---|
| `--name "WhisperService"` | 指定输出文件夹和 exe 名称 |
| `--onedir` | 单目录模式（便于补充模型等大文件） |
| `--clean --noconfirm` | 清理旧构建，不询问直接覆盖 |
| `--collect-all="uvicorn"` | 收集 FastAPI 服务端全套依赖 |
| `--collect-all="faster_whisper"` | 收集语音识别引擎 |
| `--collect-all="ctranslate2"` | 收集推理加速库 |
| `--collect-all="opencc"` | 收集繁简转换库 |
| `--collect-all="nvidia"` | 收集 CUDA 运行时 DLL |
| `--copy-metadata="torch"` | 保留 torch 元数据（防止启动报错） |
| `--copy-metadata="tqdm"` | 保留 tqdm 元数据 |
| `--add-data "index.html;."` | 将前端页面打包到 exe 同级目录 |

---

## 三、下载语音识别模型

语音识别模型约 **1.5GB**，不适合打包进 exe。打包后需手动放置到发布目录。

### 方式一：Python 自动下载（推荐）

```bash
python -c "from faster_whisper import WhisperModel; WhisperModel('turbo', device='cpu', compute_type='int8')"
```
下载完成后将缓存目录中的模型文件复制出来：

```powershell
# 缓存位置（Windows）
$src = "$env:USERPROFILE\.cache\huggingface\hub\models--Systran--faster-whisper-turbo\snapshots\*\*"
Copy-Item $src "dist\WhisperService\models\turbo\" -Recurse
```

### 方式二：从 HuggingFace 直接下载

访问 [Systran/faster-whisper-turbo](https://huggingface.co/Systran/faster-whisper-turbo)，下载以下文件放入 `models/turbo/`：

```
config.json
model.bin
preprocessor_config.json
tokenizer.json
vocabulary.json
```

---

## 四、最终发布目录结构

```text
WhisperService/
│
├── WhisperService.exe          # 启动主程序
├── index.html                  # Web 前端（由 --add-data 打包）
│
├── _internal/                  # PyInstaller 自动生成的核心运行库
│
└── models/
    └── turbo/                  # 语音识别模型（手动放置）
        ├── config.json
        ├── model.bin
        ├── preprocessor_config.json
        ├── tokenizer.json
        └── vocabulary.json
```

---

## 五、分发与运行须知

将整理好的 `WhisperService` 文件夹打包发给同事或部署到新电脑时，请注意以下事项：

1. **开箱即用**：目标电脑**完全不需要**安装 Python、PyTorch 或配置任何环境变量。直接双击 `WhisperService.exe` 即可启动服务，打开浏览器访问 `http://localhost:8286` 使用 Web 控制台。

2. **模型需完整**：确保 `models/turbo/` 目录完整。程序启动时会检测模型是否存在，缺失时会打印错误信息。

3. **智能硬件降级**：如果目标电脑没有 NVIDIA 显卡或未安装显卡驱动，程序会自动检测并**平滑降级为纯 CPU 模式**，依然可以完成转录（速度较慢），不会崩溃。

4. **伴随式输出**：转写生成的 `.txt`（带时间戳和报告面板）和 `.srt` 字幕文件，直接生成在**输入的音频文件同目录下**，文件名与音频相同。

5. **GPU 加速要求**：
   - NVIDIA 显卡，计算能力 5.2+
   - 安装显卡驱动（建议 550+ 版本）
   - 显存建议 4GB+

---

## 六、API 接口

### 提交转写任务
```bash
curl -X POST http://localhost:8286/submit_task \
  -H "Content-Type: application/json" \
  -d '{"audio_path": "C:/path/to/audio.mp4", "device": "auto"}'
```

### 其他接口
| 接口 | 说明 |
|---|---|
| `GET /task_status/{id}` | 查看任务状态 |
| `GET /queue_status` | 查看队列 |
| `GET /task_history` | 查看历史记录 |
| `POST /stop_task/{id}` | 取消任务 |
| `GET /task_file/{id}` | 查看输出文件 |
| `GET /status` | 服务状态 |

---

## 七、核心参数

如需修改参数，编辑 `视频转文本.py` 中的以下变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SERVER_HOST` | `0.0.0.0` | 监听地址 |
| `SERVER_PORT` | `8286` | 监听端口 |
| `GPU_COMPUTE_TYPE` | `float16` | GPU 计算精度 |
| `CPU_COMPUTE_TYPE` | `int8` | CPU 计算精度 |
| `MAX_GAP` | `1.0s` | 词间间隔超此值则分段 |
| `MAX_SEGMENT_DURATION` | `12.0s` | 单段最大时长 |

### 转写参数（`TRANSRIBE_PARAMS`）

| 键 | 当前值 | 说明 |
|---|---|---|
| `vad_filter` | `true` | 启用 VAD 过滤静音 |
| `vad_parameters.min_speech_duration_ms` | `350` | 最短语音片段 |
| `vad_parameters.min_silence_duration_ms` | `500` | 最短静音分段 |

未设置的参数（`beam_size`, `best_of`, `temperature` 等）全部使用 faster-whisper 原生默认值。
