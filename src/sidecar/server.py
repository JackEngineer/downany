"""Sidecar JSON Lines 服务循环。"""
from __future__ import annotations

import sys
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional, TextIO

from src.core.download_manager import DownloadManager
from src.data.database import HistoryDB
from src.data.json_config import JsonConfig
from src.data.queue_store import QueueStore
from src.sidecar.codec import ProtocolError, decode_line, encode_message
from src.sidecar.handlers import HandlerContext, HandlerError, dispatch
from src.sidecar.paths import AppPaths
from src.sidecar.protocol import (
    APP_NAME,
    APP_VERSION,
    PROTOCOL_VERSION,
    ErrorCode,
    EventName,
    MessageType,
)
from src.utils.logger import setup_logger

logger = setup_logger("SidecarServer")

_PROGRESS_MIN_INTERVAL = 0.2


class SidecarServer:
    def __init__(self, ctx: HandlerContext, paths: AppPaths):
        self.ctx = ctx
        self.paths = paths
        self._stdout: Optional[TextIO] = None
        self._last_progress_emit: Dict[str, float] = {}
        self._unsubscribe = None

    @classmethod
    def from_paths(cls, paths: AppPaths) -> "SidecarServer":
        paths.ensure()
        HistoryDB._instance = None
        config = JsonConfig(str(paths.config_path))
        db = HistoryDB(db_path=str(paths.history_db_path))
        store = QueueStore(str(paths.history_db_path))
        manager = DownloadManager(config=config, db=db, queue_store=store)
        manager.restore_tasks()
        manager.start()

        ctx = HandlerContext(
            config=config,
            db=db,
            manager=manager,
            emit_event=lambda _name, _payload: None,
        )
        server = cls(ctx, paths)
        ctx.emit_event = server._write_event
        server._unsubscribe = manager.events.subscribe(server._on_manager_event)
        return server

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def _write(self, msg: Dict[str, Any]) -> None:
        if self._stdout is None:
            return
        self._stdout.write(encode_message(msg))
        self._stdout.flush()

    def _write_event(self, event: str, payload: Dict[str, Any]) -> None:
        self._write(
            {
                "protocolVersion": PROTOCOL_VERSION,
                "type": MessageType.EVENT.value,
                "event": event,
                "payload": payload,
                "timestamp": self._now(),
            }
        )

    def _write_response(
        self,
        correlation_id: str,
        *,
        payload: Optional[Dict[str, Any]] = None,
        error: Optional[Dict[str, Any]] = None,
    ) -> None:
        msg: Dict[str, Any] = {
            "protocolVersion": PROTOCOL_VERSION,
            "type": MessageType.RESPONSE.value,
            "correlationId": correlation_id,
            "timestamp": self._now(),
        }
        if error is not None:
            msg["error"] = error
        else:
            msg["payload"] = payload or {}
        self._write(msg)

    def _write_hello(self) -> None:
        self._write(
            {
                "protocolVersion": PROTOCOL_VERSION,
                "type": MessageType.HELLO.value,
                "payload": {
                    "app": APP_NAME,
                    "appVersion": APP_VERSION,
                },
                "timestamp": self._now(),
            }
        )

    def _on_manager_event(self, event: str, payload: Dict[str, Any]) -> None:
        task_id = payload.get("task_id", "")
        mapping = {
            "task_added": EventName.TASK_ADDED.value,
            "task_started": EventName.TASK_UPDATED.value,
            "task_paused": EventName.TASK_UPDATED.value,
            "task_cancelled": EventName.TASK_UPDATED.value,
            "task_completed": EventName.TASK_COMPLETED.value,
            "task_failed": EventName.TASK_FAILED.value,
            "task_progress": EventName.TASK_PROGRESS.value,
        }
        name = mapping.get(event)
        if not name:
            return
        if event == "task_progress":
            now = time.monotonic()
            last = self._last_progress_emit.get(task_id, 0.0)
            if now - last < _PROGRESS_MIN_INTERVAL:
                return
            self._last_progress_emit[task_id] = now
        body: Dict[str, Any] = {"taskId": task_id}
        if "progress" in payload:
            body["progress"] = payload["progress"]
        if "error" in payload:
            body["error"] = payload["error"]
        task = self.ctx.manager.get_task(task_id)
        if task is not None:
            body["task"] = self.ctx.snapshot_task(task)
        self._write_event(name, body)

    def run(self, stdin: TextIO, stdout: TextIO) -> int:
        self._stdout = stdout
        self._write_hello()

        # Expect peer hello
        line = stdin.readline()
        if not line:
            logger.error("未收到对方 hello，退出")
            self._cleanup()
            return 1
        try:
            peer = decode_line(line)
        except ProtocolError as exc:
            self._write_response(
                "hello",
                error=HandlerError(ErrorCode.INVALID_MESSAGE, str(exc)).to_dict(),
            )
            self._cleanup()
            return 1
        if peer.get("type") != MessageType.HELLO.value:
            self._write_response(
                "hello",
                error=HandlerError(
                    ErrorCode.INVALID_MESSAGE, "期望 hello 消息"
                ).to_dict(),
            )
            self._cleanup()
            return 1
        if int(peer.get("protocolVersion", -1)) != PROTOCOL_VERSION:
            self._write_response(
                "hello",
                error=HandlerError(
                    ErrorCode.PROTOCOL_MISMATCH,
                    f"协议版本不兼容: 对方 {peer.get('protocolVersion')} / 本地 {PROTOCOL_VERSION}",
                ).to_dict(),
            )
            self._cleanup()
            return 1

        while True:
            line = stdin.readline()
            if not line:
                break
            try:
                msg = decode_line(line)
            except ProtocolError as exc:
                self._write_response(
                    "unknown",
                    error=HandlerError(ErrorCode.INVALID_MESSAGE, str(exc)).to_dict(),
                )
                continue
            if msg.get("type") != MessageType.REQUEST.value:
                self._write_response(
                    str(msg.get("id") or "unknown"),
                    error=HandlerError(
                        ErrorCode.INVALID_MESSAGE, "仅接受 request"
                    ).to_dict(),
                )
                continue
            req_id = str(msg["id"])
            method = str(msg["method"])
            payload = msg.get("payload") or {}
            try:
                result = dispatch(self.ctx, method, payload)
                self._write_response(req_id, payload=result)
            except HandlerError as exc:
                self._write_response(req_id, error=exc.to_dict())
            except Exception as exc:
                logger.exception("处理请求失败: %s", method)
                self._write_response(
                    req_id,
                    error=HandlerError(ErrorCode.INTERNAL, str(exc)).to_dict(),
                )
            if self.ctx.shutdown_requested:
                break

        self._cleanup()
        return 0

    def _cleanup(self) -> None:
        if self._unsubscribe:
            self._unsubscribe()
            self._unsubscribe = None
        try:
            self.ctx.manager.stop()
        except Exception as exc:
            logger.error("停止管理器失败: %s", exc)


def main(argv: Optional[list] = None) -> int:
    paths = AppPaths.default().ensure()
    # 日志走 stderr，避免污染 stdout 协议流
    logging_msg = f"Sidecar 启动 data={paths.data_dir} log={paths.log_dir}\n"
    sys.stderr.write(logging_msg)
    server = SidecarServer.from_paths(paths)
    return server.run(sys.stdin, sys.stdout)
