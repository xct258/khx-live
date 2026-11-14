"""流水线测试：主播匹配、目录规划、扫描清理、旧录播清理。

不调用 ffmpeg，用空文件模拟视频即可覆盖大部分文件逻辑。
"""

from __future__ import annotations

import logging
import tempfile
import unittest
from datetime import date
from pathlib import Path

from khx.config import load_config
from khx.pipeline import (
    archive_dirs,
    cleanup_archives,
    find_streamer,
    step_scan,
    upload_candidates,
)
from khx.state import Job

CONFIG_TEMPLATE = """
[general]
work_dir = "{root}/work"
videos_dir = "{root}/videos"
data_dir = "{root}/data"
log_dir = "{root}/logs"

[watch]
source_folders = ["{root}/rec"]

[archive]
retention_days = 15

[[streamers]]
id = "a"
name = "主播A"
aliases = ["昵称A"]

[[streamers]]
id = "b"
name = "主播B"
aliases = ["昵称B"]
source_folders = ["{root}/onlyb"]
"""

LOGGER = logging.getLogger("khx.tests")


class PipelineTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.config_path = self.root / "config.toml"
        self.config_path.write_text(
            CONFIG_TEMPLATE.format(root=self.root), encoding="utf-8"
        )
        self.config = load_config(self.config_path)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    # ---- 主播匹配 ----
    def test_find_streamer_by_alias(self) -> None:
        directory = self.root / "rec" / "anything"
        directory.mkdir(parents=True)
        streamer = find_streamer(self.config, "昵称A", directory)
        self.assertIsNotNone(streamer)
        self.assertEqual(streamer.id, "a")

    def test_find_streamer_by_directory_owner(self) -> None:
        directory = self.root / "onlyb" / "2026-11-13"
        directory.mkdir(parents=True)
        streamer = find_streamer(self.config, "未知昵称", directory)
        self.assertIsNotNone(streamer)
        self.assertEqual(streamer.id, "b")

    def test_find_streamer_unknown(self) -> None:
        directory = self.root / "rec" / "2026-11-13"
        directory.mkdir(parents=True)
        self.assertIsNone(find_streamer(self.config, "未配置的主播", directory))

    # ---- 归档目录 ----
    def test_archive_dirs(self) -> None:
        streamer = self.config.streamer_by_id("a")
        assert streamer is not None
        pressed, raw = archive_dirs(
            self.config, streamer, "2026年11月13日19点56分57秒"
        )
        self.assertEqual(
            pressed,
            self.root / "videos" / "主播A" / "压制版" / "2026" / "11" / "2026-11-13",
        )
        self.assertEqual(
            raw,
            self.root / "videos" / "主播A" / "原文件" / "2026" / "11" / "2026-11-13",
        )

    # ---- 扫描与碎片清理 ----
    def test_step_scan_moves_and_cleans(self) -> None:
        source = self.root / "rec" / "2026-11-13"
        source.mkdir(parents=True)

        big = source / "big.mp4"
        with big.open("wb") as handle:
            handle.seek(11 * 1024 * 1024 - 1)
            handle.write(b"\0")

        small = source / "small.flv"
        small.write_bytes(b"x" * 1024)
        (source / "small.xml").write_text("<i/>", encoding="utf-8")
        (source / "orphan.xml").write_text("<i/>", encoding="utf-8")

        job = Job(
            id="a-test",
            streamer_id="a",
            platform="录播姬",
            streamer="主播A",
            stream_title="测试",
            start_time="2026年11月13日19点56分57秒",
            source_dir=str(source),
            work_dir=str(self.root / "work" / "主播A" / "2026年11月13日19点56分57秒"),
        )
        streamer = self.config.streamer_by_id("a")
        assert streamer is not None

        detail, skipped = step_scan(self.config, streamer, job, LOGGER)

        self.assertFalse(skipped)
        self.assertIn("保留 1 个", detail)
        work_dir = Path(job.work_dir)
        self.assertTrue((work_dir / "big.mp4").is_file())
        self.assertFalse((work_dir / "small.flv").exists())
        self.assertFalse((work_dir / "small.xml").exists())
        self.assertFalse((work_dir / "orphan.xml").exists())
        self.assertFalse(source.exists())

    # ---- 投稿文件选择 ----
    def test_upload_candidates_prefers_encoded(self) -> None:
        streamer = self.config.streamer_by_id("a")
        assert streamer is not None

        work_dir = self.root / "work" / "a"
        work_dir.mkdir(parents=True)
        raw = work_dir / "raw.mp4"
        raw.write_bytes(b"x")
        encoded = work_dir / "投稿版-raw.mp4"
        encoded.write_bytes(b"x")

        job = Job(
            id="a-test",
            streamer_id="a",
            platform="录播姬",
            streamer="主播A",
            stream_title="测试",
            start_time="2026年11月13日19点56分57秒",
            source_dir=str(self.root / "src"),
            work_dir=str(work_dir),
        )
        job.outputs["encoded"] = [str(encoded)]

        self.assertEqual(upload_candidates(job, streamer), [encoded])

    # ---- 旧录播清理 ----
    def test_cleanup_archives(self) -> None:
        streamer = self.config.streamer_by_id("a")
        assert streamer is not None

        base = self.root / "videos" / "主播A" / "原文件" / "2000" / "01" / "2000-01-01"
        base.mkdir(parents=True)
        (base / "old.mp4").write_bytes(b"x")

        today = date.today()
        today_dir = (
            self.root
            / "videos"
            / "主播A"
            / "原文件"
            / today.strftime("%Y")
            / today.strftime("%m")
            / today_str()
        )
        today_dir.mkdir(parents=True)
        (today_dir / "new.mp4").write_bytes(b"x")

        deleted = cleanup_archives(self.config, LOGGER)

        self.assertGreaterEqual(deleted, 1)
        self.assertFalse(base.exists())
        self.assertTrue(today_dir.exists())


def today_str() -> str:
    today = date.today()
    return today.strftime("%Y-%m-%d")


if __name__ == "__main__":
    unittest.main()
