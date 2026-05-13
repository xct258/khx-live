# 📦 Whisper 转写服务打包发布指南

本指南详细记录了如何将基于 `FastAPI` + `faster-whisper` 的 Python 项目打包为一个**脱离 Python 环境、自带 Web UI、且支持 GPU 加速**的独立绿色版软件。

## 一、 准备工作

在执行打包之前，请确保你的开发环境中已经安装了打包工具：
```bash
pip install pyinstaller
```
---

## 二、 核心打包命令

请在 `视频转文本-显卡加速.py` 所在的目录打开终端，清理掉旧的 `build` 和 `dist` 文件夹（如果有的话），然后完整复制并运行以下命令：

```bash
pyinstaller --name "WhisperService" --onedir --hidden-import="uvicorn.logging" --hidden-import="uvicorn.loops" --hidden-import="uvicorn.loops.auto" --hidden-import="uvicorn.protocols" --hidden-import="uvicorn.protocols.http" --hidden-import="uvicorn.protocols.http.auto" --hidden-import="uvicorn.protocols.websockets" --hidden-import="uvicorn.protocols.websockets.auto" --hidden-import="uvicorn.lifespan" --hidden-import="uvicorn.lifespan.on" --hidden-import="faster_whisper" 视频转文本-显卡加速.py
```

### 💡 参数原理解析：
*   `--name "WhisperService"`：指定生成的文件夹和可执行文件名称。
*   `--onedir`：打包成文件夹模式（而非单文件），保证程序秒开，不会因解压大文件导致卡死。
*   `--hidden-import="..."`：强制打包 Uvicorn 启动 Web 服务所需的底层动态组件，防止运行报错。
*   `--collect-data="..."`：**极其关键**。强制收集 `faster_whisper` 的 VAD 声音检测模型（`.onnx`）和 `opencc` 的简繁转换字典。不加此参数会导致运行时报 `File doesn't exist` 错误。

---

## 三、 手动依赖补全（物理补丁）

由于部分核心依赖（如显卡驱动库、底层音频处理工具）体积过于庞大或独立于 Python，PyInstaller 无法或不适合自动打包，**必须手动放入**打包生成的目录中。

打包完成后，进入生成的 `dist/WhisperService/` 文件夹，进行以下三步操作：

### 1. 放入前端网页界面
将 `index.html` 文件，直接复制并粘贴到 `WhisperService.exe` 旁边。

### 2. 注入 FFmpeg（音频切割核心）
*   获取 FFmpeg Windows 免安装版压缩包并解压。
*   在 `WhisperService.exe` 旁边新建一个名为 `ffmpeg` 的文件夹，在里面再建一个 `bin` 文件夹。
*   将 `ffmpeg.exe` 等文件放入其中。路径应为：`WhisperService/ffmpeg/bin/ffmpeg.exe`。

### 3. 注入 NVIDIA CUDA 加速库（GPU 核心）
*   打开你本地 Python 环境的 `Lib/site-packages` 目录。
*   找到 `nvidia` 这个文件夹。
*   复制整个 `nvidia` 文件夹，将其粘贴到打包产物的内部依赖库中：
    👉 `dist/WhisperService/_internal/nvidia/`

---

## 四、 最终发布目录结构标准

在将程序压缩发给别人之前，请核对你的 `WhisperService` 文件夹是否符合以下结构：

```text
WhisperService/
│
├── _internal/                  # PyInstaller 自动生成的核心运行库
│   ├── nvidia/                 # 👈 [手动加入] 庞大的 CUDA 加速库
│   ├── faster_whisper/         # 包含自动收集的 VAD 模型 (assets 文件夹)
│   ├── opencc/                 # 包含自动收集的字典文件
│   └── ... (其他 dll 和 pyd)
│
├── ffmpeg/                     # 👈 [手动加入] 音频处理工具
│   └── bin/
│       └── ffmpeg.exe
│
├── index.html                  # 👈 [手动加入] Web 可视化前端界面
│
└── WhisperService.exe          # 启动主程序
```

---

## 五、 分发与运行须知

当你把整理好的 `WhisperService` 文件夹打包发给同事或部署到新电脑上时，请注意以下事项：

1.  **开箱即用**：目标电脑**完全不需要**安装 Python、PyTorch 或配置任何环境变量。直接双击 `WhisperService.exe` 即可启动后台并访问 `127.0.0.1:8286`。
2.  **首次联网下载模型**：程序在**第一次**处理音频时，会从 HuggingFace 下载 `turbo` 语音模型（约 1.5GB）。请确保首次运行时电脑有网络。下载后模型会永久缓存在系统的 `~/.cache/huggingface/hub` 目录中，后续使用支持完全断网离线运行。
3.  **智能硬件降级**：如果目标电脑没有 NVIDIA 显卡（N 卡），或者没有安装显卡驱动，程序会自动捕捉异常，并在控制台打印提示，随后**平滑降级为纯 CPU 多核运算模式**，依然可以完成转录（只是速度较慢），不会直接崩溃。
4.  **伴随式输出**：转录生成的 `.txt`（附带专业数据面板）和 `.srt` 字幕文件，将直接生成在**用户拖入的原始音频文件的同一个目录下**，且与音频文件完全同名。
