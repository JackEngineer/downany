"""yt-dlp 健康检查测试。"""
from src.sidecar.paths import AppPaths
from src.sidecar import ytdlp_health as health


def test_check_ytdlp_health_returns_expected_keys(tmp_path, monkeypatch):
    paths = AppPaths(data_dir=tmp_path / "data", log_dir=tmp_path / "logs").ensure()
    monkeypatch.setattr(health, "current_version", lambda _p: "2024.12.01")
    monkeypatch.setattr(health.shutil, "which", lambda _name: "/usr/bin/deno")

    result = health.check_ytdlp_health(paths)
    assert result == {
        "version": "2024.12.01",
        "deno_available": True,
        "ok": True,
    }


def test_check_ytdlp_health_unknown_version_not_ok(tmp_path, monkeypatch):
    paths = AppPaths(data_dir=tmp_path / "data", log_dir=tmp_path / "logs").ensure()
    monkeypatch.setattr(health, "current_version", lambda _p: "unknown")
    monkeypatch.setattr(health.shutil, "which", lambda _name: None)

    result = health.check_ytdlp_health(paths)
    assert result["ok"] is False
    assert result["deno_available"] is False
