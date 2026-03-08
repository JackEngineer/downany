"""
视频预览组件，提供应用内播放能力。
优先使用 QtMultimedia 播放，失败时通知上层回退。
"""
from PyQt6.QtCore import Qt, QUrl, pyqtSignal
from PyQt6.QtMultimedia import QMediaPlayer, QAudioOutput
from PyQt6.QtMultimediaWidgets import QVideoWidget
from PyQt6.QtWidgets import QWidget, QVBoxLayout, QLabel, QPushButton, QHBoxLayout


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
        self._setup_ui()
        self._setup_player()
        self._current_url = ""

    def _setup_ui(self):
        """初始化UI。"""
        self.setMinimumSize(480, 270)
        layout = QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(8)

        # 视频显示区域
        self.video_widget = QVideoWidget()
        self.video_widget.setMinimumSize(480, 270)
        layout.addWidget(self.video_widget)

        # 控制栏
        controls = QHBoxLayout()
        controls.setSpacing(8)

        self.play_btn = QPushButton("播放")
        self.play_btn.clicked.connect(self.play)
        controls.addWidget(self.play_btn)

        self.pause_btn = QPushButton("暂停")
        self.pause_btn.clicked.connect(self.pause)
        controls.addWidget(self.pause_btn)

        self.stop_btn = QPushButton("停止")
        self.stop_btn.clicked.connect(self.stop)
        controls.addWidget(self.stop_btn)

        controls.addStretch()
        layout.addLayout(controls)

        # 状态标签
        self.status_label = QLabel("就绪")
        self.status_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(self.status_label)

        self.setLayout(layout)

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

    def _on_error(self, error, error_string):
        """处理播放错误。"""
        self.status_label.setText(f"播放失败: {error_string}")
        self.playback_failed.emit(error_string)

    def _on_state_changed(self, state):
        """处理播放状态变化。"""
        state_map = {
            QMediaPlayer.PlaybackState.StoppedState: "已停止",
            QMediaPlayer.PlaybackState.PlayingState: "播放中",
            QMediaPlayer.PlaybackState.PausedState: "已暂停",
        }
        self.status_label.setText(state_map.get(state, "未知状态"))

    def _on_media_status_changed(self, status):
        """处理媒体状态变化。"""
        if status == QMediaPlayer.MediaStatus.LoadedMedia:
            self.playback_started.emit()
        elif status == QMediaPlayer.MediaStatus.EndOfMedia:
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
            self.playback_failed.emit("empty_url")
            return False

        # 检查是否是可能需要解析的平台链接
        # YouTube、Bilibili等需要解析出直链才能播放
        if self._needs_parsing(url):
            # 尝试解析，如果失败则返回False让上层回退
            parsed_url = self._try_parse_url(url)
            if not parsed_url:
                self.status_label.setText("该链接需要解析，尝试回退浏览器")
                self.playback_failed.emit("needs_parsing")
                return False
            url = parsed_url

        self._current_url = url
        self.player.setSource(QUrl(url))
        self.player.play()
        return True

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
        # TODO: 接入 yt-dlp 解析直链
        # 当前版本：直接返回空，让上层回退浏览器
        return ""

    def play(self):
        """开始/继续播放。"""
        self.player.play()

    def pause(self):
        """暂停播放。"""
        self.player.pause()

    def stop(self):
        """停止播放。"""
        self.player.stop()
        self.status_label.setText("已停止")

    def clear(self):
        """清空播放器状态。"""
        self.stop()
        self.player.setSource(QUrl())
        self._current_url = ""
        self.status_label.setText("就绪")

    def is_playing(self) -> bool:
        """是否正在播放。"""
        return self.player.playbackState() == QMediaPlayer.PlaybackState.PlayingState
