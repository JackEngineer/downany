"""yt-dlp formats 列表裁剪：每分辨率取最优项，供前端画质选择。"""
from __future__ import annotations

from typing import Any, Dict, List


def summarize_formats(formats: List[Dict[str, Any]] | None) -> List[Dict[str, Any]]:
    """
    把 yt-dlp 的全量 formats 裁剪为「每分辨率最优」的选项列表（按高度降序）。

    每项字段：format_id / ext / height / fps / filesize / tbr / video_only。
    音频项不进列表（前端用「仅音频」开关代替）；storyboard 等无效项剔除。
    """
    best_by_height: Dict[int, Dict[str, Any]] = {}
    for fmt in formats or []:
        if not isinstance(fmt, dict):
            continue
        format_id = fmt.get("format_id")
        if not format_id:
            continue
        vcodec = fmt.get("vcodec")
        acodec = fmt.get("acodec")
        has_video = vcodec not in (None, "none")
        has_audio = acodec not in (None, "none")
        if not has_video:
            continue
        height = int(fmt.get("height") or 0)
        if height <= 0:
            continue
        tbr = float(fmt.get("tbr") or 0)
        filesize = int(fmt.get("filesize") or fmt.get("filesize_approx") or 0)
        entry = {
            "format_id": str(format_id),
            "ext": str(fmt.get("ext") or ""),
            "height": height,
            "fps": int(fmt.get("fps") or 0),
            "filesize": filesize,
            "tbr": round(tbr, 1),
            "video_only": not has_audio,
        }
        current = best_by_height.get(height)
        if current is None or (tbr, has_audio, filesize) > (
            current["tbr"],
            not current["video_only"],
            current["filesize"],
        ):
            best_by_height[height] = entry
    return [best_by_height[h] for h in sorted(best_by_height.keys(), reverse=True)]
