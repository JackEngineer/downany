"""
下载任务模型定义。
包含任务状态、视频信息和任务配置。
"""
from enum import Enum
from dataclasses import dataclass, field
from typing import Optional, Dict, Any, List
from datetime import datetime
import uuid


class TaskStatus(Enum):
    """任务状态枚举"""
    PENDING = "pending"           # 等待中
    DOWNLOADING = "downloading"   # 下载中
    PAUSED = "paused"            # 已暂停
    COMPLETED = "completed"      # 已完成
    FAILED = "failed"            # 失败
    CANCELLED = "cancelled"      # 已取消


class Platform(Enum):
    """支持的平台枚举"""
    YOUTUBE = "youtube"
    BILIBILI = "bilibili"
    DOUYIN = "douyin"
    TIKTOK = "tiktok"
    TWITTER = "twitter"
    INSTAGRAM = "instagram"
    PORNHUB = "pornhub"
    UNKNOWN = "unknown"


@dataclass
class VideoInfo:
    """视频信息数据类"""
    url: str
    title: str = ""
    duration: int = 0  # 秒
    thumbnail_url: str = ""
    uploader: str = ""
    platform: Platform = Platform.UNKNOWN
    file_size: int = 0  # 字节
    formats: List[Dict[str, Any]] = field(default_factory=list)  # 可用格式列表


@dataclass
class DownloadOptions:
    """下载选项配置"""
    format_id: Optional[str] = None  # 指定格式 ID
    quality: str = "best"  # 质量选择: best, 1080p, 720p, 480p
    download_subtitles: bool = False  # 是否下载字幕
    output_path: str = "downloads"  # 输出路径
    speed_limit: Optional[int] = None  # 速度限制 (bytes/s)
    proxy: Optional[str] = None  # 代理地址


@dataclass(frozen=True)
class TaskSnapshot:
    """任务的不可变快照，用于跨线程/跨进程只读展示。"""
    id: str
    url: str
    title: str
    platform: str
    status: str
    progress: float
    downloaded_bytes: int
    total_bytes: int
    speed: str
    eta: str
    file_path: str
    error_message: str
    created_at: str
    started_at: Optional[str]
    completed_at: Optional[str]


@dataclass
class DownloadTask:
    """下载任务数据类"""
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    video_info: VideoInfo = field(default_factory=lambda: VideoInfo(url=""))
    options: DownloadOptions = field(default_factory=DownloadOptions)
    status: TaskStatus = TaskStatus.PENDING
    progress: float = 0.0  # 0-100
    downloaded_bytes: int = 0
    total_bytes: int = 0
    speed: str = "0 B/s"  # 下载速度
    eta: str = "暂无"  # 预计剩余时间
    file_path: str = ""  # 下载完成后的文件路径
    error_message: str = ""  # 错误信息
    created_at: datetime = field(default_factory=datetime.now)
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        return {
            'id': self.id,
            'url': self.video_info.url,
            'title': self.video_info.title,
            'platform': self.video_info.platform.value,
            'duration': self.video_info.duration,
            'thumbnail_url': self.video_info.thumbnail_url,
            'uploader': self.video_info.uploader,
            'status': self.status.value,
            'progress': self.progress,
            'downloaded_bytes': self.downloaded_bytes,
            'total_bytes': self.total_bytes,
            'speed': self.speed,
            'eta': self.eta,
            'file_path': self.file_path,
            'file_size': self.video_info.file_size,
            'error_message': self.error_message,
            'created_at': self.created_at.isoformat(),
            'started_at': self.started_at.isoformat() if self.started_at else None,
            'completed_at': self.completed_at.isoformat() if self.completed_at else None,
        }

    def to_snapshot(self) -> "TaskSnapshot":
        """生成不可变快照。"""
        return TaskSnapshot(
            id=self.id,
            url=self.video_info.url,
            title=self.video_info.title,
            platform=self.video_info.platform.value,
            status=self.status.value,
            progress=self.progress,
            downloaded_bytes=self.downloaded_bytes,
            total_bytes=self.total_bytes,
            speed=self.speed,
            eta=self.eta,
            file_path=self.file_path,
            error_message=self.error_message,
            created_at=self.created_at.isoformat(),
            started_at=self.started_at.isoformat() if self.started_at else None,
            completed_at=self.completed_at.isoformat() if self.completed_at else None,
        )
