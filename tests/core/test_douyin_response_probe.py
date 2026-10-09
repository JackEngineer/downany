from __future__ import annotations

import importlib.util
import io
import json
import os
import sqlite3
import time
from pathlib import Path
from urllib.error import URLError
from urllib.parse import quote
from urllib.request import Request

import pytest


SCRIPT = Path(__file__).resolve().parents[2] / "scripts/probe_douyin_response.py"
VIDEO_URL = "https://www.douyin.com/video/123456789"
SECRET = "private-cookie-and-account-value"


@pytest.fixture
def probe():
    assert SCRIPT.exists(), "The sanitized Douyin response probe is not implemented"
    spec = importlib.util.spec_from_file_location("douyin_response_probe", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _database(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA wal_autocheckpoint=0")
    conn.execute(
        "CREATE TABLE moz_cookies "
        "(name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, isSecure INTEGER)"
    )
    conn.commit()
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    return conn


def _add_cookie(conn, name="sessionid", host=".douyin.com", path="/", expiry=None, secure=1):
    conn.execute(
        "INSERT INTO moz_cookies VALUES (?, ?, ?, ?, ?, ?)",
        (name, SECRET, host, path, expiry if expiry is not None else int(time.time()) + 3600, secure),
    )
    conn.commit()


def test_main_snapshot_and_live_wal_remain_distinct_and_read_only(probe, tmp_path):
    path = tmp_path / "cookies.sqlite"
    with _database(path) as conn:
        _add_cookie(conn)
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        _add_cookie(conn, name="s_v_web_id")
        original = path.read_bytes()
        original_wal = Path(str(path) + "-wal").read_bytes()

        main_jar, main = probe.read_snapshot(path, immutable=True)
        live_jar, live = probe.read_snapshot(path, immutable=False)

        assert main["snapshotCookieCount"] == 1
        assert main["sessionCookieUnexpired"] is True
        assert main["verificationMarkerPresent"] is False
        assert live["snapshotCookieCount"] == 2
        assert live["verificationMarkerPresent"] is True
        assert len(main_jar) == 1 and len(live_jar) == 2
        assert path.read_bytes() == original
        assert Path(str(path) + "-wal").read_bytes() == original_wal
        assert SECRET not in json.dumps([main, live])


def test_cookie_scope_expiry_secure_and_path_are_respected(probe, tmp_path):
    path = tmp_path / "cookies.sqlite"
    with _database(path) as conn:
        _add_cookie(conn, "good")
        _add_cookie(conn, "external", host="douyin.com.evil.test")
        _add_cookie(conn, "expired", expiry=1)
        _add_cookie(conn, "api_path", path="/aweme")
        _add_cookie(conn, "host_only", host="douyin.com")
        jar, flags = probe.read_snapshot(path, immutable=False)
        request = Request(VIDEO_URL)
        jar.add_cookie_header(request)
        assert request.get_header("Cookie") == "good=" + SECRET
        insecure = Request("http://www.douyin.com/video/123456789")
        jar.add_cookie_header(insecure)
        assert insecure.get_header("Cookie") is None
        assert flags["snapshotCookieCount"] == 4


def test_latest_profile_uses_database_mtime(probe, tmp_path):
    profiles = tmp_path / "Mozilla/Firefox/Profiles"
    old = profiles / "first/cookies.sqlite"
    new = profiles / "second/cookies.sqlite"
    old.parent.mkdir(parents=True)
    new.parent.mkdir(parents=True)
    old.touch()
    new.touch()
    os.utime(old, (1, 1))
    os.utime(new, (2, 2))
    assert probe.select_database({"APPDATA": str(tmp_path)}) == new


@pytest.mark.parametrize("schema,multiplier", [(15, 1), (16, 1000), (17, 1000)])
def test_firefox_expiry_units_follow_schema_version(probe, tmp_path, schema, multiplier):
    path = tmp_path / "cookies.sqlite"
    with _database(path) as conn:
        conn.execute(f"PRAGMA user_version={schema}")
        _add_cookie(conn, "sessionid", expiry=(int(time.time()) - 60) * multiplier)
        _add_cookie(conn, "s_v_web_id", expiry=(int(time.time()) + 60) * multiplier)
        jar, flags = probe.read_snapshot(path, immutable=False)
        assert flags["schemaVersion"] == schema
        assert flags["sessionCookieUnexpired"] is False
        assert flags["verificationMarkerPresent"] is True
        assert len(jar) == 1


def test_session_cookie_without_expiry_remains_in_memory(probe, tmp_path):
    path = tmp_path / "cookies.sqlite"
    with _database(path) as conn:
        conn.execute("PRAGMA user_version=16")
        conn.execute("INSERT INTO moz_cookies VALUES (?, ?, ?, ?, ?, ?)",
                     ("sessionid", SECRET, ".douyin.com", "/", None, 1))
        conn.commit()
        jar, flags = probe.read_snapshot(path, immutable=False)
        assert flags["sessionCookieUnexpired"] is True
        assert len(jar) == 1
        assert next(iter(jar)).expires is None


@pytest.mark.parametrize("url", [
    "http://www.douyin.com/video/123", "https://evil.test/video/123",
    "https://www.douyin.com.evil.test/video/123", "https://user@www.douyin.com/video/123",
    "https://www.douyin.com/video/123?token=" + SECRET,
    "https://www.douyin.com:443/video/123", "https://www.douyin.com/video/no-id", "",
])
def test_unapproved_url_is_rejected_before_network(probe, url):
    with pytest.raises(probe.ProbeError, match="^invalid_input$"):
        probe.validate_video_url(url)


@pytest.mark.parametrize("destination", [
    "https://evil.test/" + SECRET, "http://www.douyin.com/video/123",
    "https://www.douyin.com/other",
])
def test_all_redirects_are_blocked_without_disclosing_location(probe, destination):
    with pytest.raises(probe.ProbeError, match="^redirect_blocked$"):
        probe.NoRedirect().redirect_request(Request(VIDEO_URL), None, 302, SECRET, {}, destination)


@pytest.mark.parametrize("body,content_type,kind,valid,detail,matches,video", [
    (b"", "application/json", "empty", False, False, False, False),
    (b"false", "application/json", "json", True, False, False, False),
    (b'{"aweme_detail":{"aweme_id":"123456789","video":{}}}', "application/json", "json", True, True, True, True),
    (b'{"aweme_detail":{"video":{}}}', "application/json", "json", True, True, False, True),
    (b'{"aweme_detail":null}', "application/json", "json", True, False, False, False),
    (b"<html>verification</html>", "text/html", "html", False, False, False, False),
    (b"invalid", "application/json", "text", False, False, False, False),
])
def test_response_classification_does_not_infer_missing_details(probe, body, content_type, kind, valid, detail, matches, video):
    result = probe.classify_response(body, content_type, "123456789", 200)
    assert result["contentKind"] == kind
    assert result["jsonValid"] is valid
    assert result["awemeDetailPresent"] is detail
    assert result["requestedIdMatches"] is matches
    assert result["videoObjectPresent"] is video


@pytest.mark.parametrize("detail,nonempty", [(None, False), ({}, False), ({"video": {}}, True)])
def test_empty_detail_is_distinguished_from_usable_nonempty_object(probe, detail, nonempty):
    result = probe.classify_response(json.dumps({"aweme_detail": detail}).encode(), "application/json", "123456789", 200)
    assert result["awemeDetailNonempty"] is nonempty


def test_encoded_render_data_is_parsed_without_emitting_payload(probe):
    payload = {"nested": [{"awemeId": "123456789", "video": {"secret": SECRET}}]}
    body = ('<script id="RENDER_DATA">' + quote(json.dumps(payload)) + '</script>').encode()
    result = probe.classify_response(body, "text/html", "123456789", 200)
    assert result["renderDataJsonValid"] is True
    assert result["renderDataRequestedVideoPresent"] is True
    assert SECRET not in json.dumps(result)
    assert "123456789" not in json.dumps(result)


def test_render_data_needs_matching_id_and_video_in_same_object(probe):
    payload = [{"itemId": "123456789"}, {"video": {}}, {"item_id": "other", "video": {}}]
    body = ('<script id="RENDER_DATA">' + quote(json.dumps(payload)) + '</script>').encode()
    result = probe.classify_response(body, "text/html", "123456789", 200)
    assert result["renderDataJsonValid"] is True
    assert result["renderDataRequestedVideoPresent"] is False
    assert probe.contains_requested_video([None] * 50000 + [{"itemId": "123456789", "video": {}}], "123456789") is False


def test_fetch_caps_body_and_uses_only_fixed_failure_categories(probe):
    class Response(io.BytesIO):
        status = 200
        headers = {"Content-Type": "text/html"}

    class Transport:
        def open(self, request, timeout):
            assert timeout == 20
            assert request.get_header("User-agent") == (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            )
            assert request.get_header("Accept") == "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            assert request.get_header("Accept-language") == "en-US,en;q=0.9"
            assert request.get_header("Accept-encoding") == "identity"
            return Response(b"x" * (2 * 1024 * 1024 + 20))

    result = probe.fetch(VIDEO_URL, probe.empty_cookie_jar(), "123456789", opener=Transport())
    assert result["bodyBytes"] == 2 * 1024 * 1024
    assert result["truncated"] is True

    class BrokenTransport:
        def open(self, request, timeout):
            raise URLError(SECRET)

    result = probe.fetch(VIDEO_URL, probe.empty_cookie_jar(), "123456789", opener=BrokenTransport())
    assert result["errorCategory"] == "network_error"
    assert SECRET not in json.dumps(result)


def test_main_sanitizes_top_level_exceptions_and_argument_errors(probe, monkeypatch, capsys, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(probe, "run_probe", lambda environ: (_ for _ in ()).throw(RuntimeError(SECRET)))
    assert probe.main(["--output", "report.json"]) == 1
    output = capsys.readouterr()
    assert SECRET not in output.out + output.err + Path("report.json").read_text()
    assert json.loads(output.out)["errorCategory"] == "internal_error"
    assert probe.main(["--unexpected", SECRET]) == 1
    output = capsys.readouterr()
    assert SECRET not in output.out + output.err
    assert json.loads(output.out)["errorCategory"] == "invalid_input"


def test_output_path_cannot_escape_or_overwrite_existing_file(probe, tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    existing = tmp_path / "existing.json"
    existing.write_text(SECRET)
    monkeypatch.setattr(probe, "run_probe", lambda environ: pytest.fail("Invalid output must reject before reading cookies"))
    for output in ["../escape.json", str(tmp_path / "absolute.json"), "existing.json", "report.txt"]:
        assert probe.main(["--output", output]) == 1
        assert json.loads(capsys.readouterr().out)["errorCategory"] == "invalid_output"
    assert existing.read_text() == SECRET


def test_run_probe_requests_exactly_three_fixed_endpoints(probe, tmp_path, monkeypatch):
    monkeypatch.setattr(probe.sys, "platform", "win32")
    path = tmp_path / "Mozilla/Firefox/Profiles/active/cookies.sqlite"
    with _database(path) as conn:
        _add_cookie(conn)
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        calls = []

        def request(url, jar, video_id):
            calls.append(url)
            return probe.classify_response(b"", "", video_id, 200)

        monkeypatch.setattr(probe, "fetch", request)
        report = probe.run_probe({"APPDATA": str(tmp_path), "DOWNANY_DOUYIN_01": VIDEO_URL})
        assert calls == [
            "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=123456789",
            "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=123456789",
            VIDEO_URL,
        ]
        assert report["purpose"] == "auxiliary_urllib_diagnostic"
        assert report["headerProfile"] == "downany_default_identity_encoding"
        assert report["candidateAcceptance"] is False
        assert SECRET not in json.dumps(report)
        assert VIDEO_URL not in json.dumps(report)
