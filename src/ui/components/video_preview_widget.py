"""
视频预览组件，提供应用内播放能力。
优先使用 QtMultimedia 播放，失败时通知上层回退。
"""
from __future__ import annotations

import yt_dlp
from PyQt6.QtCore import Qt, QThread, QUrl, pyqtSignal
from PyQt6.QtMultimedia import QMediaPlayer, QAudioOutput
from PyQt6.QtMultimediaWidgets import QVideoWidget
from PyQt6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QSizePolicy,
    QStackedWidget,
    QVBoxLayout,
    QWidget,
)

from src.core.ytdlp_opts import REMOTE_COMPONENTS
from src.ui.components.chrome import BodyLabel, StatusBadge, StrongBodyLabel
from src.ui.fluent_support import get_fluent_widget
from src.utils.logger import setup_logger


logger = setup_logger("VideoPreviewWidget")


def _repolish(widget: QWidget) -> None:
    style = widget.style()
    if style is None:
        return
    style.unpolish(widget)
    style.polish(widget)
    widget.update()


def _extract_direct_playback_url(url: str) -> tuple[str, str]:
    """提取可直接播放的媒体 URL。

    返回 (direct_url, error_message)。direct_url 为空时，error_message 说明失败原因。
    """

    try:
        with yt_dlp.YoutubeDL({
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "remote_components": REMOTE_COMPONENTS,
        }) as ydl:
            info = ydl.extract_info(url, download=False)

        if not info:
            return "", "empty_extraction_result"

        direct_url = info.get("url") or ""
        if direct_url:
            return direct_url, ""

        formats = info.get("formats") or []
        for fmt in reversed(formats):
            fmt_url = (fmt or {}).get("url")
            if fmt_url:
                return fmt_url, ""

        return "", "no_direct_playback_url"
    except Exception as exc:
        return "", str(exc)


class _PlaybackResolveThread(QThread):
    """后台解析可播放直链的线程。"""

    resolved = pyqtSignal(int, str, str)
    failed = pyqtSignal(int, str, str)

    def __init__(self, request_id: int, source_url: str, parent=None):
        super().__init__(parent)
        self.request_id = request_id
        self.source_url = source_url

    def run(self):
        direct_url, error_message = _extract_direct_playback_url(self.source_url)
        if direct_url:
            self.resolved.emit(self.request_id, self.source_url, direct_url)
        else:
            self.failed.emit(self.request_id, self.source_url, error_message or "resolve_failed")


class VideoPreviewWidget(QWidget):
    """视频预览组件，支持应用内播放与失败回调。"""

    # 信号：播放失败（reason）
    playback_failed = pyqtSignal(str)
    # 信号：播放成功开始
    playback_started = pyqtSignal()
    # 信号：播放结束
    playback_finished = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self._playback_request_seq = 0
        self._active_playback_request_id = 0
        self._resolve_threads: dict[int, _PlaybackResolveThread] = {}
        self._setup_ui()
        self._setup_player()
        self._current_url = ""

    def _setup_ui(self):
        """初始化UI。"""
        push_button_cls = get_fluent_widget("PushButton") or QPushButton
        self.setMinimumSize(320, 180)
        layout = QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(10)

        self.stage_frame = QFrame()
        self.stage_frame.setObjectName("VideoPreviewStage")
        self.stage_frame.setProperty("state", "idle")
        self.stage_frame.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.stage_frame.setMinimumHeight(150)
        self.stage_frame.setMaximumHeight(180)
        stage_layout = QVBoxLayout(self.stage_frame)
        stage_layout.setContentsMargins(0, 0, 0, 0)
        stage_layout.setSpacing(0)

        self.stage_stack = QStackedWidget()
        self.stage_stack.setObjectName("VideoPreviewStack")
        self.stage_stack.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        stage_layout.addWidget(self.stage_stack)

        self.placeholder_page = QWidget()
        self.placeholder_page.setObjectName("VideoPreviewPlaceholder")
        self.placeholder_page.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        placeholder_layout = QVBoxLayout(self.placeholder_page)
        placeholder_layout.setContentsMargins(24, 24, 24, 24)
        placeholder_layout.setSpacing(8)
        placeholder_layout.setAlignment(Qt.AlignmentFlag.AlignCenter)

        placeholder_layout.addStretch(1)

        self.placeholder_badge = StatusBadge("应用内预览", "primary")
        placeholder_layout.addWidget(self.placeholder_badge, 0, Qt.AlignmentFlag.AlignHCenter)

        self.placeholder_title = StrongBodyLabel("预览待就绪")
        self.placeholder_title.setObjectName("VideoPreviewTitle")
        self.placeholder_title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.placeholder_title.setWordWrap(True)
        placeholder_layout.addWidget(self.placeholder_title)

        self.placeholder_hint = BodyLabel("选择结果后点击“直接预览”，播放器会在这里显示。")
        self.placeholder_hint.setObjectName("VideoPreviewHint")
        self.placeholder_hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.placeholder_hint.setWordWrap(True)
        placeholder_layout.addWidget(self.placeholder_hint)

        placeholder_layout.addStretch(1)

        self.video_page = QWidget()
        self.video_page.setObjectName("VideoPreviewVideoPage")
        self.video_page.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        video_layout = QVBoxLayout(self.video_page)
        video_layout.setContentsMargins(0, 0, 0, 0)
        video_layout.setSpacing(0)

        self.video_widget = QVideoWidget()
        self.video_widget.setObjectName("VideoPreviewSurface")
        self.video_widget.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.video_widget.setMinimumSize(320, 150)
        video_layout.addWidget(self.video_widget)

        self.stage_stack.addWidget(self.placeholder_page)
        self.stage_stack.addWidget(self.video_page)
        self.stage_stack.setCurrentWidget(self.placeholder_page)
        layout.addWidget(self.stage_frame)

        # 控制栏
        controls = QHBoxLayout()
        controls.setSpacing(8)

        self.play_btn = push_button_cls("播放")
        self.play_btn.clicked.connect(self.play)
        controls.addWidget(self.play_btn)

        self.pause_btn = push_button_cls("暂停")
        self.pause_btn.clicked.connect(self.pause)
        controls.addWidget(self.pause_btn)

        self.stop_btn = push_button_cls("停止")
        self.stop_btn.clicked.connect(self.stop)
        controls.addWidget(self.stop_btn)

        controls.addStretch()
        layout.addLayout(controls)

        # 状态标签
        self.status_label = QLabel("就绪")
        self.status_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.status_label.setWordWrap(True)
        layout.addWidget(self.status_label)

        self.setLayout(layout)
        self._set_stage_state("idle")

    def _setup_player(self):
        """初始化媒体播放器。"""
        self.player = QMediaPlayer()
        self.audio_output = QAudioOutput()
        self.player.setAudioOutput(self.audio_output)
        self.player.setVideoOutput(self.video_widget)

        # 连接信号
        self.player.errorOccurred.connect(self._on_error)
        self.player.playbackStateChanged.connect(self._on_state_changed)
        self.player.mediaStatusChanged.connect(self._on_media_status_changed)

    def _set_stage_state(self, state: str, title: str | None = None, hint: str | None = None) -> None:
        """更新预览区的占位 / 播放状态。"""

        self.stage_frame.setProperty("state", state)
        self.placeholder_badge.setTone(
            "warning" if state == "error" else "info" if state == "loading" else "primary"
        )

        if title is not None:
            self.placeholder_title.setText(title)
        if hint is not None:
            self.placeholder_hint.setText(hint)

        if state == "playing":
            self.stage_stack.setCurrentWidget(self.video_page)
        else:
            self.stage_stack.setCurrentWidget(self.placeholder_page)

        _repolish(self.stage_frame)

    def _on_error(self, error, error_string):
        """处理播放错误。"""
        self.status_label.setText(f"播放失败: {error_string}")
        self._set_stage_state(
            "error",
            "播放失败",
            "当前视频流无法在应用内播放，请尝试直接打开链接或等待片刻后重试。",
        )
        logger.debug("播放失败 error=%s message=%s", error, error_string)
        self.playback_failed.emit(error_string)

    def _on_state_changed(self, state):
        """处理播放状态变化。"""
        state_map = {
            QMediaPlayer.PlaybackState.StoppedState: "已停止",
            QMediaPlayer.PlaybackState.PlayingState: "播放中",
            QMediaPlayer.PlaybackState.PausedState: "已暂停",
        }
        self.status_label.setText(state_map.get(state, "未知状态"))
        if state == QMediaPlayer.PlaybackState.PlayingState:
            self._set_stage_state("playing")
        elif state == QMediaPlayer.PlaybackState.StoppedState:
            self._set_stage_state(
                "idle",
                "预览待就绪",
                "选择结果后点击“直接预览”，播放器会在这里显示。",
            )

    def _on_media_status_changed(self, status):
        """处理媒体状态变化。"""
        if status == QMediaPlayer.MediaStatus.LoadedMedia:
            self._set_stage_state("playing")
            self.playback_started.emit()
        elif status == QMediaPlayer.MediaStatus.EndOfMedia:
            self._set_stage_state(
                "idle",
                "播放结束",
                "你可以再次预览，或切换到其他搜索结果。",
            )
            self.playback_finished.emit()

    def try_play(self, url: str) -> bool:
        """
        尝试播放指定URL。

        Args:
            url: 视频URL（支持直接播放的链接）

        Returns:
            是否成功开始播放流程（注意：不代表一定能播放完成）
        """
        if not url:
            self.status_label.setText("无效链接")
            self._set_stage_state(
                "error",
                "无效链接",
                "请选择一个包含有效视频地址的搜索结果。",
            )
            logger.debug("预览收到空链接")
            self.playback_failed.emit("empty_url")
            return False

        request_id = self._invalidate_playback_requests()

        # 检查是否是可能需要解析的平台链接
        # YouTube、Bilibili等需要解析出直链才能播放
        if self._needs_parsing(url):
            self._start_background_resolution(request_id, url)
            return True

        self._apply_playback_url(url)
        return True

    def _invalidate_playback_requests(self) -> int:
        self._playback_request_seq += 1
        self._active_playback_request_id = self._playback_request_seq
        return self._active_playback_request_id

    def _start_background_resolution(self, request_id: int, source_url: str) -> None:
        self.status_label.setText("正在解析可播放链接…")
        self._set_stage_state(
            "loading",
            "正在解析可播放链接",
            "YouTube、Bilibili 等链接会先解析出可播放直链。",
        )
        logger.debug("开始解析可播放链接 request=%s url=%s", request_id, source_url[:160])

        thread = _PlaybackResolveThread(request_id, source_url, self)
        self._resolve_threads[request_id] = thread
        thread.resolved.connect(self._on_resolve_succeeded)
        thread.failed.connect(self._on_resolve_failed)
        thread.finished.connect(lambda request_id=request_id: self._resolve_threads.pop(request_id, None))
        thread.finished.connect(thread.deleteLater)
        thread.start()

    def _apply_playback_url(self, url: str) -> None:
        self._current_url = url
        self._set_stage_state(
            "loading",
            "正在准备播放",
            "播放器正在连接视频流，完成后会自动切换到画面。",
        )
        self.player.setSource(QUrl(url))
        self.player.play()
        logger.debug("开始播放直链 url=%s", url[:160])

    def _on_resolve_succeeded(self, request_id: int, source_url: str, direct_url: str):
        if request_id != self._active_playback_request_id:
            return

        logger.debug(
            "解析可播放链接完成 request=%s source=%s direct=%s",
            request_id,
            source_url[:160],
            direct_url[:160],
        )
        self._apply_playback_url(direct_url)

    def _on_resolve_failed(self, request_id: int, source_url: str, reason: str):
        if request_id != self._active_playback_request_id:
            return

        self.status_label.setText("解析可播放链接失败")
        self._set_stage_state(
            "error",
            "解析失败",
            "无法获取可播放直链，请稍后重试，或改用浏览器预览。",
        )
        logger.debug("解析可播放链接失败 request=%s url=%s reason=%s", request_id, source_url[:160], reason)
        self.playback_failed.emit(reason)

    def _needs_parsing(self, url: str) -> bool:
        """检查URL是否需要解析才能播放。"""
        # YouTube 链接需要解析
        if "youtube.com" in url or "youtu.be" in url:
            return True
        # Bilibili 链接需要解析
        if "bilibili.com" in url:
            return True
        # 抖音/TikTok 链接需要解析
        if "douyin.com" in url or "tiktok.com" in url:
            return True
        # Twitter/X 链接需要解析
        if "twitter.com" in url or "x.com" in url:
            return True
        return False

    def _try_parse_url(self, url: str) -> str:
        """
        尝试解析出可直接播放的URL。
        简单实现：目前直接返回空表示需要回退浏览器。
        后续可接入 yt-dlp 解析直链。
        """
        direct_url, _error_message = _extract_direct_playback_url(url)
        return direct_url

    def play(self):
        """开始/继续播放。"""
        self.player.play()

    def pause(self):
        """暂停播放。"""
        self.player.pause()

    def stop(self):
        """停止播放。"""
        self._invalidate_playback_requests()
        self._stop_resolve_threads()
        self.player.stop()
        self.player.setVideoOutput(None)
        self.player.setVideoOutput(self.video_widget)
        self.status_label.setText("已停止")
        self._set_stage_state(
            "idle",
            "已停止",
            "再次点击“直接预览”即可继续播放。",
        )

    def clear(self):
        """清空播放器状态。"""
        self._invalidate_playback_requests()
        self._stop_resolve_threads()
        self.player.stop()
        self.player.setSource(QUrl())
        self.player.setVideoOutput(None)
        self.player.setVideoOutput(self.video_widget)
        self._current_url = ""
        self.status_label.setText("就绪")
        self._set_stage_state(
            "idle",
            "预览待就绪",
            "选择结果后点击“直接预览”，播放器会在这里显示。",
        )

    def _stop_resolve_threads(self):
        for thread in list(self._resolve_threads.values()):
            try:
                thread.requestInterruption()
                thread.quit()
                thread.wait(500)
            except Exception:
                pass
        self._resolve_threads.clear()

    def shutdown(self):
        self.clear()
        self.player.stop()

    def is_playing(self) -> bool:
        """是否正在播放。"""
        return self.player.playbackState() == QMediaPlayer.PlaybackState.PlayingState
