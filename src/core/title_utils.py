"""标题质量：弱标题识别，以及从 yt-dlp info 挑选更可读的标题。"""
from __future__ import annotations

import re
from typing import Any, Dict, Optional

_PLACEHOLDER = {"", "未命名视频", "正在获取信息..."}

_WEAK_EXACT = {
    "instagram",
    "instagram reels",
    "reels",
    "pornhub",
    "pornhub.com",
    "youtube",
    "bilibili",
    "抖音",
    "tiktok",
    "x",
    "twitter",
    "home / x",
}

# yt-dlp Instagram 等常见占位：Video by username
_VIDEO_BY_RE = re.compile(r"^video by\s+\S+$", re.IGNORECASE)
_TAB_SUFFIX_X_RE = re.compile(r"/ x$", re.IGNORECASE)
# 扩展/桥探测用的临时标题，应让位给 yt-dlp 真实标题
_TEMPORARY_TITLE_RE = re.compile(
    r"^(bridge[-_]?probe|probe[-_]?fixed|download[-_]?test)\b",
    re.IGNORECASE,
)
# Instagram og:title：user on Instagram: "caption"
_IG_ON_INSTAGRAM_RE = re.compile(
    r"^.+?\s+on\s+Instagram:\s*(.+)$",
    re.IGNORECASE | re.DOTALL,
)
# B 站 flat 合集常把 BV 号当成标题，应在下载前/后用真实标题覆盖
_BILIBILI_BVID_RE = re.compile(r"^BV[0-9A-Za-z]+$")
# 旧版 av 号
_BILIBILI_AVID_RE = re.compile(r"^av\d+$", re.IGNORECASE)


def is_weak_title(title: str) -> bool:
    text = (title or "").strip()
    if text in _PLACEHOLDER:
        return True
    lower = text.lower()
    if lower in _WEAK_EXACT:
        return True
    if _VIDEO_BY_RE.match(text):
        return True
    if _TEMPORARY_TITLE_RE.match(text):
        return True
    if _BILIBILI_BVID_RE.match(text) or _BILIBILI_AVID_RE.match(text):
        return True
    if _TAB_SUFFIX_X_RE.search(text) and len(text) <= 48:
        # 浏览器标签常见 "… / X"，不是推文正文
        return True
    return False


def _first_line(text: str, limit: int = 160) -> str:
    line = re.split(r"[\r\n]+", (text or "").strip(), maxsplit=1)[0].strip()
    if len(line) > limit:
        return line[:limit].rstrip()
    return line


def unwrap_instagram_og_title(text: str) -> str:
    """把 `user on Instagram: \"caption\"` 收成 caption；否则原样返回。"""
    raw = (text or "").strip()
    if not raw:
        return ""
    matched = _IG_ON_INSTAGRAM_RE.match(raw)
    if not matched:
        return raw
    cap = matched.group(1).strip()
    if len(cap) >= 2 and cap[0] in "\"'\u201c" and cap[-1] in "\"'\u201d":
        cap = cap[1:-1].strip()
    return cap or raw


def pick_title_from_ydl_info(
    info: Optional[Dict[str, Any]],
    current: str = "",
) -> str:
    """
    从 yt-dlp info 选标题。

    扩展/DOM 已抓到的强标题（尤其 X 推文正文）优先保留；
    仅在当前标题很弱时，才用 yt-dlp title / description 补齐。
    """
    if not isinstance(info, dict):
        info = {}
    title = str(info.get("title") or info.get("fulltitle") or "").strip()
    desc = _first_line(str(info.get("description") or ""))
    current = (current or "").strip()

    if current and not is_weak_title(current):
        return current
    if title and not is_weak_title(title):
        return title
    if desc and not is_weak_title(desc):
        return desc
    if title:
        return title
    if current:
        return current
    return "未命名视频"
