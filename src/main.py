import sys
import os

# 将项目根目录添加到 python path，确保可以导入 src 模块
current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(current_dir)
sys.path.append(project_root)

from PyQt6.QtWidgets import QApplication
from src.data.config_manager import ConfigManager
from src.ui.main_window import MainWindow
from src.ui.styles import apply_theme
from src.ui.fluent_support import setup_fluent_app

def main():
    """
    程序入口函数。
    """
    app = QApplication(sys.argv)
    config = ConfigManager()
    theme_mode = config.get_theme_mode()

    # 优先尝试启用 Fluent；不可用时回退到现有 QSS 主题
    fluent_enabled = setup_fluent_app(app, theme_mode)
    apply_theme(app, theme_mode)

    window = MainWindow(use_fluent=fluent_enabled)
    window.show()

    sys.exit(app.exec())

if __name__ == "__main__":
    main()
