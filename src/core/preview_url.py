"""Normalize search/preview video identifiers into openable URLs."""
from __future__ import annotations

import re


def normalize_video_url(raw_value: str) -> str:
    """Turn bare YouTube/Bilibili IDs into https URLs; pass through full URLs."""
    value = (raw_value or "").strip()
    if value.startswith(("http://", "https://")):
        return value

    if re.fullmatch(r"[0-9A-Za-z_-]{11}", value):
        return f"https://www.youtube.com/watch?v={value}"

    if re.fullmatch(r"BV[0-9A-Za-z]{10}", value, re.IGNORECASE):
        return f"https://www.bilibili.com/video/{value}"

    return value
