from pathlib import Path

from src.sidecar.paths import AppPaths


def test_default_paths_use_downany(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    # Clear override if present
    monkeypatch.delenv("DOWNANY_DATA_DIR", raising=False)
    monkeypatch.delenv("VIDEODL_DATA_DIR", raising=False)
    paths = AppPaths.default()
    assert paths.data_dir.name == "Downany"
    assert paths.config_path.name == "config.json"
    assert paths.history_db_path.name == "history.db"
    assert "Downany" in str(paths.log_dir)


def test_legacy_videodl_data_dir_env(tmp_path, monkeypatch):
    data = tmp_path / "legacy-data"
    monkeypatch.delenv("DOWNANY_DATA_DIR", raising=False)
    monkeypatch.setenv("VIDEODL_DATA_DIR", str(data))
    paths = AppPaths.default()
    assert paths.data_dir == data.resolve()


def test_env_override_data_dir(tmp_path, monkeypatch):
    data = tmp_path / "custom-data"
    monkeypatch.setenv("DOWNANY_DATA_DIR", str(data))
    paths = AppPaths.default()
    assert paths.data_dir == data.resolve()
    assert paths.config_path == data.resolve() / "config.json"
