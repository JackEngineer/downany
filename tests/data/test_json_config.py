from src.data.json_config import JsonConfig


def test_defaults_and_roundtrip(tmp_path):
    path = tmp_path / "config.json"
    cfg = JsonConfig(str(path))
    assert cfg.get_concurrent_downloads() == 3
    assert cfg.get_download_dir().endswith("Downloads/VideoDownloader") or cfg.get_download_dir().endswith(
        "Downloads\\VideoDownloader"
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
    assert cfg.get_download_dir().endswith("VideoDownloader")


def test_proxy_for_download_none_when_disabled(tmp_path):
    cfg = JsonConfig(str(tmp_path / "c.json"))
    cfg.set_proxy_enabled(False)
    cfg.set_proxy_url("http://127.0.0.1:7890")
    assert cfg.get_proxy_for_download() is None


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
