from src.data.json_config import JsonConfig


def test_defaults_and_roundtrip(tmp_path):
    path = tmp_path / "config.json"
    cfg = JsonConfig(str(path))
    assert cfg.get_concurrent_downloads() == 3
    assert cfg.get_download_dir().endswith("Downloads")
    cfg.set_concurrent_downloads(5)
    cfg.set_theme_mode("dark")
    again = JsonConfig(str(path))
    assert again.get_concurrent_downloads() == 5
    assert again.get_theme_mode() == "dark"


def test_proxy_for_download_none_when_disabled(tmp_path):
    cfg = JsonConfig(str(tmp_path / "c.json"))
    cfg.set_proxy_enabled(False)
    cfg.set_proxy_url("http://127.0.0.1:7890")
    assert cfg.get_proxy_for_download() is None


def test_update_from_dict_rejects_empty_proxy_when_enabled(tmp_path):
    cfg = JsonConfig(str(tmp_path / "c.json"))
    try:
        cfg.update_from_dict({"proxy_enabled": True, "proxy_url": ""})
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "代理" in str(exc)
