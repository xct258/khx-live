import os
import sys
import time
import torch
import opencc
from tqdm import tqdm
from faster_whisper import WhisperModel

# --- 1. 环境修复 ---
def setup_cuda_env():
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
    ffmpeg_bin = r"C:/258/ffmpeg"
    if os.path.exists(ffmpeg_bin):
        os.environ["PATH"] += os.pathsep + ffmpeg_bin

setup_cuda_env()

# --- 2. 时间格式化 ---
def format_srt_timestamp(seconds: float):
    milliseconds = int((seconds - int(seconds)) * 1000)
    return f"{time.strftime('%H:%M:%S', time.gmtime(seconds))},{milliseconds:03d}"

def format_timestamp(seconds: float):
    return time.strftime('%H:%M:%S', time.gmtime(seconds))

# --- 3. 核心处理程序 ---
def process_video(video_path, use_gpu=True):
    model_size = "turbo"
    if use_gpu and torch.cuda.is_available():
        device, compute_type = "cuda", "float16"
        device_info, device_tag = f"CUDA 加速 ({torch.cuda.get_device_name(0)})", "GPU"
    else:
        device, compute_type = "cpu", "int8"
        device_info, device_tag = "多核 CPU 模式", "CPU"

    print(f"\n[配置] 硬件: {device_info} | 模型: {model_size}\n")
    model = WhisperModel(model_size, device=device, compute_type=compute_type)

    start_time_stamp = time.strftime('%Y-%m-%d %H:%M:%S')
    transcribe_start = time.time()
    
    # 核心转录逻辑
    segments, info = model.transcribe(
        video_path, 
        language="zh",
        word_timestamps=True,
        beam_size=5,
        vad_filter=True,
        vad_parameters=dict(threshold=0.6, min_silence_duration_ms=600), # 强化静音过滤
        condition_on_previous_text=False, # 彻底切断上下文关联，防止文字漂移
        initial_prompt="以下是普通话录音。" # 引导模型进入正常识别状态
    )

    transcribed_data = []
    current_words = []
    
    # 间距阈值：只要两个字之间停顿超过 0.5 秒，绝对认为是两句话
    MAX_GAP = 0.5 
    # 单句最大时长：如果一句话拖了 8 秒还没断，强制断开，防止跨越空白粘连
    MAX_SENTENCE_DURATION = 8.0

    pbar = tqdm(total=info.duration, unit="sec", desc="转录进度")
    last_pos = 0
    converter = opencc.OpenCC('t2s')

    for segment in segments:
        pbar.update(segment.end - last_pos)
        last_pos = segment.end
        
        if segment.words:
            for word in segment.words:
                word_text = converter.convert(word.word.strip())
                if not word_text: continue
                
                # 处理逻辑：根据物理时间戳重组
                if not current_words:
                    current_words.append(word)
                else:
                    gap = word.start - current_words[-1].end
                    duration_so_far = word.start - current_words[0].start
                    
                    # 满足任意一个条件则断句：间隙大 OR 句子太长
                    if gap > MAX_GAP or duration_so_far > MAX_SENTENCE_DURATION:
                        full_text = "".join([converter.convert(w.word.strip()) for w in current_words])
                        entry = {
                            'start': current_words[0].start,
                            'end': current_words[-1].end,
                            'text': full_text
                        }
                        transcribed_data.append(entry)
                        pbar.write(f"[{format_timestamp(entry['start'])} --> {format_timestamp(entry['end'])}] {entry['text']}")
                        
                        current_words = [word] # 开启新句
                    else:
                        current_words.append(word)

    # 收尾
    if current_words:
        full_text = "".join([converter.convert(w.word.strip()) for w in current_words])
        entry = {'start': current_words[0].start, 'end': current_words[-1].end, 'text': full_text}
        transcribed_data.append(entry)
        pbar.write(f"[{format_timestamp(entry['start'])} --> {format_timestamp(entry['end'])}] {entry['text']}")

    pbar.close()
    
    # --- 4. 文件生成 ---
    duration = time.time() - transcribe_start
    timestamp_fs = time.strftime('%Y%m%d_%H%M%S')
    base_name = f"[{model_size}]_{device_tag}_{timestamp_fs}"
    
    with open(f"{base_name}.txt", "w", encoding="utf-8") as f:
        f.write(f"【Whisper 物理对齐报告】\n")
        f.write(f"输入文件: {os.path.basename(video_path)}\n\n")
        for item in transcribed_data:
            f.write(f"[{format_timestamp(item['start'])} --> {format_timestamp(item['end'])}] {item['text']}\n")

    with open(f"{base_name}.srt", "w", encoding="utf-8") as f:
        for i, item in enumerate(transcribed_data, 1):
            f.write(f"{i}\n{format_srt_timestamp(item['start'])} --> {format_srt_timestamp(item['end'])}\n{item['text']}\n\n")

    print(f"\n[任务完成] 成功导出 TXT 和 SRT 文件。")

if __name__ == "__main__":
    print("Whisper 高性能工具 (物理时间轴重构版)")
    print("-" * 40)
    video_input = input("1. 请拖入视频文件路径: ").strip().strip('"')
    if not os.path.exists(video_input):
        sys.exit("错误：文件不存在")

    print("\n2. 选择计算设备: [1] GPU  [2] CPU")
    choice = input("请输入数字 (默认 1): ").strip()
    process_video(video_input, use_gpu=(choice != "2"))
    input("\n按回车键退出...")
