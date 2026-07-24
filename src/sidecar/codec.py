"""JSON Lines 编解码与最小结构校验。"""
from __future__ import annotations

import json
from typing import Any, Dict

from src.sidecar.protocol import MessageType


class ProtocolError(ValueError):
    """协议层错误（无效行或结构）。"""


_REQUIRED = {
    MessageType.REQUEST.value: {"protocolVersion", "type", "id", "method", "payload", "timestamp"},
    MessageType.RESPONSE.value: {"protocolVersion", "type", "correlationId", "timestamp"},
    MessageType.EVENT.value: {"protocolVersion", "type", "event", "payload", "timestamp"},
    MessageType.HELLO.value: {"protocolVersion", "type", "payload", "timestamp"},
}


def decode_line(line: str) -> Dict[str, Any]:
    text = line.strip()
    if not text:
        raise ProtocolError("空行")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ProtocolError(f"非 JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ProtocolError("消息必须是对象")
    msg_type = data.get("type")
    required = _REQUIRED.get(msg_type)
    if required is None:
        raise ProtocolError(f"未知 type: {msg_type}")
    missing = required - set(data)
    if missing:
        raise ProtocolError(f"缺少字段: {sorted(missing)}")
    if msg_type == MessageType.RESPONSE.value and "payload" not in data and "error" not in data:
        raise ProtocolError("response 需要 payload 或 error")
    return data


def encode_message(msg: Dict[str, Any]) -> str:
    return json.dumps(msg, ensure_ascii=False, separators=(",", ":")) + "\n"
