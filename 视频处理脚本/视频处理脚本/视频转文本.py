import subprocess
import whisper
import opencc
import time  # 导入 time 模块

def video_to_audio(video_path, audio_path):
    """使用ffmpeg将视频转换为音频"""
    command = ['ffmpeg', '-i', video_path, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', '-y', audio_path]
    subprocess.run(command, check=True)
    print(f"成功将视频转换为音频: {audio_path}")

def audio_to_text(audio_path, output_txt_path):
    """使用Whisper将音频转换为文本，并保存到文件中"""
    model = whisper.load_model("medium")  # 选择合适的模型，如 "base", "small", "medium"
    
    # 转换音频为文本
    result = model.transcribe(audio_path, language='zh')  # 使用中文

    # 将文本按句子分割并处理繁体中文到简体中文的转换
    converter = opencc.OpenCC('t2s.json')  # 't2s' 表示从繁体到简体
    with open(output_txt_path, 'w', encoding='utf-8') as output_file:
        for segment in result['segments']:
            text = segment['text'].strip()
            simplified_text = converter.convert(text)  # 转换为简体中文
            output_file.write(f"[{segment['start']:.2f}s] {simplified_text}\n")

def main(video_path):
    start_time = time.time()  # 记录开始时间
    audio_path = "output.wav"
    output_txt_path = "output.txt"
    video_to_audio(video_path, audio_path)
    audio_to_text(audio_path, output_txt_path)
    end_time = time.time()  # 记录结束时间
    elapsed_time = end_time - start_time  # 计算经过的时间
    print(f"脚本运行时间: {elapsed_time:.2f}秒")  # 输出运行时间

if __name__ == "__main__":
    video_file = "压制弹幕版-录播姬_2025年03月28日20点08分_求求你别爱死我_高机动持盾军官.mp4"  # 替换为你的视频文件路径
    main(video_file)
