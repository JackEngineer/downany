"""
主题定义与样式生成。

提供双主题（浅色 / 深色）以及系统跟随模式的完整 token、QPalette
和 QSS 生成能力。
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Optional

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QColor, QGuiApplication, QPalette
from PyQt6.QtWidgets import QApplication


class ThemeMode(str, Enum):
    """支持的主题模式。"""

    SYSTEM = "system"
    LIGHT = "light"
    DARK = "dark"


# 间距 token
SPACING_XS = 6
SPACING_S = 10
SPACING_M = 14
SPACING_L = 18


@dataclass(frozen=True)
class ThemeTokens:
    """当前主题的设计 token。"""

    mode: ThemeMode
    background: str
    background_soft: str
    surface: str
    surface_alt: str
    surface_elevated: str
    border: str
    border_soft: str
    text: str
    text_secondary: str
    text_muted: str
    accent: str
    accent_hover: str
    accent_pressed: str
    accent_soft: str
    accent_soft_text: str
    success: str
    warning: str
    error: str
    info: str
    selection_bg: str
    selection_text: str
    row_hover: str
    chip_bg: str
    chip_border: str
    chip_text: str


class Theme:
    """主题常量兼容层。"""

    MODE_SYSTEM = ThemeMode.SYSTEM.value
    MODE_LIGHT = ThemeMode.LIGHT.value
    MODE_DARK = ThemeMode.DARK.value

    PRIMARY = "#3F6EF0"
    PRIMARY_HOVER = "#345FE6"
    PRIMARY_PRESSED = "#284FC9"

    BACKGROUND = "#F4F7FB"
    CARD_BACKGROUND = "#FFFFFF"

    TEXT_PRIMARY = "#172033"
    TEXT_SECONDARY = "#536173"
    TEXT_DISABLED = "#8691A1"

    BORDER = "#D9E0EA"
    BORDER_FOCUS = PRIMARY

    SUCCESS = "#1E9B6A"
    WARNING = "#D9891E"
    ERROR = "#D94B4B"
    INFO = "#2E74FF"

    YOUTUBE = "#FF3B30"
    BILIBILI = "#00A1D6"

    @staticmethod
    def normalize_mode(mode: Optional[str]) -> ThemeMode:
        value = (mode or ThemeMode.SYSTEM.value).strip().lower()
        if value == ThemeMode.LIGHT.value:
            return ThemeMode.LIGHT
        if value == ThemeMode.DARK.value:
            return ThemeMode.DARK
        return ThemeMode.SYSTEM

    @staticmethod
    def resolve_mode(mode: Optional[str]) -> ThemeMode:
        normalized = Theme.normalize_mode(mode)
        if normalized != ThemeMode.SYSTEM:
            return normalized
        return detect_system_theme_mode()

    @staticmethod
    def tokens(mode: Optional[str]) -> ThemeTokens:
        return get_theme_tokens(mode)


def rgba(hex_color: str, alpha: float) -> str:
    """将十六进制颜色转成 rgba() 字符串。"""

    color = QColor(hex_color)
    return f"rgba({color.red()}, {color.green()}, {color.blue()}, {alpha:.3f})"


def detect_system_theme_mode() -> ThemeMode:
    """从系统/应用外观推断当前配色方案。"""

    app = QGuiApplication.instance()
    if app is not None and hasattr(app, "styleHints"):
        try:
            color_scheme = app.styleHints().colorScheme()
            if color_scheme == Qt.ColorScheme.Dark:
                return ThemeMode.DARK
            if color_scheme == Qt.ColorScheme.Light:
                return ThemeMode.LIGHT
        except Exception:
            pass

    if app is not None:
        try:
            window_color = app.palette().color(QPalette.ColorRole.Window)
            return ThemeMode.DARK if window_color.lightness() < 128 else ThemeMode.LIGHT
        except Exception:
            pass

    return ThemeMode.LIGHT


def get_theme_tokens(mode: Optional[str]) -> ThemeTokens:
    """根据主题模式获取设计 token。"""

    resolved = Theme.resolve_mode(mode)
    if resolved == ThemeMode.DARK:
        return ThemeTokens(
            mode=resolved,
            background="#0E141B",
            background_soft="#121923",
            surface="#161C24",
            surface_alt="#1A212C",
            surface_elevated="#1E2631",
            border="#2B3542",
            border_soft="#222B36",
            text="#EAF0F6",
            text_secondary="#B5C0CD",
            text_muted="#8592A1",
            accent="#5A84FF",
            accent_hover="#7094FF",
            accent_pressed="#416AF0",
            accent_soft=rgba("#5A84FF", 0.16),
            accent_soft_text="#BED0FF",
            success="#31C48D",
            warning="#F0B44C",
            error="#FF6B6B",
            info="#62A0FF",
            selection_bg=rgba("#5A84FF", 0.24),
            selection_text="#FFFFFF",
            row_hover=rgba("#5A84FF", 0.08),
            chip_bg="#1A2230",
            chip_border="#2C3644",
            chip_text="#DCE4EE",
        )

    return ThemeTokens(
        mode=ThemeMode.LIGHT,
        background="#F4F7FB",
        background_soft="#EDF2F7",
        surface="#FFFFFF",
        surface_alt="#F8FAFD",
        surface_elevated="#FFFFFF",
        border="#D9E0EA",
        border_soft="#E4EAF2",
        text="#172033",
        text_secondary="#536173",
        text_muted="#7D8A9A",
        accent="#3F6EF0",
        accent_hover="#345FE6",
        accent_pressed="#284FC9",
        accent_soft=rgba("#3F6EF0", 0.12),
        accent_soft_text="#2B58D8",
        success="#1E9B6A",
        warning="#C98218",
        error="#D94B4B",
        info="#2E74FF",
        selection_bg=rgba("#3F6EF0", 0.14),
        selection_text="#0F172A",
        row_hover=rgba("#3F6EF0", 0.05),
        chip_bg="#EEF3FA",
        chip_border="#D6DFEA",
        chip_text="#445367",
    )


def build_palette(tokens: ThemeTokens) -> QPalette:
    """构建应用调色板。"""

    palette = QPalette()

    window = QColor(tokens.background)
    surface = QColor(tokens.surface)
    surface_alt = QColor(tokens.surface_alt)
    text = QColor(tokens.text)
    text_secondary = QColor(tokens.text_secondary)
    accent = QColor(tokens.accent)
    selection_bg = QColor(tokens.selection_bg)
    selection_text = QColor(tokens.selection_text)

    palette.setColor(QPalette.ColorRole.Window, window)
    palette.setColor(QPalette.ColorRole.WindowText, text)
    palette.setColor(QPalette.ColorRole.Base, surface)
    palette.setColor(QPalette.ColorRole.AlternateBase, surface_alt)
    palette.setColor(QPalette.ColorRole.Text, text)
    palette.setColor(QPalette.ColorRole.Button, surface_alt)
    palette.setColor(QPalette.ColorRole.ButtonText, text)
    palette.setColor(QPalette.ColorRole.ToolTipBase, surface)
    palette.setColor(QPalette.ColorRole.ToolTipText, text)
    palette.setColor(QPalette.ColorRole.Highlight, accent)
    palette.setColor(QPalette.ColorRole.HighlightedText, selection_text)
    palette.setColor(QPalette.ColorRole.Link, accent)
    palette.setColor(QPalette.ColorRole.LinkVisited, QColor(tokens.accent_pressed))
    palette.setColor(QPalette.ColorRole.BrightText, QColor(tokens.error))
    palette.setColor(QPalette.ColorRole.PlaceholderText, QColor(text_secondary))
    palette.setColor(QPalette.ColorRole.Light, QColor(tokens.border_soft))
    palette.setColor(QPalette.ColorRole.Mid, QColor(tokens.border))

    palette.setColor(QPalette.ColorGroup.Disabled, QPalette.ColorRole.Text, QColor(tokens.text_muted))
    palette.setColor(QPalette.ColorGroup.Disabled, QPalette.ColorRole.ButtonText, QColor(tokens.text_muted))
    palette.setColor(QPalette.ColorGroup.Disabled, QPalette.ColorRole.WindowText, QColor(tokens.text_muted))
    palette.setColor(QPalette.ColorGroup.Disabled, QPalette.ColorRole.Highlight, QColor(tokens.border))
    palette.setColor(QPalette.ColorGroup.Disabled, QPalette.ColorRole.HighlightedText, selection_text)
    palette.setColor(QPalette.ColorGroup.Disabled, QPalette.ColorRole.PlaceholderText, QColor(tokens.text_muted))

    return palette


def build_qss(tokens: ThemeTokens, fluent_enabled: bool = False) -> str:
    """生成应用级 QSS。"""

    selection_bg = tokens.selection_bg
    hover_bg = tokens.row_hover
    accent_soft = tokens.accent_soft
    success_soft = rgba(tokens.success, 0.14)
    warning_soft = rgba(tokens.warning, 0.14)
    error_soft = rgba(tokens.error, 0.14)
    info_soft = rgba(tokens.info, 0.14)
    accent_border = rgba(tokens.accent, 0.28)

    legacy_controls_qss = ""
    if not fluent_enabled:
        legacy_controls_qss = f"""
    QLineEdit,
    QTextEdit,
    QComboBox {{
        background-color: {tokens.surface};
        color: {tokens.text};
        border: 1px solid {tokens.border};
        border-radius: 8px;
        padding: 10px 12px;
        selection-background-color: {tokens.accent};
        selection-color: {tokens.selection_text};
    }}

    QLineEdit:focus,
    QTextEdit:focus,
    QComboBox:focus {{
        border: 1px solid {tokens.accent};
    }}

    QTextEdit {{
        line-height: 1.45;
    }}

    QComboBox::drop-down {{
        border: none;
        width: 28px;
    }}

    QCheckBox {{
        spacing: 8px;
        color: {tokens.text};
    }}

    QCheckBox::indicator {{
        width: 18px;
        height: 18px;
        border-radius: 5px;
        border: 1px solid {tokens.border};
        background: {tokens.surface};
    }}

    QCheckBox::indicator:checked {{
        background: {tokens.accent};
        border-color: {tokens.accent};
    }}

    QCheckBox::indicator:checked:hover {{
        background: {tokens.accent_hover};
        border-color: {tokens.accent_hover};
    }}

    QSpinBox {{
        background-color: {tokens.surface};
        color: {tokens.text};
        border: 1px solid {tokens.border};
        border-radius: 8px;
        padding: 8px 10px;
        min-height: 20px;
    }}

    QSpinBox:focus {{
        border: 1px solid {tokens.accent};
    }}

    QSpinBox::up-button,
    QSpinBox::down-button {{
        width: 18px;
        border: none;
        background: transparent;
    }}

    QPushButton {{
        background-color: {tokens.surface_alt};
        color: {tokens.text};
        border: 1px solid {tokens.border};
        border-radius: 8px;
        padding: 9px 14px;
        min-height: 18px;
        font-weight: 600;
    }}

    QPushButton:hover {{
        background-color: {tokens.background_soft};
        border-color: {tokens.border_soft};
    }}

    QPushButton:pressed {{
        background-color: {tokens.surface_elevated};
        border-color: {tokens.border};
    }}

    QPushButton:disabled {{
        background-color: {tokens.background_soft};
        color: {tokens.text_muted};
        border-color: {tokens.border_soft};
    }}

    QPushButton:focus {{
        border-color: {tokens.accent};
    }}

    QPushButton#primaryActionButton {{
        background-color: {tokens.accent};
        color: #FFFFFF;
        border-color: {tokens.accent};
    }}

    QPushButton#primaryActionButton:hover {{
        background-color: {tokens.accent_hover};
        border-color: {tokens.accent_hover};
    }}

    QPushButton#primaryActionButton:pressed {{
        background-color: {tokens.accent_pressed};
        border-color: {tokens.accent_pressed};
    }}

    QPushButton#primaryActionButton:disabled {{
        background-color: {tokens.background_soft};
        color: {tokens.text_muted};
        border-color: {tokens.border_soft};
    }}

    QPushButton#ghostActionButton {{
        background-color: transparent;
        border-color: {tokens.border_soft};
    }}

    QPushButton#ghostActionButton:hover {{
        background-color: {tokens.background_soft};
    }}
    """

    named_button_qss = f"""
    QPushButton#primaryActionButton {{
        background-color: {tokens.accent};
        color: #FFFFFF;
        border-color: {tokens.accent};
    }}

    QPushButton#primaryActionButton:hover {{
        background-color: {tokens.accent_hover};
        border-color: {tokens.accent_hover};
    }}

    QPushButton#primaryActionButton:pressed {{
        background-color: {tokens.accent_pressed};
        border-color: {tokens.accent_pressed};
    }}

    QPushButton#ghostActionButton {{
        background-color: transparent;
        border-color: {tokens.border_soft};
    }}

    QPushButton#ghostActionButton:hover {{
        background-color: {tokens.background_soft};
    }}
    """

    return f"""
    QWidget#AppShell,
    QMainWindow {{
        background-color: {tokens.background};
        color: {tokens.text};
    }}

    QWidget {{
        color: {tokens.text};
        font-size: 13px;
    }}

    QLabel {{
        color: {tokens.text};
    }}

    QLabel#PageTitle {{
        font-size: 26px;
        font-weight: 700;
        color: {tokens.text};
        letter-spacing: 0;
    }}

    QLabel#PageSubtitle {{
        font-size: 13px;
        color: {tokens.text_secondary};
        line-height: 1.5;
    }}

    QLabel#SectionTitle {{
        font-size: 17px;
        font-weight: 700;
        color: {tokens.text};
    }}

    QLabel#SectionSubtitle {{
        font-size: 12px;
        color: {tokens.text_secondary};
    }}

    QLabel#MetricValue {{
        font-size: 19px;
        font-weight: 700;
        color: {tokens.text};
    }}

    QLabel#MetricLabel {{
        font-size: 11px;
        color: {tokens.text_secondary};
    }}

    QLabel#MetricHint {{
        font-size: 10px;
        color: {tokens.text_muted};
    }}

    QLabel#PageHint {{
        color: {tokens.text_secondary};
        font-size: 12px;
    }}

    QLabel#StatusBadge {{
        border-radius: 999px;
        padding: 3px 9px;
        font-size: 11px;
        font-weight: 600;
        border: 1px solid transparent;
    }}

    QLabel#StatusBadge[tone="neutral"] {{
        background: {tokens.chip_bg};
        color: {tokens.chip_text};
        border-color: {tokens.chip_border};
    }}

    QLabel#StatusBadge[tone="primary"] {{
        background: {accent_soft};
        color: {tokens.accent};
        border-color: {accent_border};
    }}

    QLabel#StatusBadge[tone="success"] {{
        background: {success_soft};
        color: {tokens.success};
        border-color: {rgba(tokens.success, 0.26)};
    }}

    QLabel#StatusBadge[tone="warning"] {{
        background: {warning_soft};
        color: {tokens.warning};
        border-color: {rgba(tokens.warning, 0.26)};
    }}

    QLabel#StatusBadge[tone="error"] {{
        background: {error_soft};
        color: {tokens.error};
        border-color: {rgba(tokens.error, 0.26)};
    }}

    QLabel#StatusBadge[tone="info"] {{
        background: {info_soft};
        color: {tokens.info};
        border-color: {rgba(tokens.info, 0.26)};
    }}

    QLabel#StatusBadge[tone="youtube"] {{
        background: {rgba("#FF3B30", 0.14)};
        color: #FF3B30;
        border-color: {rgba("#FF3B30", 0.26)};
    }}

    QLabel#StatusBadge[tone="bilibili"] {{
        background: {rgba("#00A1D6", 0.14)};
        color: #00A1D6;
        border-color: {rgba("#00A1D6", 0.26)};
    }}

    QLabel#EmptyStateLabel {{
        color: {tokens.text_secondary};
        font-size: 13px;
        padding: 10px 12px;
        background-color: {tokens.surface_alt};
        border: 1px dashed {tokens.border};
        border-radius: 8px;
    }}

    #SectionCard,
    #MetricCard,
    #ToolbarCard,
    #DetailCard,
    #DownloadSummaryCard,
    #SettingsCard,
    #HistorySearchCard,
    #QueueCard,
    #SearchToolbarCard,
    #SearchDetailPanel,
    #PreviewPanel {{
        background-color: {tokens.surface};
        border: 1px solid {tokens.border};
        border-radius: 8px;
    }}

    #SectionCard,
    #ToolbarCard,
    #DetailCard,
    #SearchDetailPanel,
    #PreviewPanel {{
        padding: 16px;
    }}

    #MetricCard {{
        background-color: {tokens.surface_alt};
    }}

    #MetricCard[emphasis="true"] {{
        background-color: {tokens.surface_elevated};
        border-color: {tokens.accent};
    }}

    QWidget#SearchResultItem {{
        background-color: transparent;
        border: 1px solid transparent;
        border-radius: 8px;
    }}

    QWidget#SearchResultItem[selected="true"] {{
        background-color: {selection_bg};
        border-color: {tokens.accent};
    }}

    QWidget#SearchResultItem:hover {{
        background-color: {hover_bg};
        border-color: {tokens.border};
    }}

    QLabel#SearchResultTitle {{
        font-size: 14px;
        font-weight: 700;
        color: {tokens.text};
    }}

    QLabel#SearchResultMeta {{
        font-size: 12px;
        color: {tokens.text_secondary};
    }}

    QLabel#SearchResultThumbStatus {{
        font-size: 11px;
        color: {tokens.text_secondary};
    }}

    QLabel#SearchResultThumbnail,
    QLabel#searchDetailThumbnail {{
        background-color: {tokens.background_soft};
        border: 1px solid {tokens.border_soft};
        border-radius: 8px;
        color: {tokens.text_secondary};
    }}

    QWidget#videoPreviewWidget {{
        background: transparent;
    }}
{legacy_controls_qss}
{named_button_qss}
    QFrame#VideoPreviewStage {{
        background-color: {tokens.background_soft};
        border: 1px solid {tokens.border_soft};
        border-radius: 8px;
    }}

    QFrame#VideoPreviewStage[state="idle"] {{
        border-style: dashed;
    }}

    QFrame#VideoPreviewStage[state="loading"] {{
        background-color: {rgba(tokens.accent, 0.05)};
        border-color: {tokens.accent};
    }}

    QFrame#VideoPreviewStage[state="playing"] {{
        background-color: {tokens.surface_alt};
        border-color: {tokens.border};
    }}

    QFrame#VideoPreviewStage[state="error"] {{
        background-color: {rgba(tokens.warning, 0.06)};
        border-color: {tokens.warning};
    }}

    QStackedWidget#VideoPreviewStack {{
        background: transparent;
    }}

    QWidget#VideoPreviewPlaceholder {{
        background: transparent;
    }}

    QWidget#VideoPreviewVideoPage {{
        background: transparent;
    }}

    QLabel#VideoPreviewTitle {{
        font-size: 15px;
        font-weight: 700;
        color: {tokens.text};
    }}

    QLabel#VideoPreviewHint {{
        font-size: 12px;
        color: {tokens.text_secondary};
    }}

    QFrame#ToastFrame {{
        background-color: {tokens.surface_elevated};
        border: 1px solid {tokens.border};
        border-radius: 10px;
        min-width: 280px;
        max-width: 420px;
    }}

    QFrame#ToastFrame[level="success"] {{
        border-color: {rgba(tokens.success, 0.4)};
    }}

    QFrame#ToastFrame[level="error"] {{
        border-color: {rgba(tokens.error, 0.4)};
    }}

    QFrame#ToastFrame[level="warning"] {{
        border-color: {rgba(tokens.warning, 0.4)};
    }}

    QLabel#ToastTitle {{
        font-size: 14px;
        font-weight: 700;
        color: {tokens.text};
    }}

    QLabel#ToastContent {{
        font-size: 12px;
        color: {tokens.text_secondary};
    }}

    QWidget#EmptyStateWidget {{
        background-color: {tokens.surface_alt};
        border: 1px dashed {tokens.border};
        border-radius: 8px;
    }}

    QLabel#EmptyStateIcon {{
        font-size: 28px;
    }}

    QListWidget {{
        background-color: {tokens.surface};
        color: {tokens.text};
        border: 1px solid {tokens.border};
        border-radius: 8px;
        padding: 8px;
    }}

    QListWidget:focus {{
        border-color: {tokens.accent};
    }}

    QTableWidget:focus {{
        border-color: {tokens.accent};
    }}

    QListWidget::item {{
        background: transparent;
        border: none;
        margin: 0;
        padding: 0;
    }}

    QListWidget::item:selected {{
        background: transparent;
        color: {tokens.text};
    }}

    QProgressBar {{
        background-color: {tokens.background_soft};
        border: 1px solid {tokens.border};
        border-radius: 8px;
        text-align: center;
        color: {tokens.text_secondary};
        height: 22px;
    }}

    QProgressBar::chunk {{
        background-color: {tokens.accent};
        border-radius: 9px;
    }}

    QTableWidget {{
        background-color: {tokens.surface};
        alternate-background-color: {tokens.surface_alt};
        color: {tokens.text};
        border: 1px solid {tokens.border};
        border-radius: 8px;
        gridline-color: {tokens.border_soft};
        selection-background-color: {selection_bg};
        selection-color: {tokens.selection_text};
    }}

    QTableWidget::item {{
        padding: 10px 12px;
        border: none;
    }}

    QTableWidget::item:selected {{
        background-color: {selection_bg};
        color: {tokens.selection_text};
    }}

    QHeaderView::section {{
        background-color: {tokens.surface_alt};
        color: {tokens.text_secondary};
        border: none;
        border-bottom: 1px solid {tokens.border_soft};
        padding: 10px 12px;
        font-weight: 700;
    }}

    QGroupBox {{
        border: 1px solid {tokens.border};
        border-radius: 8px;
        margin-top: 14px;
        padding: 16px;
        background-color: {tokens.surface};
        font-weight: 700;
    }}

    QGroupBox::title {{
        subcontrol-origin: margin;
        left: 14px;
        padding: 0 6px;
        color: {tokens.text_secondary};
    }}

    QTabWidget::pane {{
        border: 1px solid {tokens.border};
        border-radius: 8px;
        background: {tokens.surface};
    }}

    QTabBar::tab {{
        background: {tokens.surface_alt};
        color: {tokens.text_secondary};
        padding: 10px 18px;
        margin-right: 6px;
        border-radius: 8px;
    }}

    QTabBar::tab:selected {{
        background: {tokens.surface};
        color: {tokens.accent};
        font-weight: 700;
    }}

    QTabBar::tab:hover {{
        background: {tokens.background_soft};
    }}

    QScrollBar:vertical {{
        background: transparent;
        width: 10px;
        margin: 4px 2px 4px 2px;
    }}

    QScrollBar::handle:vertical {{
        background: {rgba(tokens.text_secondary, 0.28)};
        min-height: 28px;
        border-radius: 5px;
    }}

    QScrollBar::handle:vertical:hover {{
        background: {rgba(tokens.text_secondary, 0.4)};
    }}

    QScrollBar:horizontal {{
        background: transparent;
        height: 10px;
        margin: 2px 4px 2px 4px;
    }}

    QScrollBar::handle:horizontal {{
        background: {rgba(tokens.text_secondary, 0.28)};
        min-width: 28px;
        border-radius: 5px;
    }}

    QToolTip {{
        background-color: {tokens.surface_elevated};
        color: {tokens.text};
        border: 1px solid {tokens.border};
        border-radius: 10px;
        padding: 6px 10px;
    }}

    QSplitter::handle {{
        background-color: {tokens.border_soft};
    }}
    """


def apply_theme(app: QApplication, theme_mode: Optional[str] = None, fluent_enabled: bool = False) -> ThemeMode:
    """将主题应用到 QApplication。"""

    resolved_mode = Theme.resolve_mode(theme_mode)
    tokens = get_theme_tokens(resolved_mode.value)
    app.setPalette(build_palette(tokens))
    app.setStyleSheet(build_qss(tokens, fluent_enabled=fluent_enabled))
    app.setProperty("themeMode", resolved_mode.value)
    app.setProperty("themeAccent", tokens.accent)
    return resolved_mode


def get_qss_style(theme_mode: Optional[str] = None) -> str:
    """兼容旧接口：返回主题对应的 QSS。"""

    tokens = get_theme_tokens(theme_mode)
    return build_qss(tokens)
