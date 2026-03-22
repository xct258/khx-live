import os
import xml.etree.ElementTree as ET
import subprocess
import sys

WINDOW_SIZE = 30  # 秒
DANMAKU_THRESHOLD = 18
MERGE_GAP = 10

def format_time_float(seconds):
    return f"{seconds:.3f}"

def get_mp4_file(xml_file):
    base, _ = os.path.splitext(xml_file)
    mp4_file = base + '.mp4'
    if not os.path.exists(mp4_file):
        raise FileNotFoundError
    return mp4_file

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

def find_dense_segments(timeline, window_size, threshold):
    n = len(timeline)
    dense_flags = [0] * n
    window_sum = sum(timeline[:window_size])
    for i in range(n - window_size + 1):
        if i > 0:
            window_sum = window_sum - timeline[i - 1] + timeline[i + window_size - 1]
        if window_sum >= threshold:
            for j in range(i, i + window_size):
                if j < n:
                    dense_flags[j] = 1

    segments = []
    in_segment = False
    for i, flag in enumerate(dense_flags):
        if flag and not in_segment:
            seg_start = i
            in_segment = True
        elif not flag and in_segment:
            seg_end = i - 1
            total_danmaku = sum(timeline[seg_start:seg_end + 1])
            segments.append((seg_start, seg_end, total_danmaku))
            in_segment = False
    if in_segment:
        seg_end = n - 1
        total_danmaku = sum(timeline[seg_start:seg_end + 1])
        segments.append((seg_start, seg_end, total_danmaku))
    return segments

def merge_segments(segments, max_gap=10):
    if not segments:
        return []
    segments.sort(key=lambda x: x[0])
    merged = []
    cur_start, cur_end, cur_total = segments[0]
    for start, end, total in segments[1:]:
        if start <= cur_end + max_gap:
            cur_end = max(cur_end, end)
            cur_total += total
        else:
            merged.append((cur_start, cur_end, cur_total))
            cur_start, cur_end, cur_total = start, end, total
    merged.append((cur_start, cur_end, cur_total))
    return merged

def format_time(seconds):
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:02d}"

def format_srt_time(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds - int(seconds)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def extract_segments_and_concat(segment_infos, base_name='top_dense_segments', output_dir='.'):
    clip_files = []
    try:
        for idx, (mp4_file, start, end, _) in enumerate(segment_infos, 1):
            clip_path = os.path.join(output_dir, f'{base_name}_clip{idx}.mp4')
            start_time = format_time_float(start)
            duration = format_time_float(end - start)
            cmd = [
                'ffmpeg', '-y',
                '-ss', start_time,
                '-i', mp4_file,
                '-t', duration,
                '-c', 'copy',
                clip_path
            ]

            subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            clip_files.append(clip_path)

        concat_list = os.path.join(output_dir, f'{base_name}_concat.txt')
        with open(concat_list, 'w', encoding='utf-8') as f:
            for clip in clip_files:
                # 只写文件名，让 ffmpeg 与 concat_list 同目录下查找
                f.write(f"file '{os.path.basename(clip)}'\n")

        output_path = os.path.join(output_dir, f'{base_name}.mp4')
        concat_cmd = [
            'ffmpeg', '-y',
            '-f', 'concat',
            '-safe', '0',
            '-i', concat_list,
            '-c', 'copy',
            output_path
        ]
        subprocess.run(concat_cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        for clip in clip_files:
            os.remove(clip)
        os.remove(concat_list)

        return output_path
    except:
        for clip in clip_files:
            if os.path.exists(clip):
                os.remove(clip)
        if os.path.exists(concat_list):
            os.remove(concat_list)
        return None

def process_xml_file(xml_file, window_size, threshold, merge_gap):
    try:
        times = parse_danmaku(xml_file)
        timeline = build_timeline(times)
        segments = find_dense_segments(timeline, window_size, threshold)
        segments = merge_segments(segments, merge_gap)
        return segments
    except:
        return []

def find_top_segments_from_folder(folder, top_n=5):
    all_segments = []
    for file in os.listdir(folder):
        if file.endswith('.xml'):
            xml_path = os.path.join(folder, file)
            try:
                mp4_path = get_mp4_file(xml_path)
            except:
                continue
            segments = process_xml_file(xml_path, WINDOW_SIZE, DANMAKU_THRESHOLD, MERGE_GAP)
            for seg in segments:
                all_segments.append((xml_path, mp4_path, seg))
    if not all_segments:
        return []
    all_segments.sort(key=lambda x: (os.path.basename(x[0]), x[2][0]))
    top_segments = sorted(all_segments, key=lambda x: x[2][2], reverse=True)[:top_n]
    top_segments.sort(key=lambda x: (os.path.basename(x[0]), x[2][0]))
    return top_segments

def main():
    if len(sys.argv) != 2:
        return

    folder = sys.argv[1]
    top_segments_info = find_top_segments_from_folder(folder, top_n=5)

    if not top_segments_info:
        return

    first_xml = os.path.basename(top_segments_info[0][0])
    first_mp4 = os.path.splitext(first_xml)[0] + '.mp4'
    base_name = f"高能切片版-{os.path.splitext(first_mp4)[0]}"

    all_segments = [(mp4, seg[0], seg[1], seg[2]) for _, mp4, seg in top_segments_info]
    merged_video = extract_segments_and_concat(all_segments, base_name=base_name, output_dir=folder)

    if merged_video:
        print(merged_video)


if __name__ == '__main__':
    main()
