import os
import sys
import time
import uuid
import json
import threading
import queue
from contextlib import asynccontextmanager
import torch
import opencc
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
from faster_whisper import WhisperModel

# ================= 1. 环境与路径修复 =================
def get_base_path():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    else:
        return os.path.dirname(os.path.abspath(__file__))

BASE_DIR = get_base_path()

def setup_env():
    if getattr(sys, 'frozen', False):
        nvidia_base = os.path.join(BASE_DIR, "_internal", "nvidia")
    else:
        nvidia_base = os.path.join(sys.prefix, "Lib", "site-packages", "nvidia")

    if os.path.exists(nvidia_base):
        for root, dirs, files in os.walk(nvidia_base):
            if "bin" in dirs:
                bin_path = os.path.normpath(os.path.join(root, "bin"))
                try:
                    os.add_dll_directory(bin_path)
                    os.environ["PATH"] = bin_path + os.pathsep + os.environ["PATH"]
                except Exception:
                    pass

setup_env()


# ================= 2. 全局变量与配置 =================
global_model = None
converter = opencc.OpenCC('t2s')
tasks_db = {}
task_queue = queue.Queue()
runtime_info = {"model_path": "", "device": "", "compute_type": ""}
DB_PATH = os.path.join(BASE_DIR, "whisper_tasks_db.json")

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


# ================= 3. 数据模型与工具函数 =================
class AudioRequest(BaseModel):
    audio_path: str

def format_srt_timestamp(seconds: float):
    milliseconds = int((seconds - int(seconds)) * 1000)
    return f"{time.strftime('%H:%M:%S', time.gmtime(seconds))},{milliseconds:03d}"

def format_timestamp(seconds: float):
    return time.strftime('%H:%M:%S', time.gmtime(seconds))

# 【新增】本地持久化日志写入函数
def write_log(task_id, task_info):
    log_path = os.path.join(BASE_DIR, "whisper_history.log")
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


# ================= 4. 核心队列消费者 (后台线程) =================
def main_worker():
    global global_model
    while True:
        task_id = task_queue.get()
        
        # 1. 检查是否在排队期间就被取消了
        if tasks_db[task_id].get("status") == "cancelled":
            write_log(task_id, tasks_db[task_id]) # 记录取消日志
            save_db()
            continue

        tasks_db[task_id]["status"] = "running"
        save_db()
        audio_path = tasks_db[task_id]["audio_path"]
        start_time = time.time()
        print(f"[*] 开始处理任务: {tasks_db[task_id]['filename']} (ID: {task_id})")
        
        try:
            segments, info = global_model.transcribe(
                audio_path, language="zh", task="transcribe", word_timestamps=True,
                beam_size=10, best_of=5, condition_on_previous_text=False,
                compression_ratio_threshold=2.2, log_prob_threshold=-1.0,
                no_speech_threshold=0.6, temperature=[0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
                vad_filter=True, vad_parameters=dict(threshold=0.5, min_speech_duration_ms=250, min_silence_duration_ms=500),
                initial_prompt="以下是普通话录音，请使用简体中文，并加入适当的标点符号。"
            )

            MAX_GAP, MAX_SENTENCE_DURATION = 0.5, 8.0

            for segment in segments:
                if tasks_db[task_id].get("status") == "cancelled":
                    break

                if not segment.words:
                    continue

                current_words = []
                for word in segment.words:
                    word_text = converter.convert(word.word.strip())
                    if not word_text: continue

                    if not current_words:
                        current_words.append(word)
                    else:
                        gap = word.start - current_words[-1].end
                        duration_so_far = word.start - current_words[0].start

                        if gap > MAX_GAP or duration_so_far > MAX_SENTENCE_DURATION:
                            full_text = "".join([converter.convert(w.word.strip()) for w in current_words])
                            tasks_db[task_id]["segments"].append({'start': current_words[0].start, 'end': current_words[-1].end, 'text': full_text})
                            current_words = [word]
                        else:
                            current_words.append(word)

                if current_words:
                    full_text = "".join([converter.convert(w.word.strip()) for w in current_words])
                    tasks_db[task_id]["segments"].append({'start': current_words[0].start, 'end': current_words[-1].end, 'text': full_text})

            if tasks_db[task_id].get("status") == "cancelled":
                print(f"[-] 任务 {task_id} 已终止，准备接管下一个任务...")
                write_log(task_id, tasks_db[task_id]) # 记录中途取消日志
                save_db()
                continue

            # --- 文件生成 ---
            duration = time.time() - start_time
            completion_time = time.strftime('%Y-%m-%d %H:%M:%S')
            audio_dir = os.path.dirname(os.path.abspath(audio_path))
            original_filename = os.path.splitext(os.path.basename(audio_path))[0]
            txt_path = os.path.join(audio_dir, f"{original_filename}.txt")
            srt_path = os.path.join(audio_dir, f"{original_filename}.srt")

            # 计算音频时长（从 info 获取）
            audio_duration = getattr(info, "duration", 0)
            audio_duration_str = f"{int(audio_duration // 60)}分{audio_duration % 60:.1f}秒" if audio_duration else "未知"

            with open(txt_path, "w", encoding="utf-8") as f:
                f.write("=" * 56 + "\n")
                f.write("  Whisper 语音转写结果报告\n")
                f.write("=" * 56 + "\n\n")
                f.write(f"  源文件:          {os.path.abspath(audio_path)}\n")
                f.write(f"  文件名:          {os.path.basename(audio_path)}\n")
                f.write(f"  音频时长:        {audio_duration_str}\n")
                f.write(f"  识别语种:        {getattr(info, 'language', 'zh')}\n")
                f.write(f"  处理完成:        {completion_time}\n")
                f.write(f"  总耗时:          {duration:.2f} 秒\n")
                f.write(f"  识别引擎:        faster-whisper ({runtime_info['model_path']})\n")
                f.write(f"  运行设备:        {runtime_info['device']} ({runtime_info['compute_type']})\n")
                f.write(f"  输出 TXT:        {txt_path}\n")
                f.write(f"  输出 SRT:        {srt_path}\n")
                f.write(f"  识别参数:        语言=zh, beam_size=10, best_of=5, VAD=是\n\n")
                f.write("-" * 56 + "\n")
                f.write("  转写内容\n")
                f.write("-" * 56 + "\n\n")
                for item in tasks_db[task_id]["segments"]:
                    f.write(f"[{format_srt_timestamp(item['start'])} --> {format_srt_timestamp(item['end'])}] {item['text']}\n")

            with open(srt_path, "w", encoding="utf-8") as f:
                for i, item in enumerate(tasks_db[task_id]["segments"], 1):
                    f.write(f"{i}\n{format_srt_timestamp(item['start'])} --> {format_srt_timestamp(item['end'])}\n{item['text']}\n\n")

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


# ================= 5. App 生命周期管理 =================
@asynccontextmanager
async def lifespan(app: FastAPI):
    global global_model, runtime_info
    load_db()
    # 将上次未完成的任务标记为已取消
    for tid in list(tasks_db.keys()):
        if tasks_db[tid].get("status") in ("queued", "running"):
            tasks_db[tid]["status"] = "cancelled"
    save_db()
    local_model_path = os.path.join(BASE_DIR, "models", "turbo")
    if not os.path.exists(local_model_path):
        raise FileNotFoundError(f"严格离线模式：未找到本地模型文件夹 {local_model_path}")

    use_gpu = torch.cuda.is_available()
    device, compute_type = ("cuda", "float16") if use_gpu else ("cpu", "int8")
    runtime_info = {"model_path": local_model_path, "device": device, "compute_type": compute_type}
    print(f"[*] 加载 Whisper 模型 [设备: {device} | 精度: {compute_type}]...")
    global_model = WhisperModel(local_model_path, device=device, compute_type=compute_type)
    
    threading.Thread(target=main_worker, daemon=True).start()
    yield  

app = FastAPI(title="Whisper 公共队列服务", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


# ================= 6. API 接口路由 =================
@app.get("/", response_class=HTMLResponse)
async def serve_frontend():
    html_path = os.path.join(BASE_DIR, "index.html")
    if os.path.exists(html_path):
        with open(html_path, "r", encoding="utf-8") as f:
            return f.read()
    return "<h1>请将 index.html 放在 Python 脚本同级目录下</h1>"

@app.post("/submit_task")
async def submit_task(request: AudioRequest):
    audio_path = request.audio_path.strip().strip('"')
    if not os.path.exists(audio_path):
        raise HTTPException(status_code=404, detail="未找到音频文件")

    task_id = str(uuid.uuid4())
    tasks_db[task_id] = {
        "status": "queued", "segments": [],
        "audio_path": audio_path, "filename": os.path.basename(audio_path),
        "created_at": time.time()
    }
    save_db()
    task_queue.put(task_id)
    return {"task_id": task_id, "message": "任务已加入队列"}

@app.get("/task_status/{task_id}")
async def get_task_status(task_id: str):
    if task_id not in tasks_db:
        raise HTTPException(status_code=404, detail="任务不存在或已失效")
    return tasks_db[task_id]

@app.get("/queue_status")
async def get_queue_status():
    queue_list = []
    for tid, tinfo in tasks_db.items():
        if tinfo["status"] in ["queued", "running"]:
            queue_list.append({"task_id": tid, "filename": tinfo["filename"], "status": tinfo["status"], "created_at": tinfo["created_at"]})
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

    uvicorn.run(app, host="0.0.0.0", port=8286, log_config=log_config)
