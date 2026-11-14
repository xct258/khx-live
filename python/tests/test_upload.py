"""投稿封装测试：模板渲染、参数检查、成功判定。

用假 biliup 脚本代替真实上传，不访问 B 站。
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from khx.config import UploadConfig
from khx.upload import render_desc, render_title, upload


class UploadTest(unittest.TestCase):
    def test_render_title(self) -> None:
        title = render_title(
            "{date} [{title}]", date="2026年11月13日", title="测试直播", streamer="主播A"
        )
        self.assertEqual(title, "2026年11月13日 [测试直播]")

    def test_render_title_keeps_braces_in_title(self) -> None:
        # 直播标题里自带花括号时不能触发 format 异常
        title = render_title(
            "{date} [{title}]", date="2026-11-13", title="{奇怪}标题", streamer="A"
        )
        self.assertEqual(title, "2026-11-13 [{奇怪}标题]")

    def test_render_desc(self) -> None:
        description = render_desc(
            "平台：{platform}\n弹幕：{danmaku_count}\n封面：{cover_p}P {cover_time}",
            title="t",
            streamer="s",
            platform="录播姬",
            danmaku_count=123,
            cover_time="1小时2分钟3秒",
            cover_p=2,
        )
        self.assertIn("平台：录播姬", description)
        self.assertIn("弹幕：123", description)
        self.assertIn("封面：2P 1小时2分钟3秒", description)

    def test_upload_with_fake_biliup(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fake = root / "biliup"
            fake.write_text("#!/bin/sh\necho \"收到参数: $@\"\necho \"投稿成功\"\n", encoding="utf-8")
            fake.chmod(0o755)

            cookies = root / "cookies.json"
            cookies.write_text("{}", encoding="utf-8")
            video = root / "投稿版-test.mp4"
            video.write_bytes(b"x")

            config = UploadConfig(
                enabled=True,
                biliup=fake,
                cookies=cookies,
                tid=17,
                copyright=2,
                source="https://live.bilibili.com/1",
                tags=["直播回放", "测试"],
                title_template="{date} [{title}]",
                desc_template="",
            )

            result = upload(
                config,
                [video],
                title="2026年11月13日 [测试]",
                description="简介",
            )

            self.assertTrue(result.ok)
            self.assertIn("投稿成功", result.detail)
            self.assertIn("--title", result.detail)
            self.assertIn("--tag", result.detail)

    def test_upload_checks_cookies_first(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fake = root / "biliup"
            fake.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            fake.chmod(0o755)
            video = root / "v.mp4"
            video.write_bytes(b"x")

            config = UploadConfig(
                biliup=fake, cookies=root / "missing.json", title_template="", desc_template=""
            )
            result = upload(config, [video], title="t", description="")

            self.assertFalse(result.ok)
            self.assertIn("cookies", result.detail)


if __name__ == "__main__":
    unittest.main()
