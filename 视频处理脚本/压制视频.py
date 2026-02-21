import numpy as np  # 导入NumPy库，用于数值计算
import matplotlib.pyplot as plt  # 导入Matplotlib库，用于绘图
import subprocess  # 导入subprocess模块，用于执行外部命令
import os  # 导入os模块，用于文件和目录操作
from scipy.interpolate import interp1d  # 导入插值函数，用于平滑数据
from scipy.signal import convolve  # 导入高斯滤波器和卷积函数
from scipy.signal.windows import gaussian  # 导入高斯滤波器和卷积函数
import xml.etree.ElementTree as ET  # 导入ElementTree库，用于解析XML文件
import shutil  # 导入shutil模块，用于文件和目录的高级操作
import matplotlib.collections as mcoll  # 导入用于颜色分段线条绘制

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

# 获取视频文件的时长
def get_video_duration(video_file):
    result = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', video_file],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE  # 执行命令并捕获标准输出和标准错误输出
    )
    return float(result.stdout)  # 返回视频时长，将其从字节转换为浮动数值并返回

# 获取视频的分辨率
def get_video_resolution(video_file):
    result = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', video_file],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE  # 执行命令并捕获输出
    )
    resolution = result.stdout.decode('utf-8').strip().split('x')  # 解析输出的分辨率，去除多余空格并分离宽度和高度
    return int(resolution[0]), int(resolution[1])  # 返回宽度和高度，转换为整数

# 计算弹幕密度
def count_bullet_density(bullet_data, interval=5, lookahead=5, window_size=10):
    max_time = max(bullet_data)  # 获取弹幕数据中的最大时间戳
    time_bins = np.arange(0, max_time + interval, interval)  # 创建时间区间（从0到最大时间，步长为interval）
    
    # 计算每个时间区间内的弹幕数目
    bullet_density = [
        sum(1 for time in bullet_data if start_time <= time < start_time + lookahead)
        for start_time in time_bins[:-1]
    ]
    
    # 使用滑动平均平滑弹幕密度
    smoothed_density = np.convolve(bullet_density, np.ones(window_size)/window_size, mode='same')
    
    return time_bins[:-1], smoothed_density  # 返回时间区间和平滑后的弹幕密度

# 高斯平滑弹幕密度
def smooth_bullet_density(time_bins, bullet_density, window_size=5):
    window = gaussian(window_size, std=window_size/6)  # 创建高斯平滑窗口，std是高斯函数的标准差
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

# 生成视频帧（每10秒生成一张），传入sc和guard时间点
def generate_frames(video_duration, bullet_density_fine, time_fine, frame_interval=10, folder_name='frames', sc_times=None, guard_times=None):
    os.makedirs(folder_name, exist_ok=True)  # 创建保存帧的文件夹，如果不存在则创建
    frame_index = 0  # 初始化帧编号
    # 按时间间隔生成视频帧
    for current_time in np.arange(0, video_duration, frame_interval):
        plot_bullet_density(time_fine, bullet_density_fine, current_time, video_duration,
                            frame_index, folder_name, sc_times=sc_times, guard_times=guard_times)
        frame_index += 1

# 创建视频文件
def create_video(output_file, fps=1, resolution=(1920, 1080), folder_name='frames'):
    subprocess.run([
        'ffmpeg',
        '-framerate', str(fps),
        '-i', f'{folder_name}/frame_%d.png',
        '-c:v', 'png',
        '-pix_fmt', 'rgba',
        '-s', f'{resolution[0]}x{resolution[1]}',
        '-y', output_file
    ])

# 将视频叠加
def overlay_videos(original_video, overlay_video, output_file, ass_file):
    # 尝试使用 QSV 加速压制
    qsv_command = [
        'ffmpeg',
        '-i', original_video,
        '-i', overlay_video,
        '-filter_complex',
        f'[0:v][1:v] overlay=0:0[overlayed]; [overlayed]ass={ass_file}[v]',
        '-map', '[v]',
        '-map', '0:a',
        '-c:v', 'h264_qsv',
        '-b:v', '12M',
        '-preset', 'medium',
        '-c:a', 'copy',
        '-y', output_file
    ]

    result = subprocess.run(qsv_command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # 如果 QSV 加速压制失败，则使用 CPU 压制
    if result.returncode != 0:
        print("QSV 加速压制失败，使用 CPU 压制...")
        cpu_command = [
            'ffmpeg',
            '-i', original_video,
            '-i', overlay_video,
            '-filter_complex',
            f'[0:v][1:v] overlay=0:0[overlayed]; [overlayed]ass={ass_file}[v]',
            '-map', '[v]',
            '-map', '0:a',
            '-c:v', 'libx264',
            '-b:v', '20M',
            '-crf', '23',
            '-profile:v', 'high',
            '-c:a', 'copy',
            '-y', output_file
        ]
        subprocess.run(cpu_command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

# 主函数
def main(xml_file):
    # 解析XML文件，提取弹幕数据
    bullet_data = parse_bullet_xml(xml_file)
    
    # 根据XML文件路径生成视频文件路径
    video_file = os.path.splitext(xml_file)[0] + '.mp4'

    # 根据XML文件路径生成ass文件路径
    ass_file = os.path.splitext(xml_file)[0] + '.ass'

    # 获取视频的时长
    video_duration = get_video_duration(video_file)
    
    # 计算弹幕密度
    time_bins, bullet_density = count_bullet_density(bullet_data)
    
    # 对弹幕密度进行高斯平滑
    time_fine, bullet_density_fine = smooth_bullet_density(time_bins, bullet_density)
    
    # 获取XML文件基本名称（去掉后缀）
    xml_base_name = os.path.splitext(os.path.basename(xml_file))[0]

    # 解析SC和舰长时间点
    sc_times = parse_sc_times(xml_file)
    guard_times = parse_guard_times(xml_file)

    # 生成视频帧文件夹路径
    folder_name = f"{os.path.dirname(xml_file)}/{xml_base_name}_frames"
    generate_frames(video_duration, bullet_density_fine, time_fine,
                    frame_interval=10, folder_name=folder_name,
                    sc_times=sc_times, guard_times=guard_times)  # 每10秒生成一张图表，带高亮SC和舰长

    # 获取视频分辨率
    resolution = get_video_resolution(video_file)
    
    # 创建弹幕密度进度条视频，文件名带“高能进度条-”
    overlay_video_file = f'{os.path.dirname(xml_file)}/高能进度条-{xml_base_name}.mp4'
    create_video(overlay_video_file, fps=1/10, resolution=resolution, folder_name=folder_name)  # 视频帧率每10秒1帧
    
    # 生成最终压制视频输出文件名
    output_file_name = f'{os.path.dirname(xml_file)}/压制版-{xml_base_name}.mp4'

    # 将弹幕密度视频叠加到原始视频上，生成最终视频
    overlay_videos(video_file, overlay_video_file, output_file_name, ass_file)

    # 删除临时生成的帧文件夹和叠加视频文件
    if os.path.exists(folder_name):
        shutil.rmtree(folder_name)
    if os.path.exists(overlay_video_file):
        os.remove(overlay_video_file)

if __name__ == "__main__":
    import sys
    if len(sys.argv) != 2:
        print("用法: python3 script.py <xml_file_path>")
        sys.exit(1)

    xml_file = sys.argv[1]
    main(xml_file)
