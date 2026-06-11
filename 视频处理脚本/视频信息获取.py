import sys
import os
import subprocess
import xml.etree.ElementTree as ET
import json

def format_seconds(seconds):
    hours = seconds // 3600
    minutes = (seconds % 3600) // 60
    secs = seconds % 60
    if hours > 0:
        return f"{hours}小时{minutes}分钟{secs}秒"
    elif minutes > 0:
        return f"{minutes}分钟{secs}秒"
    else:
        return f"{secs}秒"

def get_xml_info(xml_path):
    tree = ET.parse(xml_path)
    root = tree.getroot()
    count = 0
    timeline = {}
    for d in root.findall('d'):
        p = d.get('p')
        if p:
            try:
                stime = float(p.split(',')[0])
                sec = int(stime)
                timeline[sec] = timeline.get(sec, 0) + 1
                count += 1
            except:
                continue
    peak_time = max(timeline, key=timeline.get) if timeline else 0
    return count, peak_time, timeline

def extract_frame_ffmpeg(video_path, timestamp, output_path):
    cmd = [
        'ffmpeg',
        '-ss', str(timestamp),
        '-i', video_path,
        '-frames:v', '1',
        '-q:v', '2',
        '-y',
        output_path
    ]
    result = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return result.returncode == 0

def is_black_frame(image_path):
    cmd = [
        'ffmpeg',
        '-i', image_path,
        '-vf', 'blackframe=95:2',
        '-f', 'null',
        '-'
    ]
    result = subprocess.run(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True
    )
    return 'black' in result.stderr

def main():
    result = {
        "cover_path": "",
        "danmaku_count": 0,
        "cover_time": "",
        "cover_p": 0
    }

    if len(sys.argv) < 2:
        print(json.dumps(result, ensure_ascii=False))
        return

    folder = sys.argv[1]
    if not os.path.isdir(folder):
        print(json.dumps(result, ensure_ascii=False))
        return

    hottest_info = None
    total_danmaku = 0
    p_num = 0

    for file in sorted(os.listdir(folder)):
        if not file.endswith(".xml"):
            continue

        p_num += 1
        xml_path = os.path.join(folder, file)
        base_name = os.path.splitext(xml_path)[0]

        video_path = None
        for ext in ('.mp4', '.flv'):
            candidate = base_name + ext
            if os.path.isfile(candidate):
                video_path = candidate
                break

        if not video_path:
            continue

        try:
            danmaku_count, peak_time, timeline = get_xml_info(xml_path)
        except Exception:
            continue

        if danmaku_count == 0:
            continue

        total_danmaku += danmaku_count

        peak_value = timeline.get(peak_time, 0)

        if hottest_info is None or peak_value > hottest_info[0]:
            hottest_info = (peak_value, video_path, peak_time, base_name, p_num)

    if not hottest_info:
        result["danmaku_count"] = total_danmaku
        result["cover_p"] = p_num
        print(json.dumps(result, ensure_ascii=False))
        return

    _, video_path, peak_time, base_name, p_num = hottest_info
    result["danmaku_count"] = total_danmaku
    result["cover_p"] = p_num

    output_img = os.path.join(folder, f"{os.path.basename(base_name)}.jpg")

    ts = peak_time + 0.5
    cover_timestamp = int(ts)
    while ts >= 0:
        if not extract_frame_ffmpeg(video_path, ts, output_img):
            ts -= 1
            continue
        if not is_black_frame(output_img):
            result["cover_path"] = output_img
            result["cover_time"] = format_seconds(cover_timestamp)
            print(json.dumps(result, ensure_ascii=False))
            return
        ts -= 1
        cover_timestamp = int(ts)

    if os.path.exists(output_img):
        os.remove(output_img)

    print(json.dumps(result, ensure_ascii=False))

if __name__ == '__main__':
    main()
