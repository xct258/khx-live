"""任务状态测试：时间解析、JSON 往返、状态流转。"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from khx.state import (
    Job,
    begin,
    date_parts,
    fail,
    finish,
    job_id_from_start_time,
    list_jobs,
    load_job,
    reset_running,
    save_job,
    skip,
)


def make_job() -> Job:
    return Job(
        id="a-2026-11-13_195657",
        streamer_id="a",
        platform="录播姬",
        streamer="主播A",
        stream_title="测试直播",
        start_time="2026年11月13日19点56分57秒",
        source_dir="/tmp/source",
        work_dir="/tmp/work",
    )


class StateTest(unittest.TestCase):
    def test_date_parts(self) -> None:
        self.assertEqual(
            date_parts("2026年11月13日19点56分57秒"),
            ("2026年11月13日", "2026", "11", "2026-11-13"),
        )

    def test_job_id(self) -> None:
        self.assertEqual(
            job_id_from_start_time("2026年11月13日19点56分57秒"),
            "2026-11-13_195657",
        )

    def test_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            job = make_job()
            begin(job, "scan")
            finish(job, "scan", "ok")

            save_job(data_dir, job)
            loaded = load_job(data_dir / "jobs" / f"{job.id}.json")

            self.assertEqual(loaded.id, job.id)
            self.assertEqual(loaded.streamer_id, "a")
            self.assertEqual(loaded.status_of("scan"), "done")
            self.assertEqual(len(list_jobs(data_dir)), 1)

    def test_status_transitions(self) -> None:
        job = make_job()
        begin(job, "encode")
        self.assertEqual(job.status_of("encode"), "running")

        fail(job, "encode", "boom")
        self.assertEqual(job.status_of("encode"), "failed")

        skip(job, "cover", "没有弹幕")
        self.assertEqual(job.status_of("cover"), "skipped")

        # 崩溃残留的 running 要能重置
        job.steps["upload"] = {"status": "running"}
        reset_running(job)
        self.assertEqual(job.status_of("upload"), "pending")


if __name__ == "__main__":
    unittest.main()
