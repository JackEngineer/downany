"""协议 method 业务处理。"""
from __future__ import annotations

import threading
import uuid
from dataclasses import asdict
from typing import Any, Callable, Dict, List, Optional

from src.core.download_manager import DownloadManager
from src.core.download_task import DownloadOptions, DownloadTask, TaskStatus, VideoInfo
from src.core.url_parser import ParseCancelled, ParseFailed, ParseSession, ParseTimeout
from src.data.database import HistoryDB
from src.data.json_config import JsonConfig
from src.sidecar import ytdlp_updater
from src.sidecar.migration import run_migration
from src.sidecar.paths import AppPaths
from src.sidecar.protocol import ErrorCode, EventName, Method
from src.utils.logger import setup_logger

logger = setup_logger("SidecarHandlers")

EmitEvent = Callable[[str, Dict[str, Any]], None]


class HandlerError(Exception):
    """可映射为协议 error 对象的业务错误。"""

    def __init__(
        self,
        code: ErrorCode,
        message: str,
        *,
        retryable: bool = False,
        details: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.details = details or {}

    def to_dict(self) -> Dict[str, Any]:
        return {
            "code": self.code.value,
            "message": self.message,
            "retryable": self.retryable,
            "details": self.details,
        }


class _ParseJob:
    """可取消的批量解析任务句柄。"""

    def __init__(self) -> None:
        self.cancelled = False
        self.session: Optional[ParseSession] = None
        self.lock = threading.Lock()

    def cancel(self) -> None:
        with self.lock:
            self.cancelled = True
            if self.session is not None:
                self.session.cancel()

    def set_session(self, session: Optional[ParseSession]) -> bool:
        """设置当前会话；若已取消返回 False。"""
        with self.lock:
            if self.cancelled:
                return False
            self.session = session
            return True

    def is_cancelled(self) -> bool:
        with self.lock:
            return self.cancelled


class HandlerContext:
    def __init__(
        self,
        config: JsonConfig,
        db: HistoryDB,
        manager: DownloadManager,
        emit_event: EmitEvent,
        paths: AppPaths,
        *,
        last_migration: Optional[Dict[str, Any]] = None,
    ):
        self.config = config
        self.db = db
        self.manager = manager
        self.emit_event = emit_event
        self.paths = paths
        self.last_migration = last_migration
        self.shutdown_requested = False
        self._parse_jobs: Dict[str, _ParseJob] = {}
        self._parse_lock = threading.Lock()

    def snapshot_task(self, task: DownloadTask) -> Dict[str, Any]:
        return asdict(task.to_snapshot())


def dispatch(ctx: HandlerContext, method: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    payload = payload or {}
    handlers = {
        Method.APP_PING.value: _ping,
        Method.APP_GET_SNAPSHOT.value: _get_snapshot,
        Method.APP_SHUTDOWN.value: _shutdown,
        Method.APP_RUN_MIGRATION.value: _run_migration,
        Method.SETTINGS_GET.value: _settings_get,
        Method.SETTINGS_UPDATE.value: _settings_update,
        Method.DOWNLOAD_CREATE_TASKS.value: _create_tasks,
        Method.DOWNLOAD_PAUSE.value: _pause,
        Method.DOWNLOAD_PAUSE_ALL.value: _pause_all,
        Method.DOWNLOAD_RESUME.value: _resume,
        Method.DOWNLOAD_RESUME_ALL.value: _resume_all,
        Method.DOWNLOAD_CANCEL.value: _cancel,
        Method.DOWNLOAD_RETRY.value: _retry,
        Method.DOWNLOAD_REMOVE.value: _remove,
        Method.DOWNLOAD_CLEAR_FINISHED.value: _clear_finished,
        Method.DOWNLOAD_PARSE_URLS.value: _parse_urls,
        Method.DOWNLOAD_CANCEL_PARSE.value: _cancel_parse,
        Method.HISTORY_LIST.value: _history_list,
        Method.HISTORY_DELETE.value: _history_delete,
        Method.HISTORY_CLEAR.value: _history_clear,
        Method.UPDATER_CHECK_YTDLP.value: _check_ytdlp,
        Method.UPDATER_UPDATE_YTDLP.value: _update_ytdlp,
    }
    handler = handlers.get(method)
    if handler is None:
        raise HandlerError(ErrorCode.METHOD_NOT_FOUND, f"未知方法: {method}")
    return handler(ctx, payload)


def _ping(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    return {"ok": True}


def _get_snapshot(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    tasks = [ctx.snapshot_task(t) for t in ctx.manager.get_all_tasks().values()]
    body: Dict[str, Any] = {"tasks": tasks, "settings": ctx.config.to_dict()}
    if ctx.last_migration is not None:
        body["migration"] = ctx.last_migration
    return body


def _shutdown(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    ctx.manager.stop()
    ctx.shutdown_requested = True
    return {"ok": True}


def _run_migration(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    result = run_migration(ctx.paths)
    ctx.last_migration = result
    return result


def _settings_get(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    return ctx.config.to_dict()


def _settings_update(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    try:
        updated = ctx.config.update_from_dict(payload)
    except ValueError as exc:
        raise HandlerError(ErrorCode.INVALID_PARAMS, str(exc)) from exc
    ctx.emit_event(EventName.SETTINGS_CHANGED.value, {"settings": updated})
    return updated


def _create_tasks(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    urls = payload.get("urls") or []
    if not isinstance(urls, list) or not urls:
        raise HandlerError(ErrorCode.INVALID_PARAMS, "urls 必须是非空数组")
    options = ctx.config.build_download_options()
    task_ids: List[str] = []
    items = payload.get("items")
    for raw in urls:
        url = str(raw or "").strip()
        if not url:
            continue
        title = "未命名视频"
        http_headers = None
        # optional richer items: [{url, title, headers, ...}]
        task_options = options
        if isinstance(items, list):
            for item in items:
                if not isinstance(item, dict) or item.get("url") != url:
                    continue
                if item.get("title"):
                    title = str(item["title"])
                raw_headers = item.get("headers")
                if isinstance(raw_headers, dict) and raw_headers:
                    http_headers = {
                        str(k): str(v)
                        for k, v in raw_headers.items()
                        if k and v is not None and str(v)
                    }
                    if http_headers:
                        task_options = DownloadOptions(
                            format_id=options.format_id,
                            quality=options.quality,
                            download_subtitles=options.download_subtitles,
                            output_path=options.output_path,
                            speed_limit=options.speed_limit,
                            proxy=options.proxy,
                            http_headers=http_headers,
                        )
                    else:
                        http_headers = None
                break
        task = DownloadTask(
            video_info=VideoInfo(url=url, title=title),
            options=task_options,
        )
        ctx.manager.add_task(task)
        task_ids.append(task.id)
    if not task_ids:
        raise HandlerError(ErrorCode.INVALID_PARAMS, "没有有效的 URL")
    return {"taskIds": task_ids}


def _require_task_id(payload: Dict[str, Any]) -> str:
    task_id = str(payload.get("taskId") or payload.get("task_id") or "").strip()
    if not task_id:
        raise HandlerError(ErrorCode.INVALID_PARAMS, "缺少 taskId")
    return task_id


def _pause(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    ctx.manager.pause_task(_require_task_id(payload))
    return {"ok": True}


def _resume(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    ctx.manager.resume_task(_require_task_id(payload))
    return {"ok": True}


def _cancel(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    ctx.manager.cancel_task(_require_task_id(payload))
    return {"ok": True}


def _retry(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    ctx.manager.retry_task(_require_task_id(payload))
    return {"ok": True}


def _remove(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    task_id = _require_task_id(payload)
    ok = ctx.manager.remove_task(task_id)
    if ok:
        ctx.emit_event(EventName.TASK_REMOVED.value, {"taskId": task_id})
    return {"ok": ok}


def _pause_all(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    for task_id, task in list(ctx.manager.get_all_tasks().items()):
        if task.status == TaskStatus.DOWNLOADING:
            ctx.manager.pause_task(task_id)
    return {"ok": True}


def _resume_all(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    for task_id, task in list(ctx.manager.get_all_tasks().items()):
        if task.status == TaskStatus.PAUSED:
            ctx.manager.resume_task(task_id)
    return {"ok": True}


def _clear_finished(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    removed = []
    for task_id, task in list(ctx.manager.get_all_tasks().items()):
        if task.status in (TaskStatus.COMPLETED, TaskStatus.CANCELLED, TaskStatus.FAILED):
            if ctx.manager.remove_task(task_id):
                removed.append(task_id)
                ctx.emit_event(EventName.TASK_REMOVED.value, {"taskId": task_id})
    return {"removed": removed}


def _parse_urls(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    urls = payload.get("urls") or []
    if not isinstance(urls, list) or not urls:
        raise HandlerError(ErrorCode.INVALID_PARAMS, "urls 必须是非空数组")
    parse_id = str(uuid.uuid4())
    proxy = ctx.config.get_proxy_for_download()
    timeout = float(payload.get("timeout") or 30)
    job = _ParseJob()
    with ctx._parse_lock:
        ctx._parse_jobs[parse_id] = job

    def worker():
        try:
            for index, raw in enumerate(urls):
                if job.is_cancelled():
                    break
                url = str(raw or "").strip()
                if not url:
                    ctx.emit_event(
                        EventName.PARSE_RESULT.value,
                        {
                            "parseId": parse_id,
                            "index": index,
                            "url": url,
                            "ok": False,
                            "error": "空链接",
                        },
                    )
                    continue
                session = ParseSession(url, proxy=proxy, timeout=timeout)
                if not job.set_session(session):
                    break
                try:
                    info = session.run()
                    ctx.emit_event(
                        EventName.PARSE_RESULT.value,
                        {
                            "parseId": parse_id,
                            "index": index,
                            "url": url,
                            "ok": True,
                            "info": {
                                "title": info.title,
                                "duration": info.duration,
                                "thumbnail_url": info.thumbnail_url,
                                "uploader": info.uploader,
                                "platform": info.platform.value,
                                "file_size": info.file_size,
                            },
                        },
                    )
                except ParseCancelled:
                    ctx.emit_event(
                        EventName.PARSE_RESULT.value,
                        {
                            "parseId": parse_id,
                            "index": index,
                            "url": url,
                            "ok": False,
                            "cancelled": True,
                        },
                    )
                    break
                except (ParseTimeout, ParseFailed, Exception) as exc:
                    ctx.emit_event(
                        EventName.PARSE_RESULT.value,
                        {
                            "parseId": parse_id,
                            "index": index,
                            "url": url,
                            "ok": False,
                            "error": str(exc),
                        },
                    )
        finally:
            job.set_session(None)
            with ctx._parse_lock:
                ctx._parse_jobs.pop(parse_id, None)

    threading.Thread(target=worker, daemon=True).start()
    return {"parseId": parse_id}


def _cancel_parse(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    parse_id = str(payload.get("parseId") or "").strip()
    if not parse_id:
        raise HandlerError(ErrorCode.INVALID_PARAMS, "缺少 parseId")
    with ctx._parse_lock:
        job = ctx._parse_jobs.get(parse_id)
    if job is not None:
        job.cancel()
    return {"ok": True}


def _history_list(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    offset = int(payload.get("offset") or 0)
    limit = int(payload.get("limit") or 50)
    status = payload.get("status")
    query = payload.get("query")
    records = ctx.db.list_download_records(
        offset=offset,
        limit=limit,
        status=str(status) if status else None,
        query=str(query) if query else None,
    )
    return {
        "items": [
            {
                "id": r.id,
                "url": r.url,
                "title": r.title,
                "platform": r.platform,
                "status": r.status,
                "file_path": r.file_path,
                "file_size": r.file_size,
                "error_message": r.error_message,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in records
        ]
    }


def _history_delete(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    ids = payload.get("ids") or []
    if isinstance(payload.get("id"), str):
        ids = [payload["id"]]
    if not isinstance(ids, list) or not ids:
        raise HandlerError(ErrorCode.INVALID_PARAMS, "缺少 ids")
    deleted = ctx.db.delete_download_records([str(i) for i in ids])
    ctx.emit_event(EventName.HISTORY_CHANGED.value, {"action": "delete", "ids": ids})
    return {"deleted": deleted}


def _history_clear(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    ctx.db.clear_download_history()
    ctx.emit_event(EventName.HISTORY_CHANGED.value, {"action": "clear"})
    return {"ok": True}


def _check_ytdlp(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    try:
        return ytdlp_updater.check_update(ctx.paths)
    except Exception as exc:
        raise HandlerError(ErrorCode.INTERNAL, f"检查 yt-dlp 更新失败: {exc}") from exc


def _update_ytdlp(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    download_url = payload.get("downloadUrl") or payload.get("download_url")
    try:
        return ytdlp_updater.update_ytdlp(
            ctx.paths,
            download_url=str(download_url) if download_url else None,
        )
    except Exception as exc:
        raise HandlerError(ErrorCode.INTERNAL, f"更新 yt-dlp 失败: {exc}") from exc
