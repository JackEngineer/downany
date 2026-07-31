"""
队列表格 Model/View 与自定义 delegate。
"""
from __future__ import annotations

from typing import List, Optional

from PyQt6.QtCore import QAbstractTableModel, QModelIndex, Qt, QRect, QSize
from PyQt6.QtGui import QColor, QPainter, QPalette
from PyQt6.QtWidgets import QStyledItemDelegate, QStyle, QStyleOptionProgressBar, QStyleOptionViewItem

from src.ui.qt_manager_adapter import QtDownloadManager
from src.core.download_task import DownloadTask, TaskStatus
from src.core.platform_detector import PlatformDetector

TASK_ID_ROLE = Qt.ItemDataRole.UserRole + 1


def format_bytes(value: int) -> str:
  if value <= 0:
    return "0 B"
  units = ["B", "KB", "MB", "GB", "TB"]
  size = float(value)
  for unit in units:
    if size < 1024 or unit == units[-1]:
      if unit == "B":
        return f"{int(size)} {unit}"
      return f"{size:.1f} {unit}"
    size /= 1024
  return f"{value} B"


def status_label_tone(status: TaskStatus) -> tuple[str, str]:
  mapping = {
    TaskStatus.PENDING: ("等待中", "neutral"),
    TaskStatus.DOWNLOADING: ("下载中", "primary"),
    TaskStatus.PAUSED: ("已暂停", "warning"),
    TaskStatus.COMPLETED: ("已完成", "success"),
    TaskStatus.FAILED: ("失败", "error"),
    TaskStatus.CANCELLED: ("已取消", "neutral"),
  }
  return mapping.get(status, ("未知", "neutral"))


def progress_label(task: DownloadTask) -> str:
  percent = int(max(0, min(100, task.progress)))
  if task.total_bytes > 0:
    return f"{percent}% · {format_bytes(task.downloaded_bytes)}/{format_bytes(task.total_bytes)}"
  return f"{percent}%"


class QueueTableModel(QAbstractTableModel):
  """下载队列表格数据模型。"""

  HEADERS = ["平台", "标题", "状态", "进度", "速度", "剩余时间"]

  def __init__(self, download_manager: QtDownloadManager, parent=None):
    super().__init__(parent)
    self.download_manager = download_manager
    self._task_ids: List[str] = []

  def rowCount(self, parent=QModelIndex()) -> int:  # noqa: N802
    if parent.isValid():
      return 0
    return len(self._task_ids)

  def columnCount(self, parent=QModelIndex()) -> int:  # noqa: N802
    if parent.isValid():
      return 0
    return len(self.HEADERS)

  def headerData(self, section, orientation, role=Qt.ItemDataRole.DisplayRole):  # noqa: N802
    if role != Qt.ItemDataRole.DisplayRole:
      return None
    if orientation == Qt.Orientation.Horizontal and 0 <= section < len(self.HEADERS):
      return self.HEADERS[section]
    return None

  def data(self, index: QModelIndex, role=Qt.ItemDataRole.DisplayRole):  # noqa: N802
    if not index.isValid():
      return None

    task = self._task_at(index.row())
    if task is None:
      return None

    column = index.column()
    if role == TASK_ID_ROLE:
      return task.id
    if role == Qt.ItemDataRole.ToolTipRole:
      if column == 1:
        return task.video_info.title
      if column == 2 and task.status == TaskStatus.FAILED:
        return task.error_message or "下载失败"
      if column == 3:
        return progress_label(task)
    if role != Qt.ItemDataRole.DisplayRole:
      return None

    if column == 0:
      return PlatformDetector.get_icon(task.video_info.platform)
    if column == 1:
      return task.video_info.title
    if column == 2:
      return status_label_tone(task.status)[0]
    if column == 3:
      return progress_label(task)
    if column == 4:
      return task.speed
    if column == 5:
      return task.eta
    return None

  def task_id_at(self, row: int) -> str:
    if 0 <= row < len(self._task_ids):
      return self._task_ids[row]
    return ""

  def task_at_row(self, row: int) -> Optional[DownloadTask]:
    return self._task_at(row)

  def _task_at(self, row: int) -> Optional[DownloadTask]:
    task_id = self.task_id_at(row)
    if not task_id:
      return None
    return self.download_manager.get_task(task_id)

  def refresh_structure(self) -> None:
    tasks = self.download_manager.get_all_tasks()
    new_ids = list(tasks.keys())
    if new_ids == self._task_ids:
      if self.rowCount() > 0:
        top_left = self.index(0, 0)
        bottom_right = self.index(self.rowCount() - 1, self.columnCount() - 1)
        self.dataChanged.emit(top_left, bottom_right)
      return

    self.beginResetModel()
    self._task_ids = new_ids
    self.endResetModel()

  def refresh_rows(self) -> None:
    if not self._task_ids:
      return
    top_left = self.index(0, 0)
    bottom_right = self.index(self.rowCount() - 1, self.columnCount() - 1)
    self.dataChanged.emit(top_left, bottom_right)


class StatusDelegate(QStyledItemDelegate):
  """状态列着色 delegate。"""

  TONE_COLORS = {
    "neutral": QColor("#7D8A9A"),
    "primary": QColor("#3F6EF0"),
    "warning": QColor("#C98218"),
    "success": QColor("#1E9B6A"),
    "error": QColor("#D94B4B"),
  }

  def paint(self, painter: QPainter, option: QStyleOptionViewItem, index: QModelIndex) -> None:
    text = index.data(Qt.ItemDataRole.DisplayRole) or ""
    model = index.model()
    task = None
    if isinstance(model, QueueTableModel):
      task = model.task_at_row(index.row())
    tone = "neutral"
    if task is not None:
      tone = status_label_tone(task.status)[1]

    painter.save()
    if option.state & QStyle.StateFlag.State_Selected:
      painter.fillRect(option.rect, option.palette.highlight())
      painter.setPen(option.palette.highlightedText().color())
    else:
      painter.setPen(self.TONE_COLORS.get(tone, self.TONE_COLORS["neutral"]))

    text_rect = option.rect.adjusted(8, 0, -8, 0)
    painter.drawText(text_rect, int(Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft), text)
    painter.restore()

  def sizeHint(self, option: QStyleOptionViewItem, index: QModelIndex) -> QSize:  # noqa: N802
    return QSize(option.rect.width(), 52)


class ProgressDelegate(QStyledItemDelegate):
  """进度列 delegate。"""

  def paint(self, painter: QPainter, option: QStyleOptionViewItem, index: QModelIndex) -> None:
    text = index.data(Qt.ItemDataRole.DisplayRole) or ""
    percent = 0
    model = index.model()
    if isinstance(model, QueueTableModel):
      task = model.task_at_row(index.row())
      if task is not None:
        percent = int(max(0, min(100, task.progress)))

    progress_option = QStyleOptionProgressBar()
    progress_option.rect = option.rect.adjusted(8, 12, -8, -12)
    progress_option.minimum = 0
    progress_option.maximum = 100
    progress_option.progress = percent
    progress_option.text = text
    progress_option.textVisible = True
    progress_option.state = option.state

    style = option.widget.style() if option.widget is not None else None
    if style is not None:
      style.drawControl(QStyle.ControlElement.CE_ProgressBar, progress_option, painter, option.widget)
    else:
      painter.fillRect(progress_option.rect, QColor("#EDF2F7"))
      fill_width = int(progress_option.rect.width() * percent / 100)
      fill_rect = QRect(progress_option.rect.left(), progress_option.rect.top(), fill_width, progress_option.rect.height())
      painter.fillRect(fill_rect, QColor("#3F6EF0"))
      painter.drawText(progress_option.rect, int(Qt.AlignmentFlag.AlignCenter), text)

  def sizeHint(self, option: QStyleOptionViewItem, index: QModelIndex) -> QSize:  # noqa: N802
    return QSize(option.rect.width(), 52)
