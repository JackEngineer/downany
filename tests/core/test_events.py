"""EventEmitter 行为测试。"""
import threading

from src.core.events import EventEmitter


def test_emit_delivers_event_and_payload():
    emitter = EventEmitter()
    received = []
    emitter.subscribe(lambda event, payload: received.append((event, payload)))

    emitter.emit("task_added", {"task_id": "abc"})

    assert received == [("task_added", {"task_id": "abc"})]


def test_emit_without_payload_delivers_empty_dict():
    emitter = EventEmitter()
    received = []
    emitter.subscribe(lambda event, payload: received.append(payload))

    emitter.emit("task_started")

    assert received == [{}]


def test_unsubscribe_stops_delivery():
    emitter = EventEmitter()
    received = []
    unsubscribe = emitter.subscribe(lambda event, payload: received.append(event))

    emitter.emit("a")
    unsubscribe()
    emitter.emit("b")

    assert received == ["a"]


def test_concurrent_emit_is_safe():
    emitter = EventEmitter()
    received = []
    lock = threading.Lock()

    def listener(event, payload):
        with lock:
            received.append(event)

    emitter.subscribe(listener)
    threads = [
        threading.Thread(target=lambda: [emitter.emit("x") for _ in range(100)])
        for _ in range(8)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(received) == 800
