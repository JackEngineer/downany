"""telemetry 本地写入测试。"""
import json

from src.data.json_config import JsonConfig
from src.sidecar.telemetry import maybe_report_failure


def test_telemetry_skipped_when_disabled(tmp_path):
    cfg = JsonConfig(str(tmp_path / "config.json"))
    maybe_report_failure(cfg, "need_login", "youtube")
    assert not (tmp_path / "telemetry.jsonl").exists()


def test_telemetry_writes_when_enabled(tmp_path):
    cfg = JsonConfig(str(tmp_path / "config.json"))
    cfg.update_from_dict({"telemetry_enabled": True})
    maybe_report_failure(cfg, "geo_blocked", "bilibili")
    lines = (tmp_path / "telemetry.jsonl").read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert record["error_code"] == "geo_blocked"
    assert record["platform"] == "bilibili"
    assert "ts" in record
