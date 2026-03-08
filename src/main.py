import sys
import os

# 将项目根目录添加到 python path，确保可以导入 src 模块
current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(current_dir)
sys.path.append(project_root)

from PyQt6.QtWidgets import QApplication
from src.ui.main_window import MainWindow
from src.ui.styles import apply_theme

def main():
    """
    程序入口函数。
    """
    app = QApplication(sys.argv)

    # 应用主题
    apply_theme(app)

    window = MainWindow()
    window.show()

    sys.exit(app.exec())

if __name__ == "__main__":
    main()
