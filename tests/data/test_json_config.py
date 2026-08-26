import pytest

import src.data.json_config as json_config
from src.data.json_config import JsonConfig


def test_new_config_defaults_to_dark(tmp_path):
    cfg = JsonConfig(str(tmp_path / "config.json"))
    assert cfg.get_theme_mode() == "dark"


def test_saved_theme_modes_are_preserved(tmp_path):
    for mode in ("light", "dark", "system"):
        path = tmp_path / mode / "config.json"
        path.parent.mkdir()
        path.write_text(f'{{"theme_mode": "{mode}"}}', encoding="utf-8")
        assert JsonConfig(str(path)).get_theme_mode() == mode


def test_defaults_and_roundtrip(tmp_path):
    path = tmp_path / "config.json"
    cfg = JsonConfig(str(path))
    assert cfg.get_concurrent_downloads() == 3
    assert cfg.get_download_dir().endswith("Downloads/Downany") or cfg.get_download_dir().endswith(
        "Downloads\\Downany"
    )
    cfg.set_concurrent_downloads(5)
    cfg.set_theme_mode("dark")
    again = JsonConfig(str(path))
    assert again.get_concurrent_downloads() == 5
    assert again.get_theme_mode() == "dark"


def test_sanitizes_trae_download_dir(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(
        '{"download_dir": "/tmp/TraeDownloader", "concurrent_downloads": 3}',
        encoding="utf-8",
    )
    cfg = JsonConfig(str(path))
    assert "TraeDownloader" not in cfg.get_download_dir()
    assert cfg.get_download_dir().endswith("Downany")


def test_sanitizes_videodownloader_download_dir(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(
        '{"download_dir": "/tmp/VideoDownloader/clips", "concurrent_downloads": 3}',
        encoding="utf-8",
    )
    cfg = JsonConfig(str(path))
    assert "VideoDownloader" not in cfg.get_download_dir()
    assert cfg.get_download_dir().endswith("Downany/clips") or cfg.get_download_dir().endswith(
        "Downany\\clips"
    )


def test_proxy_for_download_none_when_disabled(tmp_path, monkeypatch):
    monkeypatch.setattr(json_config, "detect_system_proxy", lambda: None)
    cfg = JsonConfig(str(tmp_path / "c.json"))
    cfg.set_proxy_enabled(False)
    cfg.set_proxy_url("http://127.0.0.1:7890")
    assert cfg.get_proxy_for_download() is None


def test_proxy_for_download_auto_detects_system_proxy_when_disabled(tmp_path, monkeypatch):
    monkeypatch.setattr(
        json_config,
        "detect_system_proxy",
        lambda: "http://127.0.0.1:7897",
    )
    cfg = JsonConfig(str(tmp_path / "c.json"))

    assert cfg.get_proxy_for_download() == "http://127.0.0.1:7897"


def test_telemetry_enabled_roundtrip(tmp_path):
    cfg = JsonConfig(str(tmp_path / "config.json"))
    updated = cfg.update_from_dict({"telemetry_enabled": True})
    assert updated["telemetry_enabled"] is True
    again = JsonConfig(str(tmp_path / "config.json"))
    assert again.is_telemetry_enabled() is True


def test_update_from_dict_rejects_empty_proxy_when_enabled(tmp_path):
    cfg = JsonConfig(str(tmp_path / "c.json"))
    try:
        cfg.update_from_dict({"proxy_enabled": True, "proxy_url": ""})
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "代理" in str(exc)


def test_invalid_windows_filename_template_does_not_mutate_config(tmp_path):
    path = tmp_path / "config.json"
    cfg = JsonConfig(str(path))
    cfg.update_from_dict({"filename_template": "%(title)s.%(ext)s"})
    before_bytes = path.read_bytes()
    before_data = cfg.to_dict()

    with pytest.raises(ValueError):
        cfg.update_from_dict({"filename_template": r"..\%(title)s.%(ext)s"})

    assert path.read_bytes() == before_bytes
    assert cfg.to_dict() == before_data
