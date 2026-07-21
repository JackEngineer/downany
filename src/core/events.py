"""下载核心事件分发器，不依赖 Qt。"""
from __future__ import annotations

import threading
from typing import Any, Callable, Dict, List, Optional

Listener = Callable[[str, Dict[str, Any]], None]


class EventEmitter:
    """线程安全的事件分发器。监听器在触发线程上同步执行。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._listeners: List[Listener] = []

    def subscribe(self, listener: Listener) -> Callable[[], None]:
        """注册监听器，返回反注册函数。"""
        with self._lock:
            self._listeners.append(listener)

        def unsubscribe() -> None:
            with self._lock:
                if listener in self._listeners:
                    self._listeners.remove(listener)

        return unsubscribe

    def emit(self, event: str, payload: Optional[Dict[str, Any]] = None) -> None:
        with self._lock:
            listeners = list(self._listeners)
        data = payload if payload is not None else {}
        for listener in listeners:
            listener(event, data)
