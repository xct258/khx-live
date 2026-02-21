import sys
import os
import subprocess
import xml.etree.ElementTree as ET

def parse_danmaku(xml_file):
    tree = ET.parse(xml_file)
    root = tree.getroot()
    times = []
    for d in root.findall('d'):
        p = d.get('p')
        if p:
            try:
                stime = float(p.split(',')[0])
                times.append(int(stime))
            except:
                continue
    return times

def build_timeline(times):
    if not times:
        return []
    max_sec = max(times)
    timeline = [0] * (max_sec + 1)
    for t in times:
        timeline[t] += 1
    return timeline

def extract_frame_ffmpeg(mp4_path, timestamp, output_path):
    cmd = [
        'ffmpeg',
        '-ss', str(timestamp),
        '-i', mp4_path,
        '-frames:v', '1',
        '-q:v', '2',
        '-y',
        output_path
    ]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def is_black_frame(image_path):
    cmd = [
        'ffmpeg',
        '-i', image_path,
        '-vf', 'blackframe',
        '-f', 'null',
        '-'
    ]
    result = subprocess.run(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True
    )
    return 'pblack' in result.stderr

def main():
    if len(sys.argv) < 2:
        print("用法: python extract_hot_frame.py 弹幕文件夹路径")
        return

    folder = sys.argv[1]
    if not os.path.isdir(folder):
        return

    hottest_info = None

    for file in os.listdir(folder):
        if not file.endswith(".xml"):
            continue

        xml_path = os.path.join(folder, file)
        base_name = os.path.splitext(xml_path)[0]
        mp4_path = base_name + ".mp4"

        if not os.path.isfile(mp4_path):
            continue

        times = parse_danmaku(xml_path)
        timeline = build_timeline(times)
        if not timeline:
            continue

        peak_time = timeline.index(max(timeline))
        peak_value = timeline[peak_time]

        if hottest_info is None or peak_value > hottest_info[0]:
            hottest_info = (peak_value, mp4_path, peak_time, base_name)

    if not hottest_info:
        return

    _, mp4_path, peak_time, base_name = hottest_info
    output_img = os.path.join(folder, f"{os.path.basename(base_name)}.jpg")

    # ===== 核心：黑屏就往前推 1 秒 =====
    ts = peak_time + 0.5  # +0.5 避开整秒 GOP 黑帧

    while ts >= 0:
        extract_frame_ffmpeg(mp4_path, ts, output_img)
        if not is_black_frame(output_img):
            print(output_img)
            return
        ts -= 1

    # 如果一路退到 0 秒还全是黑的（极端情况）
    if os.path.exists(output_img):
        os.remove(output_img)

if __name__ == '__main__':
    main()
