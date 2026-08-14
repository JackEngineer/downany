"""yt-dlp JavaScript challenge runtime selection."""

from src.core import ytdlp_opts


def test_resolve_js_runtimes_enables_node_when_deno_is_missing(monkeypatch):
    """Node must be explicitly enabled; yt-dlp only enables Deno by default."""

    def fake_which(name: str):
        if name in {"node", "node.exe"}:
            return r"C:\Program Files\nodejs\node.exe"
        return None

    monkeypatch.setattr(ytdlp_opts.shutil, "which", fake_which)

    assert ytdlp_opts.resolve_js_runtimes() == {
        "node": {"path": r"C:\Program Files\nodejs\node.exe"},
    }
