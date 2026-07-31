"""Legacy PyQt entry (frozen). Prefer Electron: npm run desktop."""
import sys
import os
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
_LEGACY = Path(__file__).resolve().parent
# Expose frozen UI as src.ui while keeping core/data from repo root
sys.path.insert(0, str(_ROOT))
# Map legacy/ui -> src.ui via namespace package trick
import types
ui_pkg = types.ModuleType("src.ui")
ui_pkg.__path__ = [str(_LEGACY / "ui")]
sys.modules["src.ui"] = ui_pkg

from PyQt6.QtWidgets import QApplication
from src.data.config_manager import ConfigManager
from src.ui.main_window import MainWindow
from src.ui.styles import apply_theme
from src.ui.fluent_support import setup_fluent_app

def main():
    app = QApplication(sys.argv)
    config = ConfigManager()
    theme_mode = config.get_theme_mode()
    fluent_enabled = setup_fluent_app(app, theme_mode)
    apply_theme(app, theme_mode)
    window = MainWindow(use_fluent=fluent_enabled)
    window.show()
    sys.exit(app.exec())

if __name__ == "__main__":
    main()
