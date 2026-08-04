"""Sidecar ↔ Electron JSON Lines 协议常量（阶段 1 冻结）。"""
from __future__ import annotations

from enum import Enum

PROTOCOL_VERSION = 1
APP_NAME = "Downany"
APP_VERSION = "0.1.0-phase1"


class MessageType(str, Enum):
    REQUEST = "request"
    RESPONSE = "response"
    EVENT = "event"
    HELLO = "hello"


class Method(str, Enum):
    APP_GET_SNAPSHOT = "app.getSnapshot"
    APP_PING = "app.ping"
    APP_SHUTDOWN = "app.shutdown"
    APP_RUN_MIGRATION = "app.runMigration"
    APP_EXPORT_DIAGNOSTICS = "app.exportDiagnostics"
    DOWNLOAD_PARSE_URLS = "download.parseUrls"
    DOWNLOAD_CANCEL_PARSE = "download.cancelParse"
    DOWNLOAD_CREATE_TASKS = "download.createTasks"
    DOWNLOAD_PAUSE = "download.pause"
    DOWNLOAD_PAUSE_ALL = "download.pauseAll"
    DOWNLOAD_RESUME = "download.resume"
    DOWNLOAD_RESUME_ALL = "download.resumeAll"
    DOWNLOAD_CANCEL = "download.cancel"
    DOWNLOAD_RETRY = "download.retry"
    DOWNLOAD_REMOVE = "download.remove"
    DOWNLOAD_REMOVE_GROUP = "download.removeGroup"
    DOWNLOAD_CLEAR_FINISHED = "download.clearFinished"
    DOWNLOAD_UPDATE_TASK = "download.updateTask"
    DOWNLOAD_REORDER = "download.reorder"
    SEARCH_QUERY = "search.query"
    HISTORY_LIST = "history.list"
    HISTORY_DELETE = "history.delete"
    HISTORY_CLEAR = "history.clear"
    SETTINGS_GET = "settings.get"
    SETTINGS_UPDATE = "settings.update"
    UPDATER_CHECK_YTDLP = "updater.checkYtDlp"
    UPDATER_CHECK_HEALTH = "updater.checkHealth"
    UPDATER_UPDATE_YTDLP = "updater.updateYtDlp"


class EventName(str, Enum):
    TASK_ADDED = "task.added"
    TASK_UPDATED = "task.updated"
    TASK_PROGRESS = "task.progress"
    TASK_COMPLETED = "task.completed"
    TASK_FAILED = "task.failed"
    TASK_REMOVED = "task.removed"
    PARSE_RESULT = "download.parseResult"
    SEARCH_RESULT = "search.result"
    HISTORY_CHANGED = "history.changed"
    SETTINGS_CHANGED = "settings.changed"
    SIDECAR_HEALTH = "sidecar.health"


class ErrorCode(str, Enum):
    INVALID_MESSAGE = "INVALID_MESSAGE"
    PROTOCOL_MISMATCH = "PROTOCOL_MISMATCH"
    METHOD_NOT_FOUND = "METHOD_NOT_FOUND"
    NOT_IMPLEMENTED = "NOT_IMPLEMENTED"
    INVALID_PARAMS = "INVALID_PARAMS"
    INTERNAL = "INTERNAL"
