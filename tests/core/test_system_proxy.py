import src.core.system_proxy as system_proxy
from src.core.system_proxy import detect_system_proxy


class _FakeProxySocket:
    def __init__(self, response):
        self.response = response
        self.sent = b""
        self.timeout = None

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _tb):
        return False

    def settimeout(self, timeout):
        self.timeout = timeout

    def sendall(self, payload):
        self.sent += payload

    def recv(self, _size):
        return self.response


def test_detect_system_proxy_prefers_environment_proxy():
    probed = []

    def probe(host, port, timeout):
        probed.append((host, port, timeout))
        return True

    proxy = detect_system_proxy(
        env={
            "HTTPS_PROXY": "http://proxy.example:8443",
            "HTTP_PROXY": "http://proxy.example:8080",
        },
        platform="win32",
        probe=probe,
        system_proxy_reader=lambda: {},
    )

    assert proxy == "http://proxy.example:8443"
    assert probed == []


def test_detect_system_proxy_finds_windows_mixed_proxy_port():
    probed = []

    def probe(host, port, timeout):
        probed.append((host, port, timeout))
        return port == 7897

    proxy = detect_system_proxy(
        env={},
        platform="win32",
        probe=probe,
        system_proxy_reader=lambda: {},
    )

    assert proxy == "http://127.0.0.1:7897"
    assert probed[0] == ("127.0.0.1", 7897, 0.15)


def test_detect_system_proxy_does_not_probe_local_ports_on_macos():
    probed = []

    def probe(host, port, timeout):
        probed.append((host, port, timeout))
        return True

    assert (
        detect_system_proxy(
            env={"HTTPS_PROXY": "http://mac-proxy.example:8443"},
            platform="darwin",
            probe=probe,
            system_proxy_reader=lambda: {
                "https": "http://registered-mac-proxy.example:8443"
            },
        )
        is None
    )
    assert probed == []


def test_detect_system_proxy_uses_registered_windows_proxy_before_port_probe():
    probed = []

    proxy = detect_system_proxy(
        env={},
        platform="win32",
        probe=lambda host, port, timeout: probed.append((host, port, timeout)),
        system_proxy_reader=lambda: {
            "https": "http://127.0.0.1:8899",
        },
    )

    assert proxy == "http://127.0.0.1:8899"
    assert probed == []


def test_http_proxy_probe_accepts_http_connect_success(monkeypatch):
    fake = _FakeProxySocket(b"HTTP/1.1 200 Connection established\r\n")
    monkeypatch.setattr(
        system_proxy.socket,
        "create_connection",
        lambda _address, timeout: fake,
    )

    assert system_proxy._probe_http_proxy("127.0.0.1", 7897, 0.15) is True
    assert fake.timeout == 0.15
    assert fake.sent.startswith(b"CONNECT www.youtube.com:443 HTTP/1.1\r\n")


def test_http_proxy_probe_rejects_socks_listener(monkeypatch):
    fake = _FakeProxySocket(b"\x05\xff")
    monkeypatch.setattr(
        system_proxy.socket,
        "create_connection",
        lambda _address, timeout: fake,
    )

    assert system_proxy._probe_http_proxy("127.0.0.1", 7891, 0.15) is False
