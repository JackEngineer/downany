"""协议 method 业务处理。"""
from __future__ import annotations

import threading
import uuid
from dataclasses import asdict
from typing import Any, Callable, Dict, List, Optional

from src.core.download_manager import DownloadManager
from src.core.download_task import (
    DownloadOptions,
    DownloadTask,
    Platform,
    TaskStatus,
    VideoInfo,
)
from src.core.douyin_url import is_douyin_url, normalize_douyin_url
from src.core.platform_detector import PlatformDetector, normalize_thumbnail_url
from src.core.search_engine import SearchEngine
from src.core.twitter_fallback import is_twitter_url, normalize_twitter_url
from src.core.url_parser import ParseCancelled, ParseFailed, ParseSession, ParseTimeout
from src.data.database import HistoryDB
from src.data.json_config import JsonConfig
from src.sidecar import ytdlp_updater
from src.sidecar.diagnostics import export_diagnostics
from src.sidecar.migration import run_migration
from src.sidecar.paths import AppPaths
from src.sidecar.protocol import ErrorCode, EventName, Method
from src.sidecar.ytdlp_health import check_ytdlp_health
from src.utils.logger import setup_logger

logger = setup_logger("SidecarHandlers")

EmitEvent = Callable[[str, Dict[str, Any]], None]


def _normalize_inbound_url(url: str) -> str:
    """入队前归一化：抖音 modal_id → /video/{id}，Twitter 去跟踪参数。"""
    text = (url or "").strip()
    if not text:
        return text
    if is_douyin_url(text):
        return normalize_douyin_url(text)
    if is_twitter_url(text):
        return normalize_twitter_url(text)
    return text


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
        Method.APP_EXPORT_DIAGNOSTICS.value: _export_diagnostics,
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
        Method.DOWNLOAD_UPDATE_TASK.value: _update_task,
        Method.DOWNLOAD_REORDER.value: _reorder,
        Method.DOWNLOAD_PARSE_URLS.value: _parse_urls,
        Method.DOWNLOAD_CANCEL_PARSE.value: _cancel_parse,
        Method.SEARCH_QUERY.value: _search_query,
        Method.HISTORY_LIST.value: _history_list,
        Method.HISTORY_DELETE.value: _history_delete,
        Method.HISTORY_CLEAR.value: _history_clear,
        Method.UPDATER_CHECK_YTDLP.value: _check_ytdlp,
        Method.UPDATER_CHECK_HEALTH.value: _check_ytdlp_health,
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


def _export_diagnostics(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    try:
        return export_diagnostics(ctx.paths, ctx.manager)
    except Exception as exc:
        raise HandlerError(ErrorCode.INTERNAL, f"导出诊断包失败: {exc}") from exc


def _settings_get(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    return ctx.config.to_dict()


def _settings_update(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    try:
        updated = ctx.config.update_from_dict(payload)
    except ValueError as exc:
        raise HandlerError(ErrorCode.INVALID_PARAMS, str(exc)) from exc
    ctx.emit_event(EventName.SETTINGS_CHANGED.value, {"settings": updated})
    return updated


def _build_item_options(base: DownloadOptions, item: Dict[str, Any]) -> DownloadOptions:
    """以全局选项为底，应用单条目的覆盖项（headers/format/音频/后处理）。"""
    opts = DownloadOptions(
        format_id=base.format_id,
        quality=base.quality,
        download_subtitles=base.download_subtitles,
        output_path=base.output_path,
        speed_limit=base.speed_limit,
        proxy=base.proxy,
        http_headers=base.http_headers,
        audio_only=base.audio_only,
        postprocessing=base.postprocessing,
        postprocessing_pipeline=list(base.postprocessing_pipeline),
        filename_template=base.filename_template,
        postprocess_script=base.postprocess_script,
        cookies_from_browser=base.cookies_from_browser,
        cookiefile=base.cookiefile,
        embed_metadata=base.embed_metadata,
        subtitle_langs=base.subtitle_langs,
        embed_subs=base.embed_subs,
        concurrent_fragments=base.concurrent_fragments,
        download_sections=base.download_sections,
        sponsorblock_remove=base.sponsorblock_remove,
    )
    raw_headers = item.get("headers")
    if isinstance(raw_headers, dict) and raw_headers:
        headers = {
            str(k): str(v)
            for k, v in raw_headers.items()
            if k and v is not None and str(v)
        }
        if headers:
            opts.http_headers = headers
    if item.get("format_id"):
        opts.format_id = str(item["format_id"])
    if item.get("quality"):
        opts.quality = str(item["quality"])
    if item.get("audio_only") is not None:
        opts.audio_only = bool(item["audio_only"])
    if item.get("download_subtitles") is not None:
        opts.download_subtitles = bool(item["download_subtitles"])
    if item.get("postprocessing"):
        postprocessing = str(item["postprocessing"]).strip().lower()
        if postprocessing in {"none", "mp4", "mp3", "script"}:
            opts.postprocessing = postprocessing
    return opts


def _create_tasks(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    urls = payload.get("urls") or []
    if not isinstance(urls, list) or not urls:
        raise HandlerError(ErrorCode.INVALID_PARAMS, "urls 必须是非空数组")
    options = ctx.config.build_download_options()
    task_ids: List[str] = []
    items = payload.get("items")
    for raw in urls:
        original = str(raw or "").strip()
        url = _normalize_inbound_url(original)
        if not url:
            continue
        title = "未命名视频"
        thumbnail_url = ""
        page_url = ""
        # optional richer items: [{url, title, headers, thumbnail_url, format_id, ...}]
        task_options = options
        if isinstance(items, list):
            for item in items:
                if not isinstance(item, dict):
                    continue
                item_raw = str(item.get("url") or "").strip()
                item_norm = _normalize_inbound_url(item_raw)
                if (
                    item_raw != original
                    and item_raw != url
                    and item_norm != url
                ):
                    continue
                if item.get("title"):
                    title = str(item["title"])
                if item.get("thumbnail_url"):
                    thumbnail_url = normalize_thumbnail_url(str(item["thumbnail_url"]))
                if item.get("pageUrl"):
                    page_url = str(item["pageUrl"]).strip()
                elif item.get("page_url"):
                    page_url = str(item["page_url"]).strip()
                task_options = _build_item_options(options, item)
                break

        referer = ""
        if task_options.http_headers and isinstance(task_options.http_headers, dict):
            referer = str(
                task_options.http_headers.get("Referer")
                or task_options.http_headers.get("referer")
                or ""
            ).strip()
        platform = PlatformDetector.detect_with_context(
            url,
            referer=referer or None,
            page_url=page_url or None,
            title=title,
        )
        task = DownloadTask(
            video_info=VideoInfo(
                url=url,
                title=title,
                thumbnail_url=thumbnail_url,
                platform=platform,
            ),
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


def _update_task(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    task_id = _require_task_id(payload)
    kwargs: Dict[str, Any] = {}
    if "title" in payload:
        kwargs["title"] = str(payload["title"])
    if "format_id" in payload:
        value = payload.get("format_id")
        kwargs["format_id"] = str(value) if value else ""
        if not value:
            kwargs["clear_format"] = True
    if "quality" in payload:
        kwargs["quality"] = str(payload["quality"])
    if "audio_only" in payload:
        kwargs["audio_only"] = bool(payload["audio_only"])
    if "postprocessing" in payload:
        postprocessing = str(payload["postprocessing"]).strip().lower()
        if postprocessing not in {"none", "mp4", "mp3", "script"}:
            raise HandlerError(
                ErrorCode.INVALID_PARAMS, "postprocessing 必须是 none/mp4/mp3/script"
            )
        kwargs["postprocessing"] = postprocessing
    if "priority" in payload:
        kwargs["priority"] = int(payload["priority"])
    try:
        task = ctx.manager.update_task(task_id, **kwargs)
    except ValueError as exc:
        raise HandlerError(ErrorCode.INVALID_PARAMS, str(exc)) from exc
    if task is None:
        raise HandlerError(ErrorCode.INVALID_PARAMS, "任务不存在")
    return {"task": ctx.snapshot_task(task)}


def _reorder(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    ordered_ids = payload.get("ordered_ids") or payload.get("orderedIds") or []
    if not isinstance(ordered_ids, list):
        raise HandlerError(ErrorCode.INVALID_PARAMS, "ordered_ids 必须是数组")
    ids = [str(item).strip() for item in ordered_ids if str(item).strip()]
    ctx.manager.reorder_tasks(ids)
    return {"ok": True}


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
    allow_playlist = bool(payload.get("allow_playlist") or payload.get("allowPlaylist"))
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
                session = ParseSession(
                    url,
                    proxy=proxy,
                    timeout=timeout,
                    allow_playlist=allow_playlist,
                )
                if not job.set_session(session):
                    break
                try:
                    result = session.run()
                    info = result.info
                    event_payload: Dict[str, Any] = {
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
                            "formats": info.formats,
                        },
                    }
                    if result.entries:
                        event_payload["entries"] = result.entries
                    ctx.emit_event(EventName.PARSE_RESULT.value, event_payload)
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


def _search_query(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    query = str(payload.get("query") or "").strip()
    if not query:
        raise HandlerError(ErrorCode.INVALID_PARAMS, "缺少 query")
    platform_name = str(payload.get("platform") or "youtube").strip().lower()
    try:
        platform = Platform(platform_name)
    except ValueError as exc:
        raise HandlerError(ErrorCode.INVALID_PARAMS, f"未知平台: {platform_name}") from exc
    if not SearchEngine.supports(platform):
        raise HandlerError(ErrorCode.INVALID_PARAMS, f"平台 {platform_name} 不支持搜索")
    try:
        max_results = int(payload.get("maxResults") or payload.get("max_results") or 10)
    except (TypeError, ValueError):
        max_results = 10
    max_results = max(1, min(max_results, 30))
    proxy = ctx.config.get_proxy_for_download()
    search_id = str(uuid.uuid4())

    def worker():
        try:
            videos = SearchEngine.search(
                platform, query, max_results=max_results, proxy=proxy
            )
            ctx.emit_event(
                EventName.SEARCH_RESULT.value,
                {
                    "searchId": search_id,
                    "ok": True,
                    "query": query,
                    "platform": platform.value,
                    "items": [
                        {
                            "url": v.url,
                            "title": v.title,
                            "duration": v.duration,
                            "thumbnail_url": v.thumbnail_url,
                            "uploader": v.uploader,
                            "platform": v.platform.value,
                        }
                        for v in videos
                    ],
                },
            )
        except Exception as exc:
            logger.warning("搜索失败: %s", exc)
            ctx.emit_event(
                EventName.SEARCH_RESULT.value,
                {
                    "searchId": search_id,
                    "ok": False,
                    "query": query,
                    "platform": platform.value,
                    "error": str(exc),
                },
            )

    threading.Thread(target=worker, daemon=True).start()
    return {"searchId": search_id}


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


def _check_ytdlp_health(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    try:
        return check_ytdlp_health(ctx.paths)
    except Exception as exc:
        raise HandlerError(ErrorCode.INTERNAL, f"检查 yt-dlp 健康状态失败: {exc}") from exc


def _update_ytdlp(ctx: HandlerContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    download_url = payload.get("downloadUrl") or payload.get("download_url")
    try:
        return ytdlp_updater.update_ytdlp(
            ctx.paths,
            download_url=str(download_url) if download_url else None,
        )
    except Exception as exc:
        raise HandlerError(ErrorCode.INTERNAL, f"更新 yt-dlp 失败: {exc}") from exc
