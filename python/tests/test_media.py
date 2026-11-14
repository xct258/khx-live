"""媒体工具测试：文件名解析、弹幕时间、路径转义。

这些测试不需要 ffmpeg，纯解析逻辑。
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from khx.danmaku import escape_filter_path
from khx.media import format_time_cn, last_danmaku_seconds, parse_recording_name

XML_SAMPLE = """<?xml version="1.0" encoding="UTF-8"?>
<i>
  <d p="1.20,1,25,16777215,0,0,0,0">第一条</d>
  <d p="3661.50,1,25,16777215,0,0,0,0">中间</d>
  <d p="7200.75,1,25,16777215,0,0,0,0">最后</d>
</i>
"""


class MediaTest(unittest.TestCase):
    def test_parse_recording_name(self) -> None:
        name = parse_recording_name(
            "录播姬_2026年11月13日19点56分57秒_脚爹TV_高机动持盾军官.flv"
        )
        self.assertEqual(name.platform, "录播姬")
        self.assertEqual(name.start_time, "2026年11月13日19点56分57秒")
        self.assertEqual(name.stream_title, "脚爹TV")
        self.assertEqual(name.streamer, "高机动持盾军官")

    def test_parse_title_with_underscore(self) -> None:
        name = parse_recording_name(
            "录播姬_2026年11月13日19点56分57秒_标题_带下划线_主播名.flv"
        )
        self.assertEqual(name.stream_title, "标题_带下划线")
        self.assertEqual(name.streamer, "主播名")

    def test_parse_rejects_bad_name(self) -> None:
        with self.assertRaises(ValueError):
            parse_recording_name("random.flv")

    def test_last_danmaku_seconds(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            xml = Path(temp) / "a.xml"
            xml.write_text(XML_SAMPLE, encoding="utf-8")
            self.assertAlmostEqual(last_danmaku_seconds(xml) or 0, 7200.75)

    def test_last_danmaku_missing_file(self) -> None:
        self.assertIsNone(last_danmaku_seconds(Path("/nonexistent/a.xml")))

    def test_format_time_cn(self) -> None:
        self.assertEqual(format_time_cn(45), "45秒")
        self.assertEqual(format_time_cn(125), "2分钟5秒")
        self.assertEqual(format_time_cn(3725), "1小时2分钟5秒")

    def test_escape_filter_path(self) -> None:
        escaped = escape_filter_path(Path("/rec/正在处理中/a'b,c:d.ass"))
        self.assertTrue(escaped.startswith("'") and escaped.endswith("'"))
        self.assertIn("\\'", escaped)
        # 中文和绝对路径保持不变
        self.assertIn("/rec/正在处理中/", escaped)


if __name__ == "__main__":
    unittest.main()
