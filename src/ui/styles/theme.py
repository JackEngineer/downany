"""
主题定义和样式管理。
"""
from PyQt6.QtWidgets import QApplication
from PyQt6.QtGui import QPalette, QColor


class Theme:
    """主题颜色定义"""

    # 主色调
    PRIMARY = "#4A90E2"
    PRIMARY_HOVER = "#357ABD"
    PRIMARY_PRESSED = "#2868A8"

    # 背景色
    BACKGROUND = "#F5F7FA"
    CARD_BACKGROUND = "#FFFFFF"

    # 文字颜色
    TEXT_PRIMARY = "#333333"
    TEXT_SECONDARY = "#666666"
    TEXT_DISABLED = "#999999"

    # 边框颜色
    BORDER = "#D1D5DB"
    BORDER_FOCUS = "#4A90E2"

    # 状态颜色
    SUCCESS = "#10B981"
    WARNING = "#F59E0B"
    ERROR = "#EF4444"
    INFO = "#3B82F6"

    # 平台颜色
    YOUTUBE = "#FF0000"
    BILIBILI = "#00A1D6"


def get_qss_style() -> str:
    """获取 QSS 样式表"""
    return f"""
    /* 主窗口 */
    QMainWindow {{
        background-color: {Theme.BACKGROUND};
    }}

    /* 标签页 */
    QTabWidget::pane {{
        border: none;
        background: {Theme.CARD_BACKGROUND};
        border-radius: 8px;
    }}

    QTabBar::tab {{
        padding: 10px 20px;
        margin-right: 5px;
        border-radius: 8px 8px 0 0;
        background: #E8EBF0;
        color: {Theme.TEXT_SECONDARY};
        font-size: 14px;
    }}

    QTabBar::tab:selected {{
        background: {Theme.CARD_BACKGROUND};
        color: {Theme.PRIMARY};
        font-weight: bold;
    }}

    QTabBar::tab:hover {{
        background: #D1D5DB;
    }}

    /* 按钮 */
    QPushButton {{
        background-color: {Theme.PRIMARY};
        color: white;
        border: none;
        border-radius: 6px;
        padding: 8px 16px;
        font-size: 14px;
        min-height: 32px;
    }}

    QPushButton:hover {{
        background-color: {Theme.PRIMARY_HOVER};
    }}

    QPushButton:pressed {{
        background-color: {Theme.PRIMARY_PRESSED};
    }}

    QPushButton:disabled {{
        background-color: #CCCCCC;
        color: {Theme.TEXT_DISABLED};
    }}

    /* 输入框 */
    QLineEdit {{
        border: 1px solid {Theme.BORDER};
        border-radius: 6px;
        padding: 8px 12px;
        background: {Theme.CARD_BACKGROUND};
        color: {Theme.TEXT_PRIMARY};
        font-size: 14px;
    }}

    QLineEdit:focus {{
        border-color: {Theme.BORDER_FOCUS};
    }}

    QTextEdit {{
        border: 1px solid {Theme.BORDER};
        border-radius: 6px;
        padding: 8px 12px;
        background: {Theme.CARD_BACKGROUND};
        color: {Theme.TEXT_PRIMARY};
        font-size: 14px;
    }}

    QTextEdit:focus {{
        border-color: {Theme.BORDER_FOCUS};
    }}

    /* 下拉框 */
    QComboBox {{
        border: 1px solid {Theme.BORDER};
        border-radius: 6px;
        padding: 8px 12px;
        background: {Theme.CARD_BACKGROUND};
        color: {Theme.TEXT_PRIMARY};
        font-size: 14px;
    }}

    QComboBox:focus {{
        border-color: {Theme.BORDER_FOCUS};
    }}

    /* 进度条 */
    QProgressBar {{
        border: 1px solid {Theme.BORDER};
        border-radius: 6px;
        text-align: center;
        background: {Theme.CARD_BACKGROUND};
        height: 24px;
    }}

    QProgressBar::chunk {{
        background-color: {Theme.PRIMARY};
        border-radius: 5px;
    }}

    /* 标签 */
    QLabel {{
        color: {Theme.TEXT_PRIMARY};
        font-size: 14px;
    }}

    /* 分组框 */
    QGroupBox {{
        border: 1px solid {Theme.BORDER};
        border-radius: 8px;
        margin-top: 10px;
        padding: 15px;
        background: {Theme.CARD_BACKGROUND};
        font-weight: bold;
    }}

    QGroupBox::title {{
        subcontrol-origin: margin;
        left: 10px;
        padding: 0 5px;
    }}

    /* 表格 */
    QTableWidget {{
        border: 1px solid {Theme.BORDER};
        border-radius: 6px;
        background: {Theme.CARD_BACKGROUND};
        gridline-color: {Theme.BORDER};
    }}

    QTableWidget::item {{
        padding: 8px;
    }}

    QTableWidget::item:selected {{
        background-color: {Theme.PRIMARY};
        color: white;
    }}

    QHeaderView::section {{
        background-color: #E8EBF0;
        padding: 8px;
        border: none;
        font-weight: bold;
    }}

    /* 搜索详情区 */
    #searchDetailPanel {{
        background: {Theme.CARD_BACKGROUND};
        border: 1px solid {Theme.BORDER};
        border-radius: 8px;
        padding: 10px;
    }}

    #searchDetailTitle {{
        font-size: 16px;
        font-weight: 600;
        color: {Theme.TEXT_PRIMARY};
    }}

    #searchDetailMeta {{
        color: {Theme.TEXT_SECONDARY};
    }}

    #searchDetailUrl {{
        color: {Theme.INFO};
    }}

    #searchDetailThumbnail {{
        border: 1px solid {Theme.BORDER};
        border-radius: 6px;
        background: #EEF2F7;
    }}

    #searchDetailThumbnailStatus,
    #searchPreviewStatus {{
        color: {Theme.TEXT_SECONDARY};
    }}

    /* 搜索结果项 */
    #searchResultThumbnail {{
        background-color: #EEF2F7;
        border: 1px solid {Theme.BORDER};
        border-radius: 4px;
    }}

    #searchResultTitle {{
        color: {Theme.TEXT_PRIMARY};
        font-size: 13px;
        font-weight: 600;
    }}

    #searchResultMeta,
    #searchResultThumbStatus {{
        color: {Theme.TEXT_SECONDARY};
        font-size: 12px;
    }}
    """


def apply_theme(app: QApplication):
    """应用主题到应用程序"""
    app.setStyleSheet(get_qss_style())

