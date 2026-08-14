"""系统代理探测，供 Windows 无手动代理配置时复用本机网络代理。"""
from __future__ import annotations

import os
import re
import socket
import sys
from collections.abc import Callable, Mapping
from typing import Optional
from urllib.request import getproxies

_PROXY_ENV_KEYS = (
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "HTTP_PROXY",
    "http_proxy",
)

# Clash / Mihomo 等常见 HTTP、SOCKS 或 mixed 端口。端口开放后仍须通过 HTTP
# CONNECT 握手确认协议，不能仅凭端口号猜测。
_WINDOWS_LOCAL_PROXY_PORTS = (7897, 7890, 7891, 8080, 3128)
_HTTP_CONNECT_OK_RE = re.compile(rb"^HTTP/\d(?:\.\d)?\s+200\b", re.IGNORECASE)


def _probe_http_proxy(host: str, port: int, timeout: float) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout) as conn:
            conn.settimeout(timeout)
            conn.sendall(
                b"CONNECT www.youtube.com:443 HTTP/1.1\r\n"
                b"Host: www.youtube.com:443\r\n"
                b"Proxy-Connection: close\r\n\r\n"
            )
            response = conn.recv(64)
            return bool(_HTTP_CONNECT_OK_RE.match(response))
    except OSError:
        return False


def detect_system_proxy(
    *,
    env: Optional[Mapping[str, str]] = None,
    platform: Optional[str] = None,
    probe: Optional[Callable[[str, int, float], bool]] = None,
    system_proxy_reader: Optional[Callable[[], Mapping[str, str]]] = None,
) -> Optional[str]:
    """返回可复用的系统/本机代理；无法确认时返回 ``None``。"""
    if (platform or sys.platform) != "win32":
        return None

    values = env if env is not None else os.environ
    for key in _PROXY_ENV_KEYS:
        value = str(values.get(key) or "").strip()
        if value:
            return value

    reader = system_proxy_reader or getproxies
    try:
        registered = {
            str(key).lower(): str(value or "").strip()
            for key, value in reader().items()
        }
    except (OSError, ValueError):
        registered = {}
    for key in ("https", "http", "all"):
        value = registered.get(key, "")
        if value:
            return value

    check = probe or _probe_http_proxy
    for port in _WINDOWS_LOCAL_PROXY_PORTS:
        if check("127.0.0.1", port, 0.15):
            return f"http://127.0.0.1:{port}"
    return None
