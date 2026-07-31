"""Cookie 头 → Netscape cookiefile（供 yt-dlp cookiejar / Instagram 登录态）。"""

from src.core.ytdlp_cookies import (
    apply_cookie_sources,
    cookie_header_to_netscape,
    cookiefile_domain_for_url,
    materialize_cookiefile,
)


def test_cookiefile_domain_for_instagram():
    assert cookiefile_domain_for_url(
        "https://www.instagram.com/reels/DbC-8YmTgQt/"
    ) == ".instagram.com"


def test_cookie_header_to_netscape_includes_sessionid():
    text = cookie_header_to_netscape(
        "sessionid=abc; csrftoken=tok",
        domain=".instagram.com",
    )
    assert text.startswith("# Netscape HTTP Cookie File")
    assert "sessionid\tabc" in text or "\tsessionid\tabc" in text
    assert ".instagram.com" in text


def test_materialize_cookiefile_writes_readable_file(tmp_path, monkeypatch):
    monkeypatch.setenv("TMPDIR", str(tmp_path))
    path = materialize_cookiefile(
        "sessionid=s1; csrftoken=c1",
        "https://www.instagram.com/p/x/",
    )
    assert path
    content = open(path, encoding="utf-8").read()
    assert "sessionid" in content
    assert "s1" in content


def test_apply_cookie_sources_sets_browser_and_file(tmp_path):
    cookie_path = tmp_path / "cookies.txt"
    cookie_path.write_text("# Netscape\n", encoding="utf-8")
    opts: dict = {}
    apply_cookie_sources(opts, cookies_from_browser="chrome", cookiefile=str(cookie_path))
    assert opts["cookiesfrombrowser"] == ("chrome",)
    assert opts["cookiefile"] == str(cookie_path)


def test_apply_cookie_sources_does_not_override_existing():
    opts = {"cookiesfrombrowser": ("firefox",), "cookiefile": "/existing.txt"}
    apply_cookie_sources(opts, cookies_from_browser="chrome", cookiefile="/new.txt")
    assert opts["cookiesfrombrowser"] == ("firefox",)
    assert opts["cookiefile"] == "/existing.txt"
