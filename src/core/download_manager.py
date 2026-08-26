"""
下载管理器，负责任务队列和并发控制。
"""
from __future__ import annotations

import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional, Set

from src.core.download_task import (
    DownloadOptions,
    DownloadTask,
    Platform,
    TaskSnapshot,
    TaskStatus,
    VideoInfo,
)
from src.core.error_codes import (
    MediaToolsMissing,
    OutputPathInvalid,
    OutputVerificationFailed,
    classify_download_error,
)
from src.core.douyin_url import is_douyin_url, normalize_douyin_url
from src.core.downloader import (
    DownloadCancelled,
    Downloader,
    SourceFacts,
)
from src.core.events import EventEmitter
from src.core.interfaces import DownloadConfig, HistoryWriter, OutputReadySink
from src.core.local_thumbnail import ensure_local_thumbnail
from src.core.media_verifier import VerificationExpectation, verify_media
from src.core.output_commit import (
    commit_output_bundle,
    rollback_committed_output,
)
from src.core.output_contract import MediaKind, OutputPlan, SubtitleMode, compile_output_plan
from src.core.platform_detector import (
    PlatformDetector,
    normalize_thumbnail_url,
    pick_thumbnail_from_ydl_info,
)
from src.core.title_utils import is_weak_title, pick_title_from_ydl_info
from src.core.url_normalizer import normalize_download_url
from src.core.video_info_extractor import VideoInfoExtractor
from src.data.models import DownloadRecord
from src.data.queue_store import QueueStore
from src.sidecar.bin_paths import resolve_media_toolchain
from src.utils.logger import setup_logger

logger = setup_logger("DownloadManager")

_PLACEHOLDER_TITLES = {"正在获取信息...", "未命名视频", ""}

_OUTPUT_PATH_MESSAGE = "下载位置或文件名不可用"
_MEDIA_TOOLS_MESSAGE = "媒体工具不完整，请重新安装"
_OUTPUT_VERIFICATION_MESSAGE = "成品无法验证，请导出诊断后重试"

_MEDIA_URL_RE = re.compile(
    r"\.(m3u8|mpd|mp4|webm|mkv|mov|m4v|mp3|m4a|aac|flac|ogg|wav)(?:[?#]|$)",
    re.IGNORECASE,
)


def _referer_page_url(task: DownloadTask) -> str:
    """扩展嗅探直链时，从 Referer 取可解析的页面 URL（用于补封面/平台）。"""
    headers = task.options.http_headers or {}
    if not isinstance(headers, dict):
        return ""
    referer = str(headers.get("Referer") or headers.get("referer") or "").strip()
    if not referer or _MEDIA_URL_RE.search(referer):
        return ""
    if PlatformDetector.detect(referer) == Platform.UNKNOWN:
        return ""
    return referer


def _pick_uploader_from_ydl_info(info: dict) -> str:
    return str(
        info.get("uploader")
        or info.get("channel")
        or info.get("creator")
        or info.get("uploader_id")
        or ""
    ).strip()


def sanitize_filename(name: str, fallback: str = "video") -> str:
    """把任务标题转成安全文件名（去掉路径与保留字符，限长）。"""
    cleaned = re.sub(r'[\\/:*?"<>|]', " ", name).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned[:80] or fallback


def format_postprocess_command(script: str, file_path: str) -> str:
    if sys.platform == "win32":
        quoted = subprocess.list2cmdline([file_path])
    else:
        quoted = shlex.quote(file_path)
    if "{file}" in script:
        return script.format(file=quoted)
    return f"{script} {quoted}"


def _postprocessor_keys(plan: OutputPlan) -> frozenset[str]:
    return frozenset(
        str(item.get("key") or "").strip()
        for item in plan.postprocessors
        if isinstance(item, Mapping)
    )


def _verification_expectation(
    plan: OutputPlan,
    facts: SourceFacts,
) -> VerificationExpectation:
    """Build only the checks requested by the plan and supported by the source."""
    keys = _postprocessor_keys(plan)
    metadata_requested = "FFmpegMetadata" in keys
    embedded_subtitles = (
        plan.media_kind is MediaKind.VIDEO
        and plan.subtitle_mode in {SubtitleMode.EMBEDDED, SubtitleMode.BOTH}
    )
    return VerificationExpectation(
        media_kind=plan.media_kind,
        allowed_containers=plan.allowed_containers,
        require_title=metadata_requested and facts.title_available,
        require_cover="EmbedThumbnail" in keys and facts.thumbnail_available,
        require_chapters=metadata_requested and facts.chapters_available,
        embedded_subtitle_languages=(
            facts.selected_subtitle_languages if embedded_subtitles else ()
        ),
    )


def _is_inside(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def _verify_external_subtitles(paths: tuple[Path, ...], root: Path) -> None:
    """Require every retained subtitle to be contained, regular, and non-empty."""
    try:
        resolved_root = Path(root).expanduser().resolve(strict=True)
    except (OSError, RuntimeError, ValueError) as exc:
        raise OutputVerificationFailed(_OUTPUT_VERIFICATION_MESSAGE) from exc
    for raw_path in paths:
        try:
            path = Path(raw_path).expanduser().resolve(strict=True)
            if (
                not _is_inside(resolved_root, path)
                or not path.is_file()
                or path.stat().st_size <= 0
            ):
                raise OutputVerificationFailed(_OUTPUT_VERIFICATION_MESSAGE)
        except OutputVerificationFailed:
            raise
        except (OSError, RuntimeError, ValueError) as exc:
            raise OutputVerificationFailed(_OUTPUT_VERIFICATION_MESSAGE) from exc


def _completion_note(plan: OutputPlan, facts: SourceFacts) -> str:
    notes = [str(plan.completion_note or "").strip()]
    if facts.missing_requested_subtitles:
        notes.append(
            "未找到所选语言字幕"
            if plan.requested_subtitle_languages
            else "未找到可用字幕"
        )
    return "；".join(note for note in notes if note)


def _safe_contract_error(exc: BaseException) -> tuple[str, str]:
    if isinstance(exc, OutputPathInvalid):
        return exc.error_code, _OUTPUT_PATH_MESSAGE
    if isinstance(exc, MediaToolsMissing):
        return exc.error_code, _MEDIA_TOOLS_MESSAGE
    if isinstance(exc, OutputVerificationFailed):
        return exc.error_code, _OUTPUT_VERIFICATION_MESSAGE
    return classify_download_error(exc), str(exc)


class DownloadManager:
    """下载管理器（Qt 无关）。事件通过 self.events 分发。"""

    def __init__(
        self,
        config: DownloadConfig,
        db: HistoryWriter,
        queue_store: Optional[QueueStore] = None,
        temp_dir: Optional[str] = None,
        output_ready_sink: Optional[OutputReadySink] = None,
    ):
        self.config = config
        self.db = db
        self.queue_store = queue_store
        configured_temp = (temp_dir or "").strip()
        self.temp_dir = configured_temp or str(
            Path(tempfile.gettempdir()) / "Downany" / "staging"
        )
        self.output_ready_sink = output_ready_sink
        self.events = EventEmitter()
        self._last_progress_persist: Dict[str, float] = {}

        self._lock = threading.RLock()
        self.tasks: Dict[str, DownloadTask] = {}
        self.active_tasks: Dict[str, threading.Thread] = {}
        self._resume_requested: Set[str] = set()

        self.scheduler_thread: Optional[threading.Thread] = None
        self.running = False

        logger.info("下载管理器初始化完成")

    def restore_tasks(self) -> None:
        """从队列存储恢复任务。下载中降级为已暂停；等待中重新入队。"""
        if self.queue_store is None:
            return
        restored = self.queue_store.load_tasks()
        downgraded = []
        with self._lock:
            for task in restored:
                if task.status == TaskStatus.DOWNLOADING:
                    task.status = TaskStatus.PAUSED
                    downgraded.append(task)
                self.tasks[task.id] = task
        for task in downgraded:
            self._persist(task)
        if restored:
            logger.info(f"从数据库恢复 {len(restored)} 个任务")

    def start(self):
        """启动调度器"""
        with self._lock:
            if self.running:
                return
            self.running = True
            self.scheduler_thread = threading.Thread(target=self._scheduler_loop, daemon=True)
            self.scheduler_thread.start()
        logger.info("调度器已启动")

    def stop(self, join_timeout: float = 5.0):
        """停止调度器。下载中的任务中断并标记为已暂停（保留半成品，可续传）。"""
        paused_tasks = []
        with self._lock:
            self.running = False
            for task in self.tasks.values():
                if task.status == TaskStatus.DOWNLOADING:
                    task.status = TaskStatus.PAUSED
                    paused_tasks.append(task)
            threads = list(self.active_tasks.values())
            scheduler = self.scheduler_thread

        for task in paused_tasks:
            self._persist(task)

        if scheduler and scheduler.is_alive():
            scheduler.join(timeout=join_timeout)

        for thread in threads:
            if thread.is_alive():
                thread.join(timeout=join_timeout)

        logger.info("调度器已停止")

    def _persist(self, task: DownloadTask) -> bool:
        """把任务当前状态写入队列存储；失败只记日志，不影响下载。"""
        if self.queue_store is None:
            return True
        # 已被 force 移除的任务：下载线程收尾时可能仍会调用 _persist，勿写回库
        with self._lock:
            if task.id not in self.tasks:
                return False
        try:
            self.queue_store.upsert_task(task)
            return True
        except Exception as exc:
            logger.error(f"持久化任务失败 {task.id}: {exc}")
            return False

    def _refresh_task_proxy(self, task: DownloadTask) -> None:
        """任务真正执行前补齐当前配置中的系统代理。"""
        if (task.options.proxy or "").strip():
            return
        getter = getattr(self.config, "get_proxy_for_download", None)
        if not callable(getter):
            return
        try:
            proxy = getter()
        except Exception as exc:
            logger.warning("读取下载代理失败: %s", exc)
            return
        if not isinstance(proxy, str):
            return
        proxy = proxy.strip()
        if not proxy:
            return
        task.options.proxy = proxy
        logger.info("任务已自动配置系统代理")

    def _refresh_retry_recovery_options(self, task: DownloadTask) -> None:
        """重试时采用当前登录状态与代理，同时保留任务自身的下载选项。"""
        builder = getattr(self.config, "build_download_options", None)
        if not callable(builder):
            self._refresh_task_proxy(task)
            return
        try:
            current = builder(output_path=task.options.output_path)
        except Exception as exc:
            logger.warning("读取当前恢复设置失败: %s", exc)
            self._refresh_task_proxy(task)
            return
        if not isinstance(current, DownloadOptions):
            self._refresh_task_proxy(task)
            return
        task.options.proxy = current.proxy
        task.options.cookies_from_browser = current.cookies_from_browser
        logger.info("重试任务已刷新登录状态与代理设置")

    def _normalize_task_url(self, task: DownloadTask) -> None:
        normalized = normalize_download_url(task.video_info.url)
        if normalized == task.video_info.url:
            return
        task.video_info.url = normalized
        logger.info("已修复任务 URL: %s", normalized)

    def _persist_remove(self, task_id: str) -> None:
        if self.queue_store is None:
            return
        try:
            self.queue_store.remove_task(task_id)
        except Exception as exc:
            logger.error(f"删除持久化任务失败 {task_id}: {exc}")

    def _delete_task_file(self, file_path: str) -> bool:
        path = (file_path or "").strip()
        if not path or not os.path.isfile(path):
            return False
        try:
            os.remove(path)
            parent = os.path.dirname(path)
            # 合集子文件夹若已空则一并去掉，避免留下空目录
            if parent and os.path.isdir(parent) and not os.listdir(parent):
                try:
                    os.rmdir(parent)
                except OSError:
                    pass
            return True
        except OSError as exc:
            logger.warning("删除本地文件失败 %s: %s", path, exc)
            return False

    def remove_task(
        self,
        task_id: str,
        *,
        delete_files: bool = False,
        force: bool = False,
    ) -> bool:
        """从列表移除任务。

        默认只移除已结束任务。force=True 时会先标为取消并从队列摘除
        （进行中线程收尾不再写回）。delete_files 仅删除该任务 file_path。
        """
        file_path = ""
        with self._lock:
            task = self.tasks.get(task_id)
            if not task:
                return False
            if not force:
                if task.status in (
                    TaskStatus.DOWNLOADING,
                    TaskStatus.PENDING,
                    TaskStatus.PAUSED,
                ):
                    return False
                if task_id in self.active_tasks:
                    return False
            else:
                if task.status not in (
                    TaskStatus.COMPLETED,
                    TaskStatus.FAILED,
                    TaskStatus.CANCELLED,
                ):
                    task.status = TaskStatus.CANCELLED
            file_path = task.file_path or ""
            self.tasks.pop(task_id, None)
        self._persist_remove(task_id)
        if delete_files and file_path:
            self._delete_task_file(file_path)
        return True

    def remove_group(
        self,
        group_id: str,
        *,
        delete_files: bool = False,
    ) -> List[str]:
        """移除同一 group_id 下全部任务，返回成功移除的 id 列表。"""
        gid = (group_id or "").strip()
        if not gid:
            return []
        with self._lock:
            ids = [
                task.id
                for task in self.tasks.values()
                if (task.group_id or "").strip() == gid
            ]
        removed: List[str] = []
        for task_id in ids:
            if self.remove_task(task_id, delete_files=delete_files, force=True):
                removed.append(task_id)
        return removed

    def add_task(self, task: DownloadTask):
        """添加任务到队列"""
        with self._lock:
            max_order = max((t.queue_order for t in self.tasks.values()), default=-1)
            task.queue_order = max_order + 1
            self.tasks[task.id] = task
        self._persist(task)
        self.events.emit("task_added", {"task_id": task.id})
        logger.info(f"添加任务: {task.video_info.title}")

    def pause_task(self, task_id: str):
        """暂停任务（中断当前下载；恢复时重新入队）。"""
        with self._lock:
            task = self.tasks.get(task_id)
            if not task or task.status != TaskStatus.DOWNLOADING:
                return
            task.status = TaskStatus.PAUSED
        self._persist(task)
        self.events.emit("task_paused", {"task_id": task_id})
        logger.info(f"暂停任务: {task.video_info.title}")

    def resume_task(self, task_id: str):
        """恢复暂停任务；若旧下载线程仍在收尾则等 finally 再入队。"""
        with self._lock:
            task = self.tasks.get(task_id)
            if not task or task.status != TaskStatus.PAUSED:
                return
            if task_id in self.active_tasks:
                self._resume_requested.add(task_id)
                logger.info(f"恢复任务等待旧线程退出: {task.video_info.title}")
                return
            task.status = TaskStatus.PENDING
            task.error_message = ""
            task.error_code = ""
        self._persist(task)
        logger.info(f"恢复任务: {task.video_info.title}")

    def cancel_task(self, task_id: str):
        """取消任务"""
        with self._lock:
            task = self.tasks.get(task_id)
            if not task:
                return
            if task.status in (TaskStatus.COMPLETED, TaskStatus.CANCELLED):
                return
            task.status = TaskStatus.CANCELLED
        self._persist(task)
        self.events.emit("task_cancelled", {"task_id": task_id})
        logger.info(f"取消任务: {task.video_info.title}")

    def retry_task(self, task_id: str):
        """重试失败的任务"""
        with self._lock:
            task = self.tasks.get(task_id)
            if not task or task.status != TaskStatus.FAILED:
                return
            if task_id in self.active_tasks:
                return
            self._refresh_retry_recovery_options(task)
            self._normalize_task_url(task)
            task.status = TaskStatus.PENDING
            task.error_message = ""
            task.error_code = ""
            task.completion_note = ""
            task.progress = 0.0
            task.downloaded_bytes = 0
            task.total_bytes = 0
        self._persist(task)
        logger.info(f"重试任务: {task.video_info.title}")

    def get_task(self, task_id: str) -> Optional[DownloadTask]:
        with self._lock:
            return self.tasks.get(task_id)

    def get_all_tasks(self) -> Dict[str, DownloadTask]:
        with self._lock:
            return dict(self.tasks)

    def get_snapshot(self) -> List[TaskSnapshot]:
        """所有任务的不可变快照（锁内构建，锁外安全使用）。"""
        with self._lock:
            return [task.to_snapshot() for task in self.tasks.values()]

    def update_task(
        self,
        task_id: str,
        *,
        title: Optional[str] = None,
        format_id: Optional[str] = None,
        clear_format: bool = False,
        quality: Optional[str] = None,
        audio_only: Optional[bool] = None,
        postprocessing: Optional[str] = None,
        priority: Optional[int] = None,
    ) -> Optional[DownloadTask]:
        """
        更新任务选项 / 重命名。下载中的任务不允许改下载选项（可先暂停）。
        已完成任务重命名会同步改磁盘文件名。
        """
        with self._lock:
            task = self.tasks.get(task_id)
            if not task:
                return None

            touches_options = any(
                value is not None
                for value in (format_id, quality, audio_only, postprocessing)
            ) or clear_format
            if touches_options and task.status == TaskStatus.DOWNLOADING:
                raise ValueError("下载进行中，请先暂停再修改选项")

            if title is not None:
                new_title = title.strip() or task.video_info.title
                if task.status == TaskStatus.COMPLETED and task.file_path:
                    task.file_path = self._rename_output_file(task, new_title)
                task.video_info.title = new_title

            if touches_options:
                if clear_format:
                    task.options.format_id = None
                if format_id is not None:
                    task.options.format_id = format_id or None
                if quality is not None:
                    task.options.quality = quality
                if audio_only is not None:
                    task.options.audio_only = audio_only
                if postprocessing is not None:
                    task.options.postprocessing = postprocessing

            if priority is not None:
                task.priority = int(priority)

        self._persist(task)
        self.events.emit("task_updated", {"task_id": task.id})
        return task

    def reorder_tasks(self, ordered_ids: List[str]) -> bool:
        """按 ordered_ids 重写 queue_order；未列出的任务排在末尾。"""
        with self._lock:
            seen: Set[str] = set()
            for idx, task_id in enumerate(ordered_ids):
                task = self.tasks.get(task_id)
                if not task:
                    continue
                task.queue_order = idx
                seen.add(task_id)
            next_order = len(seen)
            for task in sorted(
                self.tasks.values(), key=lambda t: (t.queue_order, t.created_at)
            ):
                if task.id in seen:
                    continue
                task.queue_order = next_order
                next_order += 1
            tasks_to_persist = list(self.tasks.values())
        for task in tasks_to_persist:
            self._persist(task)
        self.events.emit("tasks_reordered", {})
        return True

    def _rename_output_file(self, task: DownloadTask, new_title: str) -> str:
        """已完成任务改名：同步重命名磁盘文件（保留扩展名）。"""
        old_path = task.file_path
        try:
            directory = os.path.dirname(old_path)
            ext = os.path.splitext(old_path)[1]
            candidate = os.path.join(directory, f"{sanitize_filename(new_title)}{ext}")
            if candidate == old_path:
                return old_path
            if os.path.exists(old_path) and not os.path.exists(candidate):
                os.rename(old_path, candidate)
                return candidate
        except OSError as exc:
            logger.error(f"重命名输出文件失败 {old_path}: {exc}")
        return old_path

    def _run_postprocess_script(self, task: DownloadTask) -> bool:
        """执行用户自定义后处理脚本，并返回是否完成。"""
        script = (task.options.postprocess_script or "").strip()
        if not script:
            logger.warning("任务配置了脚本后处理但脚本为空: %s", task.id)
            return False
        command = format_postprocess_command(script, task.file_path)
        logger.info(f"执行后处理脚本: {command}")
        try:
            result = subprocess.run(
                command,
                shell=True,
                timeout=600,
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                logger.error(
                    f"后处理脚本退出码 {result.returncode}: {result.stderr.strip()[:500]}"
                )
                return False
            return True
        except Exception as exc:
            logger.error(f"后处理脚本执行失败: {exc}")
            return False

    def _cleanup_staging_dir(self, staging_dir: Path, temp_root: Path) -> None:
        """Delete only the verified direct child owned by this task."""
        try:
            root = Path(temp_root).expanduser().resolve(strict=True)
            raw_staging = Path(staging_dir).expanduser()
            if raw_staging.is_symlink():
                raise OSError("staging directory is a symbolic link")
            staging = raw_staging.resolve(strict=True)
            if staging.parent != root or not staging.is_dir():
                raise OSError("staging directory is outside the task temp root")
            shutil.rmtree(staging)
        except FileNotFoundError:
            return
        except (OSError, RuntimeError, ValueError) as exc:
            logger.warning("任务暂存目录清理失败 %s: %s", staging_dir.name, exc)

    def _pick_next_pending_locked(self) -> Optional[DownloadTask]:
        """锁内调用：queue_order 升序，再 priority 降序，再创建时间早优先。"""
        candidates = [
            task
            for task in self.tasks.values()
            if task.status == TaskStatus.PENDING and task.id not in self.active_tasks
        ]
        if not candidates:
            return None
        candidates.sort(key=lambda t: (t.queue_order, -t.priority, t.created_at))
        return candidates[0]

    def _scheduler_loop(self):
        while True:
            thread: Optional[threading.Thread] = None
            with self._lock:
                if not self.running:
                    break
                max_concurrent = self.config.get_concurrent_downloads()
                if len(self.active_tasks) < max_concurrent:
                    task = self._pick_next_pending_locked()
                    if task is not None:
                        thread = threading.Thread(
                            target=self._download_task,
                            args=(task,),
                            daemon=True,
                        )
                        self.active_tasks[task.id] = thread
            if thread is not None:
                thread.start()
            else:
                threading.Event().wait(0.3)

    def _download_task(self, task: DownloadTask):
        try:
            with self._lock:
                if task.status in (TaskStatus.CANCELLED, TaskStatus.PAUSED):
                    return
                self._refresh_task_proxy(task)
                self._normalize_task_url(task)
                task.status = TaskStatus.DOWNLOADING
                task.started_at = datetime.now()
            self._persist(task)
            self.events.emit("task_started", {"task_id": task.id})

            # 抖音精选/发现页 modal_id → /video/{id}，供 yt-dlp DouyinIE 识别
            if is_douyin_url(task.video_info.url):
                normalized = normalize_douyin_url(task.video_info.url)
                if normalized != task.video_info.url:
                    with self._lock:
                        task.video_info.url = normalized
                    self._persist(task)

            # Compile every output decision before optional metadata/network work.
            plan = compile_output_plan(task)
            project_root = Path(__file__).resolve().parents[2]
            toolchain = resolve_media_toolchain(project_root=project_root)
            if toolchain is None:
                raise MediaToolsMissing(_MEDIA_TOOLS_MESSAGE)
            temp_root = Path(self.temp_dir).expanduser()
            staging_dir = temp_root / task.id

            # 补齐元数据（失败不阻断下载；X 失败时 VideoInfoExtractor 内会走 FxTwitter）
            # 扩展常带真实标题但无封面：页面链接仍需预拉 thumbnail；
            # CDN 直链（小红书等）则用 Referer 页面补封面，且不改写下载 URL。
            needs_full_meta = is_weak_title(task.video_info.title)
            needs_thumb = not (task.video_info.thumbnail_url or "").strip()
            is_direct_media = bool(_MEDIA_URL_RE.search(task.video_info.url))
            page_for_meta = _referer_page_url(task) if is_direct_media else ""
            extract_url = ""
            if is_direct_media and page_for_meta and (needs_full_meta or needs_thumb):
                extract_url = page_for_meta
            elif needs_full_meta or (needs_thumb and not is_direct_media):
                extract_url = task.video_info.url
            # YouTube 的实际下载流程本身会解析完整元数据。先做一次可选预取会把
            # 同一 API 请求重复一遍；网络偶发超时时，用户只能看到 0 B/s 而无法开始下载。
            # 交由 Downloader 的单次解析处理，完成后再统一回填标题/封面。
            is_youtube_task = (
                task.video_info.platform == Platform.YOUTUBE
                or PlatformDetector.detect(task.video_info.url) == Platform.YOUTUBE
            )
            if extract_url and not is_youtube_task:
                proxy = task.options.proxy or None
                info = VideoInfoExtractor.extract(
                    extract_url,
                    proxy=proxy,
                    http_headers=task.options.http_headers,
                )
                if info:
                    with self._lock:
                        media_url = task.video_info.url
                        if needs_full_meta:
                            if task.video_info.thumbnail_url and not info.thumbnail_url:
                                info.thumbnail_url = task.video_info.thumbnail_url
                            task.video_info = info
                            # 直链任务用页面补元数据时，保留 CDN URL 供下载
                            if is_direct_media and extract_url != media_url:
                                task.video_info.url = media_url
                        else:
                            if info.thumbnail_url:
                                task.video_info.thumbnail_url = info.thumbnail_url
                            if not task.video_info.uploader and info.uploader:
                                task.video_info.uploader = info.uploader
                            if not (task.video_info.duration or 0) and info.duration:
                                task.video_info.duration = info.duration
                            if info.formats and not task.video_info.formats:
                                task.video_info.formats = info.formats
                            if is_weak_title(task.video_info.title) and not is_weak_title(
                                info.title
                            ):
                                task.video_info.title = info.title
                            if (
                                task.video_info.platform == Platform.UNKNOWN
                                and info.platform != Platform.UNKNOWN
                            ):
                                task.video_info.platform = info.platform
                    self._persist(task)
                    self.events.emit("task_updated", {"task_id": task.id})

            with self._lock:
                if task.status in (TaskStatus.CANCELLED, TaskStatus.PAUSED):
                    raise DownloadCancelled(
                        "任务已取消" if task.status == TaskStatus.CANCELLED else "任务已暂停"
                    )

            downloader = Downloader()
            metadata_backfilled_from_progress = False

            def progress_callback(d):
                nonlocal metadata_backfilled_from_progress
                with self._lock:
                    if task.status == TaskStatus.CANCELLED:
                        raise DownloadCancelled("任务已取消")
                    if task.status == TaskStatus.PAUSED:
                        raise DownloadCancelled("任务已暂停")

                metadata_changed = False
                info_dict = d.get("info_dict")
                if (
                    not metadata_backfilled_from_progress
                    and isinstance(info_dict, dict)
                ):
                    title = pick_title_from_ydl_info(
                        info_dict,
                        task.video_info.title if is_direct_media else "",
                    )
                    if title:
                        with self._lock:
                            if title != task.video_info.title and (
                                not is_direct_media
                                or is_weak_title(task.video_info.title)
                            ):
                                task.video_info.title = title
                                metadata_changed = True
                        metadata_backfilled_from_progress = True

                if metadata_changed:
                    self._persist(task)
                    self.events.emit("task_updated", {"task_id": task.id})

                downloaded = int(d.get("downloaded_bytes") or 0)
                total = int(d.get("total_bytes") or d.get("total_bytes_estimate") or 0)
                task.downloaded_bytes = downloaded
                task.total_bytes = total

                try:
                    percent_str = d.get("_percent_str", "0%")
                    percent_str = re.sub(r"\x1b\[[0-9;]*m", "", str(percent_str))
                    task.progress = float(percent_str.replace("%", "").strip() or 0)
                except (ValueError, AttributeError, TypeError):
                    if total:
                        task.progress = min(100.0, downloaded * 100.0 / total)

                task.speed = d.get("_speed_str", "0 B/s")
                task.eta = d.get("_eta_str", "暂无")
                slim = {
                    "status": d.get("status"),
                    "_percent_str": d.get("_percent_str"),
                    "_speed_str": d.get("_speed_str"),
                    "_eta_str": d.get("_eta_str"),
                    "filename": d.get("filename"),
                    "downloaded_bytes": downloaded,
                    "total_bytes": total,
                    "progress": task.progress,
                }
                if self.queue_store is not None:
                    now = time.monotonic()
                    last = self._last_progress_persist.get(task.id, 0.0)
                    if now - last >= 2.0:
                        self._last_progress_persist[task.id] = now
                        try:
                            self.queue_store.update_progress(
                                task.id, task.progress, downloaded, total
                            )
                        except Exception as exc:
                            logger.error(f"持久化进度失败 {task.id}: {exc}")
                self.events.emit("task_progress", {"task_id": task.id, "progress": slim})

            downloader.set_callbacks(progress=progress_callback)

            result = downloader.download(
                task.video_info.url,
                plan,
                toolchain=toolchain,
                staging_dir=staging_dir,
            )

            with self._lock:
                if task.status in (TaskStatus.CANCELLED, TaskStatus.PAUSED):
                    raise DownloadCancelled(
                        "任务已取消"
                        if task.status == TaskStatus.CANCELLED
                        else "任务已暂停"
                    )

            expectation = _verification_expectation(plan, result.source_facts)
            verify_media(result.main_file, toolchain.ffprobe, expectation)
            _verify_external_subtitles(
                tuple(artifact.path for artifact in result.subtitles),
                staging_dir,
            )
            committed = commit_output_bundle(
                download_root=Path(task.options.output_path),
                playlist_folder=plan.playlist_folder,
                result=result,
            )
            try:
                try:
                    final_root = Path(task.options.output_path).expanduser().resolve(
                        strict=True
                    )
                    final_main = committed.main_file.expanduser().resolve(strict=True)
                except (OSError, RuntimeError, ValueError) as exc:
                    raise OutputVerificationFailed(
                        _OUTPUT_VERIFICATION_MESSAGE
                    ) from exc
                if not _is_inside(final_root, final_main):
                    raise OutputVerificationFailed(_OUTPUT_VERIFICATION_MESSAGE)
                with self._lock:
                    if task.status in (TaskStatus.CANCELLED, TaskStatus.PAUSED):
                        raise DownloadCancelled(
                            "任务已取消"
                            if task.status == TaskStatus.CANCELLED
                            else "任务已暂停"
                        )
                verify_media(final_main, toolchain.ffprobe, expectation)
                _verify_external_subtitles(committed.subtitle_files, final_root)
                with self._lock:
                    if task.status in (TaskStatus.CANCELLED, TaskStatus.PAUSED):
                        raise DownloadCancelled(
                            "任务已取消"
                            if task.status == TaskStatus.CANCELLED
                            else "任务已暂停"
                        )
                    self._backfill_metadata_after_download(
                        task,
                        result.info,
                        str(committed.main_file),
                        fallback_info=getattr(downloader, "last_info", None),
                    )
                    task.file_path = str(committed.main_file)
                    task.status = TaskStatus.COMPLETED
                    task.progress = 100.0
                    task.completed_at = datetime.now()
                    task.error_message = ""
                    task.error_code = ""
                    task.completion_note = _completion_note(
                        plan,
                        result.source_facts,
                    )
                    history_persisted = self._save_to_history(task)
            except Exception:
                rollback_committed_output(committed)
                raise

            queue_persisted = self._persist(task)

            if task.options.postprocessing == "script" and task.file_path:
                owner_id = f"postprocess:{task.id}"
                if self.output_ready_sink is not None:
                    try:
                        self.output_ready_sink.mark_processing(
                            task,
                            owner_id,
                            # The post-process command itself is bounded at 600 s;
                            # keep the durable handoff lease alive beyond that
                            # bound so a slow but valid script is not recovered
                            # as interrupted while it is still running.
                            (datetime.now(timezone.utc) + timedelta(seconds=900))
                            .isoformat()
                            .replace("+00:00", "Z"),
                        )
                    except Exception as exc:
                        logger.warning("无法登记后处理租约 %s: %s", task.id, exc)
                postprocess_ok = self._run_postprocess_script(task)
                if postprocess_ok and self.output_ready_sink is not None:
                    try:
                        self.output_ready_sink.mark_ready(
                            task,
                            owner_id=owner_id,
                            refresh_config=True,
                        )
                    except Exception as exc:
                        logger.warning("无法登记可发送成品 %s: %s", task.id, exc)
                elif not postprocess_ok and self.output_ready_sink is not None:
                    try:
                        self.output_ready_sink.mark_processing_failed(
                            task,
                            owner_id,
                            "Post-process script failed; confirm before retrying delivery.",
                        )
                    except Exception as exc:
                        logger.warning(
                            "无法记录后处理失败的 Telegram 发送记录 %s: %s",
                            task.id,
                            exc,
                        )
            elif self.output_ready_sink is not None and task.file_path:
                try:
                    self.output_ready_sink.mark_ready(
                        task,
                        owner_id=None,
                        refresh_config=True,
                    )
                except Exception as exc:
                    logger.warning("无法登记可发送成品 %s: %s", task.id, exc)

            self.events.emit("task_completed", {"task_id": task.id})
            if history_persisted and queue_persisted:
                self._cleanup_staging_dir(staging_dir, temp_root)
            else:
                logger.warning("完成状态未全部持久化，保留任务暂存目录: %s", task.id)

        except DownloadCancelled as e:
            cancelled = False
            with self._lock:
                if task.status == TaskStatus.PAUSED:
                    logger.info(f"任务已暂停中断: {task.video_info.title}")
                else:
                    task.status = TaskStatus.CANCELLED
                    task.error_message = str(e)
                    self._save_to_history(task)
                    cancelled = True
            self._persist(task)
            if cancelled:
                self.events.emit("task_cancelled", {"task_id": task.id})
                logger.info(f"任务已取消: {task.video_info.title}")
        except Exception as e:
            error_code, error_message = _safe_contract_error(e)
            with self._lock:
                if task.status in (TaskStatus.CANCELLED, TaskStatus.PAUSED):
                    return
                task.status = TaskStatus.FAILED
                task.error_message = error_message
                task.error_code = error_code
                task.completion_note = ""
                self._save_to_history(task)
            self._persist(task)
            self.events.emit(
                "task_failed",
                {"task_id": task.id, "error": error_message},
            )
            self._maybe_report_failure(task)
            logger.error("任务失败: %s - %s", task.video_info.title, e)
        finally:
            requeue = False
            with self._lock:
                self.active_tasks.pop(task.id, None)
                if task.id in self._resume_requested:
                    self._resume_requested.discard(task.id)
                    if task.status == TaskStatus.PAUSED:
                        task.status = TaskStatus.PENDING
                        task.error_message = ""
                        task.error_code = ""
                        requeue = True
            if requeue:
                self._persist(task)
                logger.info(f"暂停任务线程退出后重新入队: {task.video_info.title}")

    def _maybe_report_failure(self, task: DownloadTask) -> None:
        """opt-in 本地失败统计（不上报网络）。"""
        try:
            from src.sidecar.telemetry import maybe_report_failure

            maybe_report_failure(
                self.config,
                task.error_code,
                task.video_info.platform.value,
            )
        except Exception as exc:
            logger.debug("telemetry skipped: %s", exc)

    def _backfill_metadata_after_download(
        self,
        task: DownloadTask,
        result_info: Mapping[str, object],
        file_path: str,
        *,
        fallback_info: Optional[VideoInfo] = None,
    ) -> None:
        """下载完成后回填标题/平台/封面；页面任务优先用 yt-dlp 真实元数据。"""
        ydl_info = dict(result_info)
        is_direct = bool(_MEDIA_URL_RE.search(task.video_info.url))
        if isinstance(ydl_info, dict):
            title = pick_title_from_ydl_info(
                ydl_info,
                task.video_info.title if is_direct else "",
            )
            # 页面链接：用挑选后的标题；直链：仅在当前标题很弱时覆盖
            if title and (not is_direct or is_weak_title(task.video_info.title)):
                task.video_info.title = title
            uploader = _pick_uploader_from_ydl_info(ydl_info)
            if uploader and (not is_direct or not task.video_info.uploader):
                task.video_info.uploader = uploader
            thumb = pick_thumbnail_from_ydl_info(ydl_info)
            if thumb and (not is_direct or not task.video_info.thumbnail_url):
                task.video_info.thumbnail_url = thumb
            duration = ydl_info.get("duration")
            if isinstance(duration, (int, float)) and duration > 0:
                if not is_direct or not (task.video_info.duration or 0):
                    task.video_info.duration = int(duration)

        if task.video_info.thumbnail_url:
            task.video_info.thumbnail_url = normalize_thumbnail_url(
                task.video_info.thumbnail_url
            )

        if task.video_info.platform == Platform.UNKNOWN:
            referer = ""
            headers = task.options.http_headers or {}
            if isinstance(headers, dict):
                referer = str(headers.get("Referer") or headers.get("referer") or "")
            task.video_info.platform = PlatformDetector.detect_with_context(
                task.video_info.url,
                referer=referer or None,
                title=task.video_info.title,
            )

        # CDN 直链（小红书等）常无远端封面：从已下载文件抽帧
        if not (task.video_info.thumbnail_url or "").strip() and file_path:
            local_thumb = ensure_local_thumbnail(task.id, file_path)
            if local_thumb:
                task.video_info.thumbnail_url = local_thumb

        if task.video_info.title in _PLACEHOLDER_TITLES:
            if (
                isinstance(fallback_info, VideoInfo)
                and fallback_info.title
                and fallback_info.title not in _PLACEHOLDER_TITLES
            ):
                task.video_info = fallback_info
            elif file_path:
                stem = os.path.splitext(os.path.basename(file_path))[0].strip()
                # 去掉 .f140 一类中间后缀再当标题
                stem = re.sub(r"\.f\d+$", "", stem, flags=re.IGNORECASE)
                if stem and stem not in _PLACEHOLDER_TITLES:
                    task.video_info.title = stem

    def _save_to_history(self, task: DownloadTask) -> bool:
        """保存任务到历史记录（调用方应持有锁或接受竞态窗口很小）。"""
        record = DownloadRecord(
            id=task.id,
            url=task.video_info.url,
            title=task.video_info.title,
            platform=task.video_info.platform.value,
            duration=task.video_info.duration or 0,
            thumbnail_url=task.video_info.thumbnail_url or "",
            uploader=task.video_info.uploader or "",
            status=task.status.value,
            file_path=task.file_path,
            file_size=task.video_info.file_size or 0,
            created_at=task.created_at,
            started_at=task.started_at,
            completed_at=task.completed_at,
            error_message=task.error_message,
            output_recovery_safe=task.options.postprocessing != "script",
            completion_note=task.completion_note,
        )
        try:
            self.db.add_download_record(
                record,
                output_recovery_safe_override=record.output_recovery_safe,
            )
            return True
        except Exception as exc:
            logger.error(f"写入历史失败: {exc}")
            return False
