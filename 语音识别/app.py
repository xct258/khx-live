import os
import sys
import time
import uuid
import json
import re
import threading
import queue
import ctypes
from contextlib import asynccontextmanager
import opencc

# ================= 1. 环境与路径修复 =================
def get_base_path():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    else:
        return os.path.dirname(os.path.abspath(__file__))

def get_resource_path(relative_path):
    """在打包后的 exe 同级 或 _internal 中查找资源文件"""
    if getattr(sys, 'frozen', False):
        base = os.path.dirname(sys.executable)
        path = os.path.join(base, relative_path)
        if os.path.exists(path):
            return path
        path = os.path.join(base, "_internal", relative_path)
        if os.path.exists(path):
            return path
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), relative_path)

BASE_DIR = get_base_path()

MODEL_NAME = "large-v3-turbo"
MODEL_PATH = os.path.join(BASE_DIR, "models", MODEL_NAME)
GPU_COMPUTE_TYPE = "float16"
CPU_COMPUTE_TYPE = "int8"
LANGUAGE = "zh"
TASK = "transcribe"
OPENCC_MODE = "t2s"
DB_PATH = os.path.join(BASE_DIR, "whisper_tasks_db.json")
LOG_PATH = os.path.join(BASE_DIR, "whisper_history.log")
SERVER_HOST = "0.0.0.0"
SERVER_PORT = 8286

TRANSRIBE_PARAMS = {
    "beam_size": 3,
    "word_timestamps": True,
    "condition_on_previous_text": False,
    "vad_filter": True,
    "vad_parameters": {"min_speech_duration_ms": 100, "min_silence_duration_ms": 500, "threshold": 0.35, "speech_pad_ms": 500},
}

SENTENCE_END_PATTERN = re.compile(r".+?(?:[。！？!?；;\.]+|$)", re.S)
ALIGN_IGNORE_PATTERN = re.compile(r"[\s，,、。！？!?；;\.:：\"'“”‘’（）()\[\]【】《》<>…]+")
OUTPUT_PUNCTUATION_PATTERN = re.compile(r"[，,、。！？!?；;\.:：\"'“”‘’（）()\[\]【】《》<>…—-]+")
MERGE_SHORT_GAP = 0.15
MIN_SEGMENT_DURATION = 0.10
MAX_FIRST_SECOND_GAP = 0.80

def add_dll_path(path):
    try:
        os.add_dll_directory(path)
    except Exception:
        pass
    try:
        os.environ["PATH"] = path + os.pathsep + os.environ["PATH"]
    except Exception:
        pass

def setup_env():
    if getattr(sys, 'frozen', False):
        nvidia_base = os.path.join(BASE_DIR, "_internal", "nvidia")
        torch_lib = os.path.join(BASE_DIR, "_internal", "torch", "lib")
    else:
        nvidia_base = os.path.join(sys.prefix, "Lib", "site-packages", "nvidia")
        torch_lib = os.path.join(sys.prefix, "Lib", "site-packages", "torch", "lib")

    if os.path.exists(nvidia_base):
        for root, dirs, files in os.walk(nvidia_base):
            if "bin" in dirs:
                add_dll_path(os.path.normpath(os.path.join(root, "bin")))

    if os.path.exists(torch_lib):
        add_dll_path(torch_lib)

setup_env()

# ================= 2. Torch 相关导入（必须在 setup_env 之后，确保 DLL 路径已设置） =================
import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
from faster_whisper import WhisperModel


# ================= 3. 全局变量与配置 =================
models = {}
converter = opencc.OpenCC(OPENCC_MODE)
tasks_db = {}
task_queue = queue.Queue()
cuda_available = False
runtime_info = {"device": "", "compute_type": ""}

def save_db():
    data = {}
    for tid, tinfo in tasks_db.items():
        data[tid] = tinfo
    with open(DB_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def load_db():
    global tasks_db
    if not os.path.exists(DB_PATH):
        tasks_db = {}
        return
    try:
        with open(DB_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        tasks_db = {}
        for tid, tinfo in data.items():
            tasks_db[tid] = tinfo
        print(f"[*] 已恢复 {len(tasks_db)} 条历史记录")
    except Exception as e:
        print(f"[!] 恢复历史记录失败: {e}")
        tasks_db = {}


# ================= 4. 数据模型与工具函数 =================
class AudioRequest(BaseModel):
    audio_path: str
    device: str = "auto"

def format_srt_timestamp(seconds: float):
    total_cs = max(0, int(round(seconds * 100)))
    seconds, centiseconds = divmod(total_cs, 100)
    return f"{time.strftime('%H:%M:%S', time.gmtime(seconds))},{centiseconds:02d}"

def format_timestamp(seconds: float):
    return time.strftime('%H:%M:%S', time.gmtime(seconds))

def normalize_text_for_alignment(text):
    return ALIGN_IGNORE_PATTERN.sub("", text or "")

def clean_output_text(text):
    return OUTPUT_PUNCTUATION_PATTERN.sub("", text or "").strip()

def split_sentences(text):
    sentences = []
    for match in SENTENCE_END_PATTERN.finditer(text.strip()):
        sentence = match.group().strip()
        if sentence:
            sentences.append(sentence)
    return sentences

def get_word_items(segment):
    items = []
    for word in getattr(segment, "words", None) or []:
        word_text = getattr(word, "word", "")
        word_start = getattr(word, "start", None)
        word_end = getattr(word, "end", None)
        if word_text and word_start is not None and word_end is not None:
            items.append({"text": word_text, "start": float(word_start), "end": float(word_end)})
    return items

def refine_sentence_start_by_word_gap(sentence_words, fallback_start):
    if len(sentence_words) >= 2:
        first = sentence_words[0]
        second = sentence_words[1]
        if second["start"] - first["start"] > MAX_FIRST_SECOND_GAP:
            return second["start"]
    return fallback_start

def estimate_sentence_time(segment, sentence_index, sentence_count, sentence_lengths, sentence_text):
    total_length = max(sum(sentence_lengths), 1)
    elapsed_length = sum(sentence_lengths[:sentence_index])
    duration = max(float(segment.end) - float(segment.start), 0.01)
    start = float(segment.start) + duration * elapsed_length / total_length
    end = float(segment.start) + duration * (elapsed_length + max(len(normalize_text_for_alignment(sentence_text)), 1)) / total_length
    if sentence_index == sentence_count - 1:
        end = float(segment.end)
    return round(start, 2), round(max(end, start + 0.01), 2)

def segment_to_sentence_items(segment):
    source_text = segment.text.strip()
    if not source_text:
        return []

    sentences = split_sentences(source_text)
    if not sentences:
        sentences = [source_text]

    word_items = get_word_items(segment)
    sentence_lengths = [max(len(normalize_text_for_alignment(sentence)), 1) for sentence in sentences]
    sentence_segments = []
    word_index = 0

    for sentence_index, sentence in enumerate(sentences):
        target_length = sentence_lengths[sentence_index]
        start = None
        end = None
        collected_length = 0
        sentence_words = []

        while word_index < len(word_items) and collected_length < target_length:
            word = word_items[word_index]
            word_length = len(normalize_text_for_alignment(word["text"]))
            if word_length == 0:
                word_index += 1
                continue
            if start is None:
                start = word["start"]
            end = word["end"]
            sentence_words.append(word)
            collected_length += word_length
            word_index += 1

        if start is None or end is None:
            start, end = estimate_sentence_time(segment, sentence_index, len(sentences), sentence_lengths, sentence)
        else:
            start = refine_sentence_start_by_word_gap(sentence_words, start)

        text = clean_output_text(converter.convert(sentence.strip()))
        if text:
            sentence_segments.append({"start": round(start, 2), "end": round(end, 2), "text": text})

    return sentence_segments

def normalize_segments(segments):
    cleaned = []
    for seg in segments:
        start = round(float(seg["start"]), 2)
        end = round(float(seg["end"]), 2)
        if cleaned:
            prev = cleaned[-1]
            if start - prev["end"] <= MERGE_SHORT_GAP:
                prev["end"] = round(max(prev["end"], end), 2)
                prev["text"] = merge_text(prev["text"], seg["text"])
                continue
        if end - start >= MIN_SEGMENT_DURATION:
            cleaned.append({"start": start, "end": end, "text": seg["text"]})
    return cleaned

def merge_text(left, right):
    if not left:
        return right
    if not right:
        return left
    if re.search(r"[A-Za-z0-9]$", left) and re.search(r"^[A-Za-z0-9]", right):
        return left + " " + right
    return left + right

def write_txt_file(txt_path, segments):
    with open(txt_path, "w", encoding="utf-8") as f:
        for item in segments:
            f.write(f"[{format_srt_timestamp(item['start'])} --> {format_srt_timestamp(item['end'])}] {item['text']}\n")

def write_srt_file(srt_path, segments):
    with open(srt_path, "w", encoding="utf-8") as f:
        for index, item in enumerate(segments, start=1):
            f.write(f"{index}\n")
            f.write(f"{format_srt_timestamp(item['start'])} --> {format_srt_timestamp(item['end'])}\n")
            f.write(item["text"] + "\n\n")

def write_log(task_id, task_info):
    log_path = LOG_PATH
    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
    status = task_info.get("status")
    filename = task_info.get("filename")
    
    log_msg = f"[{timestamp}] 文件: {filename} | 状态: {status}"
    if status == "done":
        log_msg += f" | 耗时: {task_info['result']['time_cost']}s"
    elif status == "error":
        log_msg += f" | 报错: {task_info.get('error_msg')}"
        
    with open(log_path, "a", encoding="utf-8") as f:
        f.write(log_msg + "\n")


# ================= 5. 核心队列消费者 (后台线程) =================
def load_model(device):
    key = f"model_{device}"
    if key not in models:
        if not os.path.exists(MODEL_PATH):
            return None
        compute = GPU_COMPUTE_TYPE if device == "cuda" else CPU_COMPUTE_TYPE
        print(f"[*] 加载模型 ({device}/{compute})...")
        models[key] = WhisperModel(MODEL_PATH, device=device, compute_type=compute)
    return models[key]

def main_worker():
    while True:
        task_id = task_queue.get()

        task_info = tasks_db[task_id]
        requested = task_info.get("requested_device", "auto")
        if requested == "auto":
            requested = "cuda" if cuda_available else "cpu"

        model = load_model(requested)
        if model is None:
            tasks_db[task_id]["status"] = "error"
            tasks_db[task_id]["error_msg"] = "模型未加载，请确认 models/turbo 目录存在"
            write_log(task_id, tasks_db[task_id])
            save_db()
            task_queue.task_done()
            continue

        if tasks_db[task_id].get("status") == "cancelled":
            write_log(task_id, tasks_db[task_id])
            save_db()
            continue

        tasks_db[task_id]["status"] = "running"
        save_db()
        audio_path = tasks_db[task_id]["audio_path"]
        start_time = time.time()
        print(f"[*] 开始处理任务: {tasks_db[task_id]['filename']} (ID: {task_id}) [设备: {requested}]")

        tasks_db[task_id]["actual_device"] = requested

        try:
            segments, info = model.transcribe(
                audio_path, language=LANGUAGE, task=TASK,
                **TRANSRIBE_PARAMS,
            )

            audio_duration = getattr(info, "duration", 0)
            tasks_db[task_id]["audio_duration"] = int(audio_duration) if audio_duration else None

            for segment in segments:
                if tasks_db[task_id].get("status") == "cancelled":
                    break
                tasks_db[task_id]["segments"].extend(segment_to_sentence_items(segment))
                tasks_db[task_id]["segments"] = normalize_segments(tasks_db[task_id]["segments"])
                save_db()

            tasks_db[task_id]["segments"] = normalize_segments(tasks_db[task_id]["segments"])

            if tasks_db[task_id].get("status") == "cancelled":
                print(f"[-] 任务 {task_id} 已终止，准备接管下一个任务...")
                write_log(task_id, tasks_db[task_id])
                save_db()
                continue

            # --- 文件生成 ---
            duration = time.time() - start_time
            audio_dir = os.path.dirname(os.path.abspath(audio_path))
            original_filename = os.path.splitext(os.path.basename(audio_path))[0]
            txt_path = os.path.join(audio_dir, f"{original_filename}.txt")
            srt_path = os.path.join(audio_dir, f"{original_filename}.srt")

            write_txt_file(txt_path, tasks_db[task_id]["segments"])
            write_srt_file(srt_path, tasks_db[task_id]["segments"])

            tasks_db[task_id]["status"] = "done"
            tasks_db[task_id]["result"] = {"time_cost": round(duration, 2), "txt_file": txt_path, "srt_file": srt_path}
            
            write_log(task_id, tasks_db[task_id]) # 记录成功完成日志
            save_db()
            print(f"[+] 任务完成: {tasks_db[task_id]['filename']}，耗时: {duration:.2f} 秒")

        except Exception as e:
            tasks_db[task_id]["status"] = "error"
            tasks_db[task_id]["error_msg"] = str(e)
            write_log(task_id, tasks_db[task_id]) # 记录报错日志
            save_db()
            print(f"[x] 任务异常失败: {str(e)}")
        finally:
            task_queue.task_done()


# ================= 6. App 生命周期管理 =================
@asynccontextmanager
async def lifespan(app: FastAPI):
    global models, runtime_info, cuda_available
    load_db()
    for tid in list(tasks_db.keys()):
        if tasks_db[tid].get("status") in ("queued", "running"):
            tasks_db[tid]["status"] = "cancelled"
    save_db()

    def detect_cuda():
        try:
            if getattr(sys, 'frozen', False):
                torch_lib = os.path.join(BASE_DIR, "_internal", "torch", "lib")
            else:
                torch_lib = os.path.join(sys.prefix, "Lib", "site-packages", "torch", "lib")
            if os.path.exists(torch_lib):
                for f in os.listdir(torch_lib):
                    if f.endswith(".dll") and any(x in f.lower() for x in ["cuda", "cublas", "cudnn", "nvrtc", "nvjit"]):
                        try:
                            ctypes.CDLL(os.path.join(torch_lib, f))
                        except Exception:
                            pass
            os.environ.setdefault("CUDA_MODULE_LOADING", "LAZY")
            nv = ctypes.windll.LoadLibrary("nvcuda.dll")
            nv.cuInit(0)
            count = ctypes.c_int()
            nv.cuDeviceGetCount(ctypes.byref(count))
            if count.value > 0:
                name_buf = ctypes.create_string_buffer(256)
                nv.cuDeviceGetName(name_buf, 256, 0)
                return True, name_buf.value.decode()
            return False, "未检测到 CUDA 设备"
        except Exception as e:
            return False, str(e)

    use_gpu, gpu_info = detect_cuda()
    cuda_available = use_gpu
    if cuda_available:
        print(f"[*] GPU 加速可用: {gpu_info}")
    else:
        print(f"[*] GPU 加速不可用: {gpu_info}")

    dev = "cuda" if cuda_available else "cpu"
    compute = GPU_COMPUTE_TYPE if cuda_available else CPU_COMPUTE_TYPE
    runtime_info = {"device": dev, "compute_type": compute}

    if os.path.exists(MODEL_PATH):
        print(f"[*] 预加载模型 ({dev}/{compute})...")
        models[f"model_{dev}"] = WhisperModel(MODEL_PATH, device=dev, compute_type=compute)
    else:
        print(f"[!] 未找到模型文件夹: {MODEL_PATH}")
    
    threading.Thread(target=main_worker, daemon=True).start()
    yield  

app = FastAPI(title="Whisper 公共队列服务", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


# ================= 7. API 接口路由 =================
@app.get("/", response_class=HTMLResponse)
async def serve_frontend():
    html_path = get_resource_path("index.html")
    if html_path and os.path.exists(html_path):
        with open(html_path, "r", encoding="utf-8") as f:
            return f.read()
    return "<h1>请将 index.html 放在 exe 同级目录下</h1>"

@app.get("/help", response_class=HTMLResponse)
async def help_page():
    return """
    <!DOCTYPE html><html><body style="background:#0f172a;color:#e2e8f0;font-family:monospace;padding:2rem">
    <h2>WhisperService 使用说明</h2>
    <hr>
    <h3>提交转写任务</h3>
    <pre>curl -X POST http://0.0.0.0:8286/submit_task \\
      -H "Content-Type: application/json" \\
      -d '{"audio_path": "C:/path/to/audio.mp4", "device": "auto"}'</pre>
    <p><b>device</b> 参数：<code>auto</code>（默认，有GPU则GPU）/ <code>cuda</code>（强制GPU）/ <code>cpu</code>（强制CPU）</p>
    <h3>查看任务状态</h3>
    <pre>curl http://0.0.0.0:8286/task_status/{task_id}</pre>
    <h3>查看队列</h3>
    <pre>curl http://0.0.0.0:8286/queue_status</pre>
    <h3>取消任务</h3>
    <pre>curl -X POST http://0.0.0.0:8286/stop_task/{task_id}</pre>
    <h3>查看历史记录</h3>
    <pre>curl http://0.0.0.0:8286/task_history</pre>
    <h3>服务状态</h3>
    <pre>curl http://0.0.0.0:8286/status</pre>
    <hr><p>前端面板: <a href="/" style="color:#60a5fa">/</a></p>
    </body></html>
    """

@app.get("/status")
async def get_service_status():
    return {
        "model_loaded": len(models) > 0,
        "device": runtime_info.get("device", ""),
        "compute_type": runtime_info.get("compute_type", ""),
        "queue_size": task_queue.qsize(),
        "cuda_available": cuda_available
    }

@app.post("/submit_task")
async def submit_task(request: AudioRequest):
    if len(models) == 0:
        raise HTTPException(status_code=503, detail="模型未加载，请确认 models/turbo 目录存在后重启服务")
    audio_path = request.audio_path.strip().strip('"')
    if not os.path.exists(audio_path):
        raise HTTPException(status_code=404, detail="未找到音频文件")

    task_device = request.device.strip().lower() if request.device else "auto"
    if task_device not in ("auto", "cuda", "cpu"):
        raise HTTPException(status_code=400, detail="device 必须是 auto / cuda / cpu")
    task_id = str(uuid.uuid4())
    tasks_db[task_id] = {
        "status": "queued", "segments": [],
        "audio_path": audio_path, "filename": os.path.basename(audio_path),
        "created_at": time.time(), "requested_device": task_device
    }
    save_db()
    task_queue.put(task_id)
    return {"task_id": task_id, "message": "任务已加入队列"}

@app.get("/task_status/{task_id}")
async def get_task_status(task_id: str):
    if task_id not in tasks_db:
        raise HTTPException(status_code=404, detail="任务不存在或已失效")
    task_info = dict(tasks_db[task_id])
    task_info["segments"] = normalize_segments(task_info.get("segments", []))
    return task_info

@app.get("/queue_status")
async def get_queue_status():
    queue_list = []
    for tid, tinfo in tasks_db.items():
        if tinfo["status"] in ["queued", "running"]:
            queue_list.append({"task_id": tid, "filename": tinfo["filename"], "status": tinfo["status"], "created_at": tinfo["created_at"], "audio_duration": tinfo.get("audio_duration")})
    queue_list.sort(key=lambda x: x["created_at"])
    return {"queue": queue_list}

# 【新增】获取历史记录接口
@app.get("/task_history")
async def get_task_history():
    history_list = []
    for tid, tinfo in tasks_db.items():
        if tinfo["status"] in ["done", "cancelled", "error"]:
            history_list.append({
                "task_id": tid,
                "filename": tinfo["filename"],
                "status": tinfo["status"],
                "created_at": tinfo["created_at"],
                "time_cost": tinfo.get("result", {}).get("time_cost", "-") if tinfo["status"] == "done" else "-",
                "txt_file": tinfo.get("result", {}).get("txt_file", "") if tinfo["status"] == "done" else ""
            })
    # 按创建时间倒序排列（最新的在最上面），只返回最近 50 条防止页面卡顿
    history_list.sort(key=lambda x: x["created_at"], reverse=True)
    return {"history": history_list[:50]}

@app.get("/task_file/{task_id}")
async def get_task_file(task_id: str):
    if task_id not in tasks_db or tasks_db[task_id]["status"] != "done":
        raise HTTPException(status_code=404, detail="任务不存在或无输出文件")
    txt_path = tasks_db[task_id].get("result", {}).get("txt_file", "")
    if not txt_path or not os.path.exists(txt_path):
        raise HTTPException(status_code=404, detail="输出文件不存在")
    with open(txt_path, "r", encoding="utf-8") as f:
        content = f.read()
    return {"filename": os.path.basename(txt_path), "content": content}

@app.post("/stop_task/{task_id}")
async def stop_task(task_id: str):
    if task_id in tasks_db and tasks_db[task_id]["status"] in ["queued", "running"]:
        tasks_db[task_id]["status"] = "cancelled"
        save_db()
        return {"message": f"任务 {task_id} 已取消"}
    return {"message": "任务不可取消或不存在"}

if __name__ == "__main__":
    # 定义自定义日志配置：只显示 WARNING 及以上级别的日志，屏蔽所有 INFO 级别（包括访问日志）
    log_config = {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {
            "default": {
                "()": "uvicorn.logging.DefaultFormatter",
                "fmt": "%(levelprefix)s %(message)s",
                "use_colors": None,
            },
        },
        "handlers": {
            "default": {
                "formatter": "default",
                "class": "logging.StreamHandler",
                "stream": "ext://sys.stderr",
            },
        },
        "loggers": {
            "uvicorn": {"handlers": ["default"], "level": "WARNING"},
            "uvicorn.error": {"level": "WARNING"},
            "uvicorn.access": {"handlers": ["default"], "level": "WARNING", "propagate": False},
        },
    }

    html_exists = os.path.exists(get_resource_path("index.html"))
    print(f"[*] 服务启动: http://{SERVER_HOST}:{SERVER_PORT}")
    print(f"[*] 前端面板: {'已启用' if html_exists else '未找到 index.html'}, http://localhost:{SERVER_PORT}")
    print(f"[*] 模型: {MODEL_NAME}")
    params_str = ", ".join(f"{k}={v}" for k, v in TRANSRIBE_PARAMS.items())
    print(f"[*] 转写参数: {params_str}")
    print(f"[*] 提交任务: curl -X POST http://0.0.0.0:8286/submit_task -H \"Content-Type: application/json\" -d '{{\"audio_path\": \"C:/path/to/file\", \"device\": \"auto\"}}'")
    print(f"[*] device: auto(默认) / cuda(仅GPU) / cpu(强制CPU)")
    uvicorn.run(app, host=SERVER_HOST, port=SERVER_PORT, log_config=log_config)
