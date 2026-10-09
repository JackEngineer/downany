#!/usr/bin/env python3
"""仅在获授权 Windows 设备执行的 urllib 辅助诊断，不代表候选包验收。

用法：预设 DOWNANY_DOUYIN_01 后执行 --output 新的相对路径.json。
Cookie 与响应仅留内存；JSON 只记录固定布尔、计数、状态与类别。
不复制数据库，不写浏览器数据，不跟随重定向，不下载视频。
"""
from __future__ import annotations

import argparse
import datetime
import http.cookiejar
import json
import os
import re
import socket
import sqlite3
import ssl
import sys
import time
from contextlib import closing
from html.parser import HTMLParser
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import unquote
from urllib.request import HTTPRedirectHandler, Request, build_opener


MAX_BODY_BYTES = 2 * 1024 * 1024
MAX_JSON_NODES = 50000
# 与 src/core/http_headers.py 保持一致；脚本复制到验收机后独立运行。
REQUEST_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "identity",
}
ERROR_CATEGORIES = frozenset({
    "none", "invalid_input", "invalid_output", "unsupported_platform", "profile_missing",
    "database_error", "filesystem_error", "tls_error", "timeout", "network_error",
    "redirect_blocked", "internal_error", "interrupted",
})


class ProbeError(Exception):
    def __init__(self, category):
        self.category = category if category in ERROR_CATEGORIES else "internal_error"
        super().__init__(self.category)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # 禁止所有重定向：三次请求的预算包括重定向，且 Cookie 不得跨域。
        raise ProbeError("redirect_blocked")


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise ProbeError("invalid_input")


def error_category(exc):
    if isinstance(exc, ProbeError):
        return exc.category
    if isinstance(exc, KeyboardInterrupt):
        return "interrupted"
    if isinstance(exc, (TimeoutError, socket.timeout)):
        return "timeout"
    if isinstance(exc, ssl.SSLError):
        return "tls_error"
    if isinstance(exc, URLError):
        if isinstance(exc.reason, (TimeoutError, ssl.SSLError)):
            return error_category(exc.reason)
        return "network_error"
    if isinstance(exc, sqlite3.Error):
        return "database_error"
    if isinstance(exc, OSError):
        return "filesystem_error"
    return "internal_error"


def validate_video_url(value):
    match = re.fullmatch(r"https://www\.douyin\.com/video/([0-9]{1,32})", value or "")
    if not match:
        raise ProbeError("invalid_input")
    return match.group(1)


def select_database(environ):
    appdata = environ.get("APPDATA")
    if not appdata:
        raise ProbeError("profile_missing")
    candidates = list((Path(appdata) / "Mozilla/Firefox/Profiles").glob("*/cookies.sqlite"))
    if not candidates:
        raise ProbeError("profile_missing")
    return max(candidates, key=lambda path: path.stat().st_mtime)


def empty_cookie_jar():
    return http.cookiejar.CookieJar(http.cookiejar.DefaultCookiePolicy(
        strict_ns_domain=http.cookiejar.DefaultCookiePolicy.DomainStrictNonDomain,
    ))


def read_snapshot(path, *, immutable):
    uri = path.resolve().as_uri() + "?mode=ro" + ("&immutable=1" if immutable else "")
    with closing(sqlite3.connect(uri, uri=True, timeout=2)) as conn:
        conn.execute("PRAGMA query_only=ON")
        schema = int(conn.execute("PRAGMA user_version").fetchone()[0])
        rows = conn.execute(
            "SELECT name,value,host,path,expiry,isSecure FROM moz_cookies "
            "WHERE lower(host) IN ('douyin.com', '.douyin.com') "
            "OR lower(host) LIKE '%.douyin.com'"
        ).fetchall()
    jar = empty_cookie_jar()
    flags = {
        "schemaVersion": schema, "snapshotCookieCount": len(rows), "usableCookieCount": 0,
        "sessionCookieUnexpired": False, "verificationMarkerPresent": False,
    }
    now = time.time()
    for name, value, domain, path_value, expires, secure in rows:
        if expires is not None:
            expires = int(int(expires) / (1000 if schema >= 16 else 1))
        if expires is not None and expires <= now:
            continue
        if any(not isinstance(part, str) or re.search(r"[\x00-\x1f\x7f]", part)
               for part in (name, value, domain, path_value)):
            continue
        if not name or re.search(r"[=;,\s]", name) or not path_value.startswith("/"):
            continue
        if name == "sessionid":
            flags["sessionCookieUnexpired"] = True
        if name == "s_v_web_id":
            flags["verificationMarkerPresent"] = True
        jar.set_cookie(http.cookiejar.Cookie(
            version=0, name=name, value=value, port=None, port_specified=False,
            domain=domain.lower(), domain_specified=domain.startswith("."),
            domain_initial_dot=domain.startswith("."), path=path_value, path_specified=True,
            secure=bool(secure), expires=expires, discard=False,
            comment=None, comment_url=None, rest={}, rfc2109=False,
        ))
    flags["usableCookieCount"] = len(jar)
    return jar, flags


class RenderDataParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.in_render = False
        self.parts = []
        self.blocks = []

    def handle_starttag(self, tag, attrs):
        if tag == "script" and dict(attrs).get("id") == "RENDER_DATA":
            self.in_render = True
            self.parts = []

    def handle_data(self, data):
        if self.in_render:
            self.parts.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self.in_render:
            self.blocks.append("".join(self.parts))
            self.in_render = False


def contains_requested_video(data, video_id):
    stack = [iter((data,))]
    visited = 0
    while stack and visited < MAX_JSON_NODES:
        try:
            node = next(stack[-1])
        except StopIteration:
            stack.pop()
            continue
        visited += 1
        if isinstance(node, dict):
            matches = any(str(node.get(key, "")) == video_id
                          for key in ("aweme_id", "awemeId", "item_id", "itemId"))
            if matches and isinstance(node.get("video"), dict):
                return True
            stack.append(iter(node.values()))
        elif isinstance(node, list):
            stack.append(iter(node))
    return False


def classify_response(body, content_type, video_id, status, *, truncated=False):
    text = body.decode("utf-8", errors="replace")
    stripped = text.lstrip()
    result = {
        "errorCategory": "none", "httpStatus": status if isinstance(status, int) and 100 <= status <= 599 else 0,
        "contentKind": "empty" if not body else "text", "bodyBytes": len(body), "truncated": truncated,
        "jsonValid": False, "awemeDetailPresent": False, "awemeDetailNonempty": False,
        "requestedIdMatches": False,
        "videoObjectPresent": False, "renderDataPresent": "RENDER_DATA" in text,
        "renderDataJsonValid": False, "renderDataRequestedVideoPresent": False,
        "nextDataPresent": "__NEXT_DATA__" in text, "routerDataPresent": "_ROUTER_DATA" in text,
        "paceDataPresent": "self.__pace_f" in text,
        "verificationTextPresent": any(marker in text.lower() for marker in (
            "captcha", "verifycenter", "验证中心", "安全验证", "滑块验证", "verification",
        )),
    }
    try:
        data = json.loads(text)
        result["jsonValid"] = True
        result["contentKind"] = "json"
        detail = data.get("aweme_detail") if isinstance(data, dict) else None
        if isinstance(detail, dict):
            result["awemeDetailPresent"] = True
            result["awemeDetailNonempty"] = bool(detail)
            result["requestedIdMatches"] = str(detail.get("aweme_id", "")) == video_id
            result["videoObjectPresent"] = isinstance(detail.get("video"), dict)
    except (ValueError, RecursionError):
        if body and ("html" in content_type.lower() or stripped.startswith("<")):
            result["contentKind"] = "html"
    if result["contentKind"] == "html" and result["renderDataPresent"]:
        parser = RenderDataParser()
        parser.feed(text)
        for block in parser.blocks:
            try:
                data = json.loads(unquote(block))
            except (ValueError, RecursionError):
                continue
            result["renderDataJsonValid"] = True
            result["renderDataRequestedVideoPresent"] |= contains_requested_video(data, video_id)
    return result


def fetch(url, jar, video_id, *, opener=None):
    # URL 由固定端点构造；CookieJar 只给本次请求写 Cookie，不吸收 Set-Cookie。
    request = Request(url, headers=REQUEST_HEADERS)
    jar.add_cookie_header(request)
    try:
        transport = opener if opener is not None else build_opener(NoRedirect())
        try:
            response = transport.open(request, timeout=20)
        except HTTPError as exc:
            response = exc
        with closing(response):
            body = response.read(MAX_BODY_BYTES)
            return classify_response(body, response.headers.get("Content-Type", ""), video_id,
                                     response.status, truncated=len(body) == MAX_BODY_BYTES)
    except (Exception, KeyboardInterrupt) as exc:
        result = classify_response(b"", "", video_id, 0)
        result["errorCategory"] = error_category(exc)
        return result


def base_report():
    return {
        "purpose": "auxiliary_urllib_diagnostic", "candidateAcceptance": False,
        "headerProfile": "downany_default_identity_encoding",
        "recordedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "errorCategory": "none",
    }


def run_probe(environ):
    if sys.platform != "win32":
        raise ProbeError("unsupported_platform")
    url = environ.get("DOWNANY_DOUYIN_01", "")
    video_id = validate_video_url(url)
    database = select_database(environ)
    main_jar, main_flags = read_snapshot(database, immutable=True)
    live_jar, live_flags = read_snapshot(database, immutable=False)
    detail_url = "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=" + video_id
    report = base_report()
    report["mainSnapshot"] = main_flags
    report["liveSnapshot"] = live_flags
    report["mainDetailResponse"] = fetch(detail_url, main_jar, video_id)
    report["liveDetailResponse"] = fetch(detail_url, live_jar, video_id)
    report["liveHtmlResponse"] = fetch(url, live_jar, video_id)
    return report


def validate_output(value):
    path = Path(value)
    if path.is_absolute() or ".." in path.parts or path.suffix.lower() != ".json":
        raise ProbeError("invalid_output")
    resolved = path.resolve()
    try:
        resolved.relative_to(Path.cwd().resolve())
    except ValueError:
        raise ProbeError("invalid_output") from None
    if path.exists() or path.is_symlink():
        raise ProbeError("invalid_output")
    if not path.parent.is_dir():
        raise ProbeError("invalid_output")
    return path


def main(argv=None):
    output = None
    try:
        parser = SafeArgumentParser(add_help=False)
        parser.add_argument("--output", required=True)
        args = parser.parse_args(argv)
        output = validate_output(args.output)
        report = run_probe(os.environ)
    except (Exception, KeyboardInterrupt) as exc:
        report = base_report()
        report["errorCategory"] = error_category(exc)
    if output is not None:
        try:
            with output.open("x", encoding="utf-8") as stream:
                json.dump(report, stream, ensure_ascii=True, indent=2)
                stream.write("\n")
        except (Exception, KeyboardInterrupt) as exc:
            report = base_report()
            report["errorCategory"] = error_category(exc)
    print(json.dumps(report, ensure_ascii=True))
    return int(report["errorCategory"] != "none")


if __name__ == "__main__":
    raise SystemExit(main())
