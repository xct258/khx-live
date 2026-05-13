import os
import sys
import time
import uuid
import threading
import torch
import opencc
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
from faster_whisper import WhisperModel

# --- 【新增】获取真实运行路径的函数 ---
def get_base_path():
    """判断是否被 PyInstaller 打包，获取正确的根目录"""
    if getattr(sys, 'frozen', False):
        # 如果是打包后的 exe 运行环境
        return os.path.dirname(sys.executable)
    else:
        # 如果是直接运行 py 脚本
        return os.path.dirname(os.path.abspath(__file__))

BASE_DIR = get_base_path()

# --- 1. 环境修复 ---
def setup_env():
    # 修复 CUDA 路径
    if getattr(sys, 'frozen', False):
        # 如果是打包后的 EXE 环境，去 _internal 目录下找 nvidia 文件夹
        nvidia_base = os.path.join(BASE_DIR, "_internal", "nvidia")
    else:
        # 如果是原始 Python 环境
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
    else:
        print(f"[*] 提示: 未找到 NVIDIA 运行库路径: {nvidia_base}，程序可能回退到 CPU 模式。")
    
    # 寻找 FFmpeg
    ffmpeg_local = os.path.join(BASE_DIR, "ffmpeg", "bin")
    ffmpeg_global = r"C:/258/ffmpeg"
    
    if os.path.exists(ffmpeg_local):
        os.environ["PATH"] = ffmpeg_local + os.pathsep + os.environ["PATH"]
    elif os.path.exists(ffmpeg_global):
        os.environ["PATH"] += os.pathsep + ffmpeg_global

setup_env()

# --- 2. 全局变量与配置 ---
app = FastAPI(title="Whisper 断点续传服务")
global_model = None
gpu_lock = threading.Lock()
converter = opencc.OpenCC('t2s')

# 任务数据库，存在内存中
tasks_db = {}

app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)

class AudioRequest(BaseModel):
    audio_path: str

# --- 3. 辅助函数 ---
def format_srt_timestamp(seconds: float):
    milliseconds = int((seconds - int(seconds)) * 1000)
    return f"{time.strftime('%H:%M:%S', time.gmtime(seconds))},{milliseconds:03d}"

def format_timestamp(seconds: float):
    return time.strftime('%H:%M:%S', time.gmtime(seconds))

# --- 4. 服务生命周期 ---
@app.on_event("startup")
async def startup_event():
    global global_model
    model_size = "turbo"
    use_gpu = torch.cuda.is_available()
    device, compute_type = ("cuda", "float16") if use_gpu else ("cpu", "int8")
    print(f"[*] 加载模型到 {device}...")
    global_model = WhisperModel(model_size, device=device, compute_type=compute_type)
    print("[*] Whisper 模型加载完毕，服务已就绪！")

# --- 5. 核心推理线程 ---
def whisper_worker(task_id: str, audio_path: str):
    """后台工作线程，将进度写入 tasks_db[task_id]"""
    # 获取显卡锁，如果没有轮到自己，状态就是 queued（排队中）
    with gpu_lock:
        tasks_db[task_id]["status"] = "running"
        start_time = time.time()
        try:
            segments, info = global_model.transcribe(
                audio_path, language="zh", task="transcribe", word_timestamps=True,
                beam_size=10, best_of=5, condition_on_previous_text=False,
                compression_ratio_threshold=2.2, log_prob_threshold=-1.0,
                no_speech_threshold=0.6, temperature=[0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
                vad_filter=True, vad_parameters=dict(threshold=0.5, min_speech_duration_ms=250, min_silence_duration_ms=500),
                initial_prompt="以下是普通话录音，请使用简体中文，并加入适当的标点符号。"
            )

            current_words = []
            MAX_GAP, MAX_SENTENCE_DURATION = 0.5, 8.0

            for segment in segments:
                if segment.words:
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
                                entry = {'start': current_words[0].start, 'end': current_words[-1].end, 'text': full_text}
                                tasks_db[task_id]["segments"].append(entry)
                                current_words = [word]
                            else:
                                current_words.append(word)

            if current_words:
                full_text = "".join([converter.convert(w.word.strip()) for w in current_words])
                entry = {'start': current_words[0].start, 'end': current_words[-1].end, 'text': full_text}
                tasks_db[task_id]["segments"].append(entry)

            # --- 文件生成 ---
# --- 文件生成 ---
            duration = time.time() - start_time
            
            # 【核心修改点】：获取输入音频的目录，以及它的原始文件名（去掉后缀）
            audio_dir = os.path.dirname(os.path.abspath(audio_path))
            original_filename = os.path.splitext(os.path.basename(audio_path))[0]

            # 拼装同名但后缀不同的文件路径
            txt_path = os.path.join(audio_dir, f"{original_filename}.txt")
            srt_path = os.path.join(audio_dir, f"{original_filename}.srt")

            # --- 收集更详细的元数据信息 ---
            file_size_mb = os.path.getsize(audio_path) / (1024 * 1024) # 计算文件大小(MB)
            audio_duration_str = time.strftime('%H:%M:%S', time.gmtime(info.duration)) # 音频总时长
            current_time_str = time.strftime('%Y-%m-%d %H:%M:%S') # 当前生成时间
            device_used = "GPU (CUDA)" if torch.cuda.is_available() else "CPU"
            
            # 组装高大上的 TXT 头部信息
            header_text = (
                f"【Whisper 智能语音转写报告】\n"
                f"==================================================\n"
                f"📄 文件名称: {os.path.basename(audio_path)}\n"
                f"📁 文件路径: {audio_path}\n"
                f"⏱️ 音频时长: {audio_duration_str}\n"
                f"🤖 识别模型: turbo (faster-whisper)\n"
                f"🖥️ 计算设备: {device_used}\n"
                f"⏳ 转写耗时: {duration:.2f} 秒\n"
                f"📅 生成时间: {current_time_str}\n"
                f"==================================================\n\n"
                f"【正文内容】\n"
            )

            # 写入 TXT 文件
            with open(txt_path, "w", encoding="utf-8") as f:
                f.write(header_text)
                for item in tasks_db[task_id]["segments"]:
                    f.write(f"[{format_timestamp(item['start'])} --> {format_timestamp(item['end'])}] {item['text']}\n")

            # 写入 SRT 文件 (SRT 标准格式不需要这个头部，保持原样即可)
            with open(srt_path, "w", encoding="utf-8") as f:
                for i, item in enumerate(tasks_db[task_id]["segments"], 1):
                    f.write(f"{i}\n{format_srt_timestamp(item['start'])} --> {format_srt_timestamp(item['end'])}\n{item['text']}\n\n")

            # 标记完成
            tasks_db[task_id]["status"] = "done"
            tasks_db[task_id]["result"] = {
                "time_cost": round(duration, 2),
                "txt_file": txt_path,
                "srt_file": srt_path
            }

        except Exception as e:
            tasks_db[task_id]["status"] = "error"
            tasks_db[task_id]["error_msg"] = str(e)

# 在 API 路由中，修改读取 html 的路径：
@app.get("/", response_class=HTMLResponse)
async def serve_frontend():
    html_path = os.path.join(BASE_DIR, "index.html")
    if os.path.exists(html_path):
        with open(html_path, "r", encoding="utf-8") as f:
            return f.read()
    return "<h1>请将 index.html 放在程序同级目录下</h1>"

# 消除 Chrome 强迫症报错
@app.get("/.well-known/appspecific/com.chrome.devtools.json")
async def silence_chrome_devtools():
    return {}

@app.post("/submit_task")
async def submit_task(request: AudioRequest):
    """提交任务并返回 Task ID"""
    audio_path = request.audio_path.strip().strip('"')
    if not os.path.exists(audio_path):
        raise HTTPException(status_code=404, detail="未找到音频文件")

    # 【新增】防呆校验，防止把 html 等无关文件传进来让 ffmpeg 崩溃
    valid_extensions = ('.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.wma', '.mp4', '.mov')
    if not audio_path.lower().endswith(valid_extensions):
        raise HTTPException(status_code=400, detail=f"文件格式错误！支持的格式: {', '.join(valid_extensions)}")

    task_id = str(uuid.uuid4())
    # 初始化任务状态
    tasks_db[task_id] = {
        "status": "queued", # 初始状态为排队中
        "segments": [],
        "audio_path": audio_path
    }
    
    # 启动后台线程执行，不会阻塞主流程
    threading.Thread(target=whisper_worker, args=(task_id, audio_path), daemon=True).start()
    return {"task_id": task_id, "message": "任务已提交"}

@app.get("/task_status/{task_id}")
async def get_task_status(task_id: str):
    """前端轮询此接口获取实时状态"""
    if task_id not in tasks_db:
        raise HTTPException(status_code=404, detail="任务不存在或已失效")
    return tasks_db[task_id]

if __name__ == "__main__":
    print("后台服务已启动！请在浏览器中打开: http://127.0.0.1:8286")
    uvicorn.run(app, host="0.0.0.0", port=8286)