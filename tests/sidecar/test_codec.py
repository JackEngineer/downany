"""codec 编解码测试。"""
import json

import pytest

from src.sidecar.codec import ProtocolError, decode_line, encode_message
from src.sidecar.protocol import PROTOCOL_VERSION, MessageType


def test_roundtrip_request():
    msg = {
        "protocolVersion": PROTOCOL_VERSION,
        "type": MessageType.REQUEST.value,
        "id": "r1",
        "method": "app.ping",
        "payload": {},
        "timestamp": "2026-07-21T12:00:00+00:00",
    }
    line = encode_message(msg)
    assert line.endswith("\n")
    assert decode_line(line) == msg


def test_reject_non_json():
    with pytest.raises(ProtocolError):
        decode_line("not-json\n")


def test_reject_missing_type():
    with pytest.raises(ProtocolError):
        decode_line(json.dumps({"protocolVersion": 1, "timestamp": "t"}) + "\n")


def test_stdout_line_is_single_object():
    line = encode_message(
        {
            "protocolVersion": 1,
            "type": "event",
            "event": "task.progress",
            "payload": {"task_id": "a"},
            "timestamp": "t",
        }
    )
    assert line.count("\n") == 1
