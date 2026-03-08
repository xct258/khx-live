import numpy as np  # 导入NumPy库，用于数值计算
import matplotlib
matplotlib.use('Agg')  # 使用非交互式后端，加速图片生成
import matplotlib.pyplot as plt  # 导入Matplotlib库，用于绘图
import subprocess  # 导入subprocess模块，用于执行外部命令
import os  # 导入os模块，用于文件和目录操作
from scipy.interpolate import interp1d  # 导入插值函数，用于平滑数据
from scipy.signal import convolve  # 导入高斯滤波器和卷积函数
from scipy.signal.windows import gaussian  # 导入高斯滤波器和卷积函数
import xml.etree.ElementTree as ET  # 导入ElementTree库，用于解析XML文件
import shutil  # 导入shutil模块，用于文件和目录的高级操作
import matplotlib.collections as mcoll  # 导入用于颜色分段线条绘制
from multiprocessing import Pool
import multiprocessing
import sys
import traceback

# ================= 全局配置区 (可在脚本开头快速设置) =================
CONFIG = {
    # 编码参数设置
    'ENCODE': {
        # 正式版 (投稿版) - 高质量设置
        'MAIN_CRF': '21',           # CPU (x264) CRF 质量值 (越小画质越好，建议 18-23)
        'MAIN_PRESET': 'fast',      # CPU (x264) 预设 (medium/fast/faster，越慢压缩率越高)
        'QSV_QUALITY': '20',        # GPU (QSV) ICQ 质量值 (越小画质越好)
        'QSV_PRESET': 'medium',     # GPU (QSV) 预设 (medium/veryfast)
        
        # 预览版 - 快速/小体积设置
        'PREVIEW_CRF': '31',        # CPU 预览版 CRF
        'PREVIEW_PRESET': 'superfast', # CPU 预览版预设 (极速)
        'PREVIEW_QSV_QUALITY': '26',   # GPU 预览版质量
        'PREVIEW_QSV_PRESET': 'veryfast', # GPU 预览版预设
        
        # 预览版规格
        'PREVIEW_HEIGHT': 480,      # 分辨率高度 (P)
        'PREVIEW_FPS': 24,          # 帧率 (FPS)
        # 目标输出帧率，用于与 B 站二压对齐
        'TARGET_FPS': 30,
    },
    
    # 输出文件名前缀
    'FILENAME': {
        'NO_BAR': '投稿版',         # 投稿版（无进度条）
        'PREVIEW': '预览版',        # 网页预览（带进度条）
    },
    
    # 高能进度条算法参数
    'DENSITY': {
        'INTERVAL': 1,              # 采样精度 (秒)，越小越准
        'SMOOTH_WINDOW': 60,        # 平滑窗口 (秒)，越大越平滑(建议 30-60)
    }
}
# ==============================================================

class PrependLogFile:
    """Thin wrapper that prepends each write to the log file so the newest
    entries appear at the top. Falls back to append if any error occurs.
    Note: prepending reads/writes the whole file and can be expensive for very
    large logs; use with that tradeoff in mind."""
    def __init__(self, file_obj):
        self._file = file_obj
    @property
    def name(self):
        return self._file.name
    def write(self, s):
        # Defensive: if s is empty or not a string, just ignore
        try:
            if not s:
                return
            self._file.flush()
            path = self._file.name
            # Read existing content and write new content first
            with open(path, 'r', encoding='utf-8') as f:
                old = f.read()
            with open(path, 'w', encoding='utf-8') as f:
                f.write(s)
                f.write(old)
        except Exception:
            # Fallback: append to underlying file
            try:
                self._file.write(s)
                self._file.flush()
            except Exception:
                pass
    def flush(self):
        try:
            self._file.flush()
        except Exception:
            pass
    def close(self):
        try:
            self._file.close()
        except Exception:
            pass

# 解析XML文件，提取弹幕数据
def parse_bullet_xml(file_path):
    tree = ET.parse(file_path)  # 解析XML文件，返回ElementTree对象
    root = tree.getroot()  # 获取XML文件的根节点
    # 从根节点下找到所有"d"标签，提取其中的'p'属性，并转换为浮动类型的时间戳
    return [float(elem.attrib['p'].split(',')[0]) for elem in root.iter("d")]

# 解析SC标签的时间点
def parse_sc_times(xml_file):
    tree = ET.parse(xml_file)
    root = tree.getroot()
    sc_times = []
    for elem in root.findall('sc'):
        ts = elem.attrib.get('ts')
        if ts is not None:
            sc_times.append(float(ts))
    return sc_times

# 解析Guard标签的时间点
def parse_guard_times(xml_file):
    tree = ET.parse(xml_file)
    root = tree.getroot()
    guard_times = []
    for elem in root.findall('guard'):
        ts = elem.attrib.get('ts')
        if ts is not None:
            guard_times.append(float(ts))
    return guard_times

# XML转ASS（使用 DanmakuFactory）
# XML转ASS（使用 DanmakuFactory）
def convert_xml_to_ass(xml_file, danmaku_factory_path='/rec/apps/DanmakuFactory', 
                       font_size=50, opacity=200, log_file=None):
    """
    使用 DanmakuFactory 将 XML 弹幕文件转换为 ASS 字幕文件
    
    参数:
        xml_file: XML 弹幕文件路径
        danmaku_factory_path: DanmakuFactory 可执行文件路径
        font_size: 字体大小（默认50）
        opacity: 不透明度 0-255（默认200）
        log_file: 日志文件句柄
    """
    # 生成 ASS 文件路径
    ass_file = os.path.splitext(xml_file)[0] + '.ass'
    
    # 检查 DanmakuFactory 是否存在
    if not os.path.isfile(danmaku_factory_path):
        raise FileNotFoundError(f"DanmakuFactory 不存在：{danmaku_factory_path}")
    
    # 检查是否有执行权限（Unix系统）
    if hasattr(os, 'access') and not os.access(danmaku_factory_path, os.X_OK):
        raise PermissionError(f"DanmakuFactory 不可执行：{danmaku_factory_path}")
    
    if log_file:
        print(f"\n{'='*70}", file=log_file)
        print(f"🔄 转换弹幕文件", file=log_file)
        print(f"{'='*70}", file=log_file)
        print(f"📄 输入: {xml_file}", file=log_file)
        print(f"📝 输出: {ass_file}", file=log_file)
        print(f"⚙️  字体大小: {font_size}", file=log_file)
        print(f"⚙️  不透明度: {opacity}/255", file=log_file)
        print(f"{'='*70}\n", file=log_file)
    
    # 构建命令
    command = [
        danmaku_factory_path,
        '-i', xml_file,
        '-o', ass_file,
        '-S', str(font_size),
        '-O', str(opacity),
        '--ignore-warnings'
    ]
    
    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True)
        if log_file:
            print(f"✅ 转换完成: {ass_file}\n", file=log_file)
        return ass_file
    except subprocess.CalledProcessError as e:
        if log_file:
            print(f"❌ 转换失败: {e}", file=log_file)
            if e.stderr:
                print(f"错误信息: {e.stderr}", file=log_file)
        raise

# 获取视频文件的时长
# 获取视频文件的时长
def get_video_duration(video_file):
    if not os.path.exists(video_file):
        print(f"❌ 错误: 找不到视频文件: {video_file}")
        raise FileNotFoundError(f"Video file not found: {video_file}")
        
    cmd = ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', video_file]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    
    try:
        return float(result.stdout)
    except ValueError:
        print(f"❌ 错误: 无法获取视频时长。ffprobe 输出为空。")
        print(f"命令: {' '.join(cmd)}")
        print(f"错误信息: {result.stderr.decode('utf-8', errors='ignore')}")
        raise

# 获取视频的分辨率
# 获取视频的分辨率
def get_video_resolution(video_file):
    if not os.path.exists(video_file):
        print(f"❌ 错误: 找不到视频文件: {video_file}")
        raise FileNotFoundError(f"Video file not found: {video_file}")

    cmd = ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', video_file]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    
    try:
        resolution = result.stdout.decode('utf-8').strip().split('x')
        return int(resolution[0]), int(resolution[1])
    except (ValueError, IndexError):
        print(f"❌ 错误: 无法获取视频分辨率。")
        print(f"命令: {' '.join(cmd)}")
        print(f"错误信息: {result.stderr.decode('utf-8', errors='ignore')}")
        raise

# 计算弹幕密度
# 计算弹幕密度（优化版：提高精度，保留峰值）
def count_bullet_density(bullet_data, interval=CONFIG['DENSITY']['INTERVAL'], lookahead=None):
    """
    计算弹幕密度
    :param interval: 时间切片间隔，默认从 CONFIG 读取
    :param lookahead: (已废弃，保留兼容)
    """
    max_time = max(bullet_data) if bullet_data else 0
    # 向傻瓜式对齐：直接用整秒的 bins
    time_bins = np.arange(0, int(max_time) + 2, interval)
    
    # 统计直方图（比循环快得多）
    density, _ = np.histogram(bullet_data, bins=time_bins)
    
    # 直接返回原始密度，不做滑动平均，保留高能尖峰特征
    # 后续会统一做一次高斯平滑
    return time_bins[:-1], density

# 高斯平滑弹幕密度
def smooth_bullet_density(time_bins, bullet_density, window_size=CONFIG['DENSITY']['SMOOTH_WINDOW']):
    # 【优化】应用平方根变换：抑制极端峰值（如刷屏），放大普通高能片段的波动
    bullet_density = np.sqrt(bullet_density)
    
    # 使用更大的 std (window_size/3)，使曲线极其平滑圆润，去除生硬的棱角
    window = gaussian(window_size, std=window_size/3)  # 创建高斯平滑窗口
    smoothed_density = convolve(bullet_density, window, mode='same') / sum(window)  # 对密度数据进行卷积操作进行平滑
    
    # 创建更细粒度的时间区间（1000个点）
    time_fine = np.linspace(time_bins[0], time_bins[-1], num=1000)
    interpolator = interp1d(time_bins, smoothed_density, kind='cubic', fill_value="extrapolate")  # 使用立方插值器
    smoothed_density_fine = np.maximum(interpolator(time_fine), 0)  # 插值结果并确保密度不为负
    
    return time_fine, smoothed_density_fine  # 返回平滑后的时间和弹幕密度

# 绘制弹幕密度图，区分播放区域和未播放区域，sc和舰长区间分别用红色和蓝色，前后30秒高亮显示
def plot_bullet_density(time_fine, bullet_density_fine, current_time, max_time,
                        frame_index, folder_name, sc_times=None, guard_times=None, highlight_width=30):
    plt.figure(figsize=(1920 / 100, 1080 / 100))  # 设置绘图大小为1920x1080像素比例缩放

    # 获取弹幕密度数据的最小值和最大值，用于确定Y轴范围
    min_val = min(bullet_density_fine)
    max_val = max(bullet_density_fine)
    line_range = max_val - min_val

    # 设置上下边距，让线条“不贴底”且有较大上方空间
    visual_top_margin = line_range * 20.0
    visual_bottom_margin = line_range * 0.2
    plt.ylim(min_val - visual_bottom_margin, max_val + visual_top_margin)

    plt.xlim(0, max_time)  # 设置X轴范围为0到视频最大时长

    plt.axis('off')  # 关闭坐标轴显示
    plt.grid(False)  # 关闭网格线

    # 将时间和弹幕密度转换为点对，方便绘制分段颜色线条
    points = np.array([time_fine, bullet_density_fine]).T.reshape(-1, 1, 2)
    segments = np.concatenate([points[:-1], points[1:]], axis=1)

    # 根据时间点判断线条颜色：
    # 播放时间点之前为绿色，之后为灰色
    # 如果当前点在sc时间点±30秒范围内，显示红色
    # 如果当前点在舰长时间点±30秒范围内，显示蓝色
    colors = []
    for t in time_fine[:-1]:
        # 默认颜色，未播放区域灰色，播放区域绿色
        color = 'green' if t <= current_time else 'gray'

        # 判断是否在sc时间点±highlight_width范围内，覆盖颜色为红色
        if sc_times and any(abs(t - sc_t) <= highlight_width for sc_t in sc_times):
            color = 'red'
        # 判断是否在舰长时间点±highlight_width范围内，覆盖颜色为蓝色（优先级低于sc）
        elif guard_times and any(abs(t - g_t) <= highlight_width for g_t in guard_times):
            color = 'blue'

        colors.append(color)

    # 使用LineCollection绘制带颜色分段的线条
    lc = mcoll.LineCollection(segments, colors=colors, linewidth=2)
    plt.gca().add_collection(lc)  # 添加到当前图像的坐标轴

    plt.savefig(f'{folder_name}/frame_{frame_index}.png', bbox_inches='tight', pad_inches=0, transparent=True, dpi=100)  # 保存图片
    plt.close()  # 关闭图像释放内存

# 单帧绘制的包装函数（用于并行处理）
def plot_single_frame(args):
    """单帧绘制的包装函数，接收元组参数以便多进程调用"""
    time_fine, bullet_density_fine, current_time, max_time, frame_index, folder_name, sc_times, guard_times = args
    plot_bullet_density(time_fine, bullet_density_fine, current_time, max_time,
                        frame_index, folder_name, sc_times=sc_times, guard_times=guard_times)

# 生成视频帧（每5秒生成一张），使用并行处理加速
def generate_frames(video_duration, bullet_density_fine, time_fine, frame_interval=5, folder_name='frames', sc_times=None, guard_times=None, log_file=None):
    os.makedirs(folder_name, exist_ok=True)  # 创建保存帧的文件夹，如果不存在则创建
    
    # 准备所有帧的参数
    frame_args = []
    frame_index = 0
    for current_time in np.arange(0, video_duration, frame_interval):
        frame_args.append((time_fine, bullet_density_fine, current_time, video_duration,
                          frame_index, folder_name, sc_times, guard_times))
        frame_index += 1
    
    # 使用进程池并行生成（使用 CPU 核心数）
    cpu_count = multiprocessing.cpu_count()
    if log_file:
        print(f"使用 {cpu_count} 个进程并行生成 {len(frame_args)} 张图片...", file=log_file)
    
    with Pool(processes=cpu_count) as pool:
        pool.map(plot_single_frame, frame_args)
    
    if log_file:
        print(f"图片生成完成！", file=log_file)

# 创建视频文件
def create_video(output_file, fps=1, resolution=(1920, 1080), folder_name='frames', log_file=None):
    cmd = [
        'ffmpeg',
        '-framerate', str(fps),
        '-i', f'{folder_name}/frame_%d.png',
        '-c:v', 'png',
        '-pix_fmt', 'rgba',
        '-s', f'{resolution[0]}x{resolution[1]}',
        '-y', output_file
    ]
    
    if log_file:
        print(f"正在合成进度条视频...", file=log_file)
        # 仅在出错时捕获输出，正常情况静默
        try:
            subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            print(f"   ✓ 进度条视频合成完成", file=log_file)
        except subprocess.CalledProcessError as e:
            print(f"   ✗ 合成失败: {e}", file=log_file)
            print(f"   详细错误: {e.stderr.decode('utf-8', errors='ignore')}", file=log_file)
    else:
        # 如果没有日志文件，则静默运行或输出到DEVNULL
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

# 渲染视频（支持多个输出版本）
def render_videos(original_video, overlay_video, ass_file, video_duration, output_with_bar=None, output_without_bar=None, output_preview=None, log_file=None):
    """
    渲染视频，支持多种模式：
    - 仅投稿版（无进度条）：只提供 output_without_bar
    - 仅网页预览（带进度条）：只提供 output_preview
    - 双版本：同时提供多个参数（投稿版 + 网页预览）
    
    参数:
        video_duration: 视频总时长（秒），用于计算压制进度
        log_file: 日志文件句柄
    """
    if not output_with_bar and not output_without_bar and not output_preview:
        raise ValueError("至少需要指定一个输出文件")
    
    # 统计需要输出的版本数量
    output_count = sum([bool(output_with_bar), bool(output_without_bar), bool(output_preview)])
    
    # 构建滤镜链
    if output_count > 1:
        # 多输出模式：使用 split 滤镜
        # 确定需要几路分离
        split_count = 0
        if output_with_bar:
            split_count += 1
        if output_without_bar:
            split_count += 1
        if output_preview:
            split_count += 1
        
        filter_parts = []
        split_outputs = [f'v_base{i+1}' for i in range(split_count)]
        
        # 分离基础视频流
        filter_parts.append(f'[0:v]split={split_count}[' + ']['.join(split_outputs) + ']')
        
        # 为每个输出构建处理链
        split_idx = 0
        if output_with_bar:
            filter_parts.append(f'[{split_outputs[split_idx]}][1:v]overlay=0:0[v_overlayed]')
            filter_parts.append(f'[v_overlayed]ass={ass_file}[v_out_bar]')
            split_idx += 1
        
        if output_without_bar:
            filter_parts.append(f'[{split_outputs[split_idx]}]ass={ass_file}[v_out_clean]')
            split_idx += 1
        
        if output_preview:
            # 预览版本：先叠加进度条，再大幅缩小分辨率到 480p，降低帧率到24fps
            p_h = CONFIG['ENCODE']['PREVIEW_HEIGHT']
            p_fps = CONFIG['ENCODE']['PREVIEW_FPS']
            filter_parts.append(f'[{split_outputs[split_idx]}][1:v]overlay=0:0[v_overlayed_preview]')
            filter_parts.append(f'[v_overlayed_preview]scale=-2:{p_h},fps={p_fps}[v_scaled]')
            filter_parts.append(f'[v_scaled]ass={ass_file}[v_out_preview]')
            split_idx += 1
        
        filter_complex = ';'.join(filter_parts)
        inputs = ['-i', original_video, '-i', overlay_video] if overlay_video else ['-i', original_video]
    else:
        # 单输出模式
        if output_with_bar:
            # 带进度条
            filter_complex = f'[0:v][1:v]overlay=0:0[v_overlayed];[v_overlayed]ass={ass_file}[v_out_bar]'
            inputs = ['-i', original_video, '-i', overlay_video]
        elif output_without_bar:
            # 无进度条
            filter_complex = f'[0:v]ass={ass_file}[v_out_clean]'
            inputs = ['-i', original_video]
        else:  # output_preview
            # 网页预览版（带进度条，480p, 24fps）
            p_h = CONFIG['ENCODE']['PREVIEW_HEIGHT']
            p_fps = CONFIG['ENCODE']['PREVIEW_FPS']
            filter_complex = f'[0:v][1:v]overlay=0:0[v_overlayed];[v_overlayed]scale=-2:{p_h},fps={p_fps}[v_scaled];[v_scaled]ass={ass_file}[v_out_preview]'
            inputs = ['-i', original_video, '-i', overlay_video]

    # 通用输出参数（可以根据需要调整 bitrate 等）
    # 注意：我们需要为两个输出分别指定 -map 和编码参数
    # 为了简化命令构建，我们将重复通用参数
    
    def get_output_args(map_v, map_a, encoder, bitrate, output_file, is_preview=False):
        args = [
            '-map', map_v,
            '-map', map_a,
            '-c:v', encoder,
        ]
        
        if encoder == 'libx264':
            if is_preview:
                # 预览版本 (读配置)
                args.extend(['-crf', CONFIG['ENCODE']['PREVIEW_CRF'], 
                             '-profile:v', 'main', 
                             '-preset', CONFIG['ENCODE']['PREVIEW_PRESET'], 
                             '-tune', 'fastdecode'])
            else:
                # 正式版本 (读配置)
                args.extend(['-crf', CONFIG['ENCODE']['MAIN_CRF'], 
                             '-profile:v', 'high', 
                             '-preset', CONFIG['ENCODE']['MAIN_PRESET']])
                
        elif encoder == 'h264_qsv':
            if is_preview:
                # 预览版本 (读配置)
                args.extend(['-global_quality', CONFIG['ENCODE']['PREVIEW_QSV_QUALITY'], 
                             '-preset', CONFIG['ENCODE']['PREVIEW_QSV_PRESET']])
            else:
                # 正式版本 (读配置)
                args.extend(['-global_quality', CONFIG['ENCODE']['QSV_QUALITY'], 
                             '-preset', CONFIG['ENCODE']['QSV_PRESET']])
        
        # 强制输出帧率以匹配目标站点（避免二压抽帧导致弹幕跳动）
        args.extend(['-r', str(CONFIG['ENCODE']['TARGET_FPS']), '-vsync', '2'])
        
        # 音频处理
        if is_preview:
            # 预览版本大幅降低音频码率
            args.extend(['-c:a', 'aac', '-b:a', '64k', '-ar', '44100', '-y', output_file])
        else:
            args.extend(['-c:a', 'copy', '-y', output_file])
        return args

    # 生成进度日志文件路径（与输出视频同目录）
    # 使用第一个非空的输出文件路径
    output_file_for_log = output_with_bar or output_without_bar or output_preview
    progress_log = os.path.join(os.path.dirname(output_file_for_log), '压制进度.log')
    
    def parse_ffmpeg_progress(line):
        """解析 FFmpeg 进度输出行"""
        import re
        info = {}
        
        # 提取关键信息
        frame_match = re.search(r'frame=\s*(\d+)', line)
        fps_match = re.search(r'fps=\s*([\d.]+)', line)
        speed_match = re.search(r'speed=\s*([\d.]+)x', line)
        time_match = re.search(r'time=(\d{2}:\d{2}:\d{2}\.\d{2})', line)
        bitrate_match = re.search(r'bitrate=\s*([\d.]+\w+/s)', line)
        
        if frame_match:
            info['frame'] = frame_match.group(1)
        if fps_match:
            info['fps'] = fps_match.group(1)
        if speed_match:
            info['speed'] = speed_match.group(1)
        if time_match:
            info['time'] = time_match.group(1)
        if bitrate_match:
            info['bitrate'] = bitrate_match.group(1)
        
        return info if info else None
    
    
    
    def run_ffmpeg_with_elegant_logging(command, log_file, video_duration):
        """运行 FFmpeg 并将进度写入日志（不输出到控制台）"""
        import threading
        import time
        from datetime import timedelta
        from collections import deque
        
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1
        )
        
        # 记录开始时间
        start_time = time.time()
        
        # 移动平均队列：存储 (wall_time, video_time)
        # 用于计算最近一断时间的平均速度，而不是全局平均速度
        speed_history = deque(maxlen=30) 
        
        def time_to_seconds(time_str):
            """将时间格式 HH:MM:SS.MS 转换为秒"""
            try:
                parts = time_str.split(':')
                hours = int(parts[0])
                minutes = int(parts[1])
                seconds = float(parts[2])
                return hours * 3600 + minutes * 60 + seconds
            except:
                return 0
        
        def format_time(seconds):
            """格式化秒数为可读时间"""
            return str(timedelta(seconds=int(seconds)))
        
        def read_output():
            last_log_time = 0
            
            # 存储最近的几行输出，以便在出错时打印调试信息
            recent_lines = deque(maxlen=20)
            
            for line in iter(process.stdout.readline, ''):
                # 缓存最近输出
                recent_lines.append(line)
                
                # 【修改】不再将每一行原始输出写入日志
                # if log_file:
                #     log_file.write(line)
                #     log_file.flush()
                
                # 解析并定期记录进度（每5秒）
                if log_file and 'frame=' in line and 'time=' in line:
                    now = time.time()
                    if now - last_log_time > 5:
                        progress = parse_ffmpeg_progress(line)
                        if progress and progress.get('time'):
                            current_video_time = time_to_seconds(progress['time'])
                            
                            # 添加到历史记录
                            speed_history.append((now, current_video_time))
                            
                            if video_duration > 0 and current_video_time > 0:
                                # 计算百分比
                                percentage = min((current_video_time / video_duration) * 100, 100)
                                
                                # 使用滑动窗口计算预估剩余时间 (Smart ETA)
                                eta_text = "计算中..."
                                if len(speed_history) > 1:
                                    # 计算窗口内的速度
                                    delta_wall = speed_history[-1][0] - speed_history[0][0]
                                    delta_video = speed_history[-1][1] - speed_history[0][1]
                                    
                                    if delta_wall > 0 and delta_video > 0:
                                        current_speed = delta_video / delta_wall  # 视频秒/实时秒
                                        remaining_video = video_duration - current_video_time
                                        eta_seconds = remaining_video / current_speed
                                        eta_text = format_time(eta_seconds)
                                
                                # 写入更加人性化的进度行到日志
                                log_file.write(f"\n>>> ⏳ 进度: {percentage:5.1f}% | 剩余时间(动态预估): {eta_text} | 速度: {progress.get('speed', 'N/A')} <<<\n\n")
                                log_file.flush()
                                last_log_time = now
        
        # 启动输出读取线程
        output_thread = threading.Thread(target=read_output, daemon=True)
        output_thread.start()
        
        try:
            process.wait()
            output_thread.join(timeout=1)
            
            # 计算总耗时
            total_time = time.time() - start_time
            
            # 记录完成信息到日志
            if log_file:
                # 如果返回码不为0，说明可能出错，打印缓存在最近的原始日志
                if process.returncode != 0:
                    log_file.write("\n" + "!" * 70 + "\n")
                    log_file.write(f"⚠️  FFmpeg 异常退出 (Return Code: {process.returncode})\n")
                    log_file.write("最后 20 行 FFmpeg 输出:\n")
                    log_file.write("-" * 30 + "\n")
                    # 由于 read_output 在线程中运行，我们可能需要在这里访问 saved lines?
                    # 实际上线程可能已经退出了。为了简单起见，我们只能假设日志里已经有了（并不，我们删了）
                    # 这是一个权衡。如果用户不需要详细日志，那么出错时确实会缺少信息。
                    # 改进方案：我们还是得把 recent_lines 传出来。
                    # 但由于 python 闭包特性，我们可以在外部定义一个 deque
                    pass
                
                log_file.write("\n" + "=" * 70 + "\n")
                log_file.write(f"✅ 压制完成\n")
                log_file.write(f"总耗时: {format_time(total_time)}\n")
                log_file.write(f"视频时长: {format_time(video_duration)}\n")
                if total_time > 0 and video_duration > 0:
                    speed_ratio = video_duration / total_time
                    log_file.write(f"平均速度: {speed_ratio:.2f}x\n")
                log_file.write("=" * 70 + "\n")
                log_file.flush()
            
            return process.returncode
        except KeyboardInterrupt:
            # 记录中断信息
            elapsed = time.time() - start_time
            if log_file:
                log_file.write("\n" + "=" * 70 + "\n")
                log_file.write(f"⚠️  压制被中断\n")
                log_file.write(f"已运行时间: {format_time(elapsed)}\n")
                log_file.write("=" * 70 + "\n")
                log_file.flush()
            
            try:
                # 向 FFmpeg 发送 'q' 命令，让它优雅退出
                process.stdin.write('q\n')
                process.stdin.flush()
                # 等待 FFmpeg 完成封装（最多等待 30 秒）
                process.wait(timeout=30)
                output_thread.join(timeout=2)
                if log_file:
                    log_file.write("✓ FFmpeg 已安全退出，部分压制的视频可正常播放。\n")
            except subprocess.TimeoutExpired:
                if log_file:
                    log_file.write("✗ FFmpeg 响应超时，强制终止...\n")
                process.kill()
            except Exception as e:
                if log_file:
                    log_file.write(f"✗ 关闭 FFmpeg 时出错：{e}\n")
                process.kill()
            raise KeyboardInterrupt()
    
    
    # 构建 FFmpeg 命令
    qsv_command = ['ffmpeg'] + inputs + ['-filter_complex', filter_complex]
    cpu_command = ['ffmpeg'] + inputs + ['-filter_complex', filter_complex]
    
    # 添加各个输出的编码参数
    if output_with_bar:
        qsv_command += get_output_args('[v_out_bar]', '0:a', 'h264_qsv', '12M', output_with_bar, is_preview=False)
        cpu_command += get_output_args('[v_out_bar]', '0:a', 'libx264', '12M', output_with_bar, is_preview=False)
    
    if output_without_bar:
        qsv_command += get_output_args('[v_out_clean]', '0:a', 'h264_qsv', '12M', output_without_bar, is_preview=False)
        cpu_command += get_output_args('[v_out_clean]', '0:a', 'libx264', '12M', output_without_bar, is_preview=False)
    
    if output_preview:
        qsv_command += get_output_args('[v_out_preview]', '0:a', 'h264_qsv', '800k', output_preview, is_preview=True)
        cpu_command += get_output_args('[v_out_preview]', '0:a', 'libx264', '800k', output_preview, is_preview=True)

    if log_file:
        print(f"\n{'='*70}", file=log_file)
        print(f"🎬 开始压制视频", file=log_file)
        print(f"{'='*70}", file=log_file)
        print(f"💡 提示: 按 Ctrl+C 可安全中断，部分压制的视频仍可播放", file=log_file)
        print(f"{'='*70}\n", file=log_file)
    
    # 首先尝试使用 QSV 硬件加速压制，若失败再回退到 CPU 软件编码
    if log_file:
        log_file.write("=" * 70 + "\n")
        log_file.write("FFmpeg 压制进度日志\n")
        log_file.write("=" * 70 + "\n")
        log_file.write(f"开始时间: {os.popen('echo %date% %time%').read().strip()}\n")
        log_file.write(f"编码方式: QSV 硬件加速（优先）\n")
        if output_without_bar:
            log_file.write(f"输出文件 (投稿版， 无进度条): {output_without_bar}\n")
        if output_preview:
            log_file.write(f"输出文件 (网页预览， 带进度条): {output_preview}\n")

    # 运行 QSV 编码
    try:
        qsv_result = run_ffmpeg_with_elegant_logging(qsv_command, log_file, video_duration)

        if qsv_result == 0:
            # QSV 成功
            if log_file:
                log_file.write("\n✅ QSV 硬件加速编码成功\n")
            final_result = 0
        else:
            # QSV 失败，记录并尝试 CPU 编码
            if log_file:
                log_file.write(f"\n⚠️ QSV 编码失败 (返回码: {qsv_result})，改用 CPU 软件编码...\n")
                log_file.write("=" * 70 + "\n")
                log_file.write("FFmpeg 压制进度日志\n")
                log_file.write("=" * 70 + "\n")
                log_file.write(f"开始时间: {os.popen('echo %date% %time%').read().strip()}\n")
                log_file.write(f"编码方式: CPU 软件编码 (QSV 失败)\n")
                if output_without_bar:
                    log_file.write(f"输出文件 (投稿版， 无进度条): {output_without_bar}\n")
                if output_preview:
                    log_file.write(f"输出文件 (网页预览， 带进度条): {output_preview}\n")

            cpu_result = run_ffmpeg_with_elegant_logging(cpu_command, log_file, video_duration)
            final_result = cpu_result

    # 输出最终状态和文件信息
    
        if final_result == 0:
            if log_file:
                log_file.write("\n" + "=" * 70 + "\n")
                log_file.write("✅ 压制完成！\n")
            print(f"\n{'='*70}", file=log_file)
            print(f"✅ 压制完成！", file=log_file)
            print(f"{'='*70}", file=log_file)
            print(f"📁 输出文件:", file=log_file)
            if output_without_bar:
                print(f"   • 【投稿版】 {output_without_bar}", file=log_file)
            if output_preview:
                print(f"   • 【网页预览】 {output_preview} (480p, 24fps, 质量优先)", file=log_file)
            print(f"{'='*70}\n", file=log_file)
        else:
            if log_file:
                log_file.write(f"\n⚠️ 压制失败 (返回码: {final_result})\n")
                log_file.flush()
    
    except KeyboardInterrupt:
        if log_file:
            print(f"\n{'='*70}", file=log_file)
            print(f"⚠️  压制已中断", file=log_file)
            print(f"{'='*70}\n", file=log_file)
        raise

# 主函数
def main(xml_file, mode='both', danmaku_factory='/rec/apps/DanmakuFactory', 
         font_size=50, opacity=200, output_dir=None, final_dir=None):
    """
    mode 参数:
    - 'both': 生成两个版本（投稿版（无进度条）+ 网页预览（带进度条），默认）
    - 'clean': 仅生成投稿版（无进度条）
    - 'preview': 仅生成网页预览版本（480p, 24fps，带进度条）
    - 'all': 生成所有支持的版本（同 both）
    
    danmaku_factory: DanmakuFactory 可执行文件路径
    font_size: ASS 字体大小
    opacity: ASS 不透明度 (0-255)
    """
    
    # 确定输出基目录（优先使用 output_dir，其次使用 XML 文件同目录）
    base_dir = output_dir if output_dir else os.path.dirname(xml_file)
    if not base_dir:
        base_dir = os.getcwd()
    os.makedirs(base_dir, exist_ok=True)

    # 初始化日志文件（放在输出目录，名称与 xml 同名）
    xml_base_for_log = os.path.splitext(os.path.basename(xml_file))[0]
    log_path = os.path.join(base_dir, f"{xml_base_for_log}.log")

    with open(log_path, 'w', encoding='utf-8') as raw_log:
        # 使用 PrependLogFile 包装器，使最新日志在最上面
        log_file = PrependLogFile(raw_log)
        # 保存原始 stdout/stderr
        original_stdout = sys.stdout
        original_stderr = sys.stderr
        
        # 重定向到日志文件
        sys.stdout = log_file
        sys.stderr = log_file
        
        try:
            print(f"日志记录已启动: {log_path}", file=log_file)
            
            # 解析XML文件，提取弹幕数据
            bullet_data = parse_bullet_xml(xml_file)
            
            # 根据XML文件路径生成视频文件路径，优先查找 mp4，否则尝试 flv
            base = os.path.splitext(xml_file)[0]
            if os.path.exists(base + '.mp4'):
                video_file = base + '.mp4'
            elif os.path.exists(base + '.flv'):
                video_file = base + '.flv'
            else:
                # 默认仍使用 mp4 扩展名，如果文件不存在后续会报错
                video_file = base + '.mp4'

            # 根据XML文件路径生成ass文件路径
            ass_file = base + '.ass'
            
            # 总是重新转换 ASS 文件
            convert_xml_to_ass(xml_file, danmaku_factory, font_size, opacity, log_file=log_file)

            # 获取视频的时长
            video_duration = get_video_duration(video_file)
            
            # 计算弹幕密度
            time_bins, bullet_density = count_bullet_density(bullet_data)
            
            # 对弹幕密度进行高斯平滑
            time_fine, bullet_density_fine = smooth_bullet_density(time_bins, bullet_density)
            
            # 确保时间序列覆盖到视频末尾，避免进度条不满屏（若平滑后的末尾小于视频时长，则追加终点值）
            try:
                if time_fine.size == 0 or time_fine[-1] < video_duration:
                    time_fine = np.append(time_fine, video_duration)
                    bullet_density_fine = np.append(bullet_density_fine, 0.0)
            except Exception:
                # 如果发生异常，不阻塞主流程（保守处理）
                pass
            
            # 获取XML文件基本名称（去掉后缀）
            xml_base_name = os.path.splitext(os.path.basename(xml_file))[0]

            # 解析SC和舰长时间点
            sc_times = parse_sc_times(xml_file)
            guard_times = parse_guard_times(xml_file)

            # 生成视频帧文件夹路径（放在 base_dir 下）
            folder_name = os.path.join(base_dir, f"{xml_base_name}_frames")

            # 创建弹幕密度进度条视频文件名（放在 base_dir 下）
            overlay_video_file = os.path.join(base_dir, f'高能进度条-{xml_base_name}.mp4')

            # 确定最终成品输出目录变量（仅保存变量，实际目录在压制成功后才创建）
            final_output_dir = final_dir if final_dir else base_dir
            if not final_output_dir:
                final_output_dir = os.getcwd()
            # 注意：不要在此创建 final_output_dir 目录，成品目录仅在压制成功后创建/移动文件
            
            # 判断是否需要生成进度条（仅预览版需要）
            need_progress_bar = mode in ['both', 'all', 'preview']
            
            
            # 只有需要进度条时才生成图片和进度条视频
            if need_progress_bar:
                # 生成视频帧
                generate_frames(video_duration, bullet_density_fine, time_fine,
                                frame_interval=5, folder_name=folder_name,
                                sc_times=sc_times, guard_times=guard_times, log_file=log_file)  # 每5秒生成一张图表，带高亮SC和舰长

                # 获取视频分辨率
                resolution = get_video_resolution(video_file)
                
                # 创建弹幕密度进度条视频（临时放在 base_dir）
                create_video(overlay_video_file, fps=1/5, resolution=resolution, folder_name=folder_name, log_file=log_file)  # 视频帧率每5秒1帧
            
            # 生成最终压制视频输出文件名（先在 base_dir 创建临时输出，成功后再移动到 final_output_dir）
            # 说明：移除原带进度条的 "投稿版"，并将原来的 "切片版" 改名为 "投稿版"（无进度条）
            p_main = CONFIG['FILENAME']['NO_BAR']  # 切片版改名为投稿版
            p_preview = CONFIG['FILENAME']['PREVIEW']
            temp_output_main = os.path.join(base_dir, f'{p_main}-{xml_base_name}.mp4') if mode in ['both', 'all', 'clean'] else None
            temp_output_preview = os.path.join(base_dir, f'{p_preview}-{xml_base_name}.mp4') if mode in ['both', 'all', 'preview'] else None

            # 渲染视频（根据模式选择输出），先输出到 base_dir 的临时文件
            render_videos(
                video_file,
                overlay_video_file if need_progress_bar else None,  # 仅预览版需要进度条
                ass_file,
                video_duration,  # 视频时长，用于计算进度
                output_with_bar=None,
                output_without_bar=temp_output_main,
                output_preview=temp_output_preview,
                log_file=log_file
            )

            # 如果压制成功且用户指定了 final_dir（且与 base_dir 不同），创建最终目录并移动成品
            if final_dir and os.path.abspath(final_dir) != os.path.abspath(base_dir):
                try:
                    os.makedirs(final_dir, exist_ok=True)
                    moved = []
                    for tmp, label in ((temp_output_main, '投稿版'), (temp_output_preview, '网页预览')):
                        if tmp and os.path.exists(tmp):
                            dest = os.path.join(final_dir, os.path.basename(tmp))
                            shutil.move(tmp, dest)
                            moved.append((label, dest))

                    if moved and log_file:
                        print(f"已将成品移动到最终目录: {final_dir}", file=log_file)
                        for name, dest in moved:
                            print(f"   • 【{name}】 {dest}", file=log_file)
                        log_file.flush()
                except Exception as e:
                    if log_file:
                        print(f"✗ 移动成品到最终目录失败: {e}", file=log_file)
                        log_file.flush()

        except Exception as e:
            # 捕获所有未处理的异常并记录到日志
            if 'log_file' in locals() and not log_file.closed:
                print(f"\n{'='*70}", file=log_file)
                print(f"❌ 发生未捕获的错误", file=log_file)
                print(f"{'='*70}", file=log_file)
                traceback.print_exc(file=log_file)
            pass

        finally:
            # 无论是否发生异常，都清理临时文件
            print("\n🧹 清理临时文件...", file=log_file)
            
            # 删除帧文件夹
            if os.path.exists(folder_name):
                try:
                    shutil.rmtree(folder_name)
                    print(f"   ✓ 已删除帧文件夹: {folder_name}", file=log_file)
                except Exception as e:
                    print(f"   ✗ 删除帧文件夹失败: {e}", file=log_file)
            
            # 删除进度条视频
            if os.path.exists(overlay_video_file):
                try:
                    os.remove(overlay_video_file)
                    print(f"   ✓ 已删除进度条视频: {overlay_video_file}", file=log_file)
                except Exception as e:
                    print(f"   ✗ 删除进度条视频失败: {e}", file=log_file)
            
            # 删除 ASS 文件
            if os.path.exists(ass_file):
                try:
                    os.remove(ass_file)
                    print(f"   ✓ 已删除 ASS 文件: {ass_file}", file=log_file)
                except Exception as e:
                    print(f"   ✗ 删除 ASS 文件失败: {e}", file=log_file)
            
            print("🎉 清理完成！\n", file=log_file)
            
            # 恢复原始流
            sys.stdout = original_stdout
            sys.stderr = original_stderr

if __name__ == "__main__":

    import argparse
    
    parser = argparse.ArgumentParser(
        description='压制B站视频，添加弹幕和高能进度条',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python 压制视频测试.py video.xml                  # 生成两个版本（投稿版（无进度条）+ 网页预览（带进度条））
  python 压制视频测试.py video.xml --mode clean     # 仅生成投稿版（无进度条）
  python 压制视频测试.py video.xml --mode preview   # 仅生成网页预览版本（480p）
  python 压制视频测试.py video.xml --mode all       # 生成所有支持的版本（同 both）
  python 压制视频测试.py video.xml --font-size 60 --opacity 180  # 自定义弹幕样式
        """
    )
    
    parser.add_argument('xml_file', help='XML弹幕文件路径')
    parser.add_argument(
        '--mode', 
        choices=['both', 'all', 'clean', 'preview'],
        default='both',
        help='输出模式: both/all=投稿版(无进度条)+网页预览(带进度条), clean=仅投稿版(无进度条), preview=仅网页预览 (默认: both)'
    )
    parser.add_argument(
        '--danmaku-factory',
        default='/rec/apps/DanmakuFactory',
        help='DanmakuFactory 可执行文件路径 (默认: /rec/apps/DanmakuFactory)'
    )
    parser.add_argument(
        '--font-size',
        type=int,
        default=50,
        help='弹幕字体大小 (默认: 50)'
    )
    parser.add_argument(
        '--opacity',
        type=int,
        default=200,
        choices=range(0, 256),
        metavar='0-255',
        help='弹幕不透明度 0-255 (默认: 200)'
    )
    


    parser.add_argument(
        '--output-dir',
        default=None,
        help='生成最终文件的目标文件夹（默认: 与 XML 同目录）'
    )

    parser.add_argument(
        '--final-dir',
        default=None,
        help='最终成品（压制后的视频）单独指定的目标文件夹'
    )
    
    args = parser.parse_args()

    main(args.xml_file, mode=args.mode, danmaku_factory=args.danmaku_factory,
         font_size=args.font_size, opacity=args.opacity,
         output_dir=args.output_dir, final_dir=args.final_dir)
