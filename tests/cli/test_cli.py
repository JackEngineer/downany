from src.cli.__main__ import _build_manager
from src.sidecar.paths import AppPaths
from src.sidecar.telegram_delivery_service import TelegramDeliveryService


def test_cli_manager_wires_the_persistent_telegram_output_sink(tmp_path):
    paths = AppPaths(data_dir=tmp_path / "data", log_dir=tmp_path / "logs").ensure()

    manager, _config = _build_manager(paths)
    try:
        assert isinstance(manager.output_ready_sink, TelegramDeliveryService)
    finally:
        manager.stop()
