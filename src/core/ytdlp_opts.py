"""yt-dlp 公共选项与运行时保障。

YouTube 等站点要求执行 JS challenge（nsig/signature）才能拿到完整格式列表；
yt-dlp 通过 EJS remote components 自动下载 solver 脚本，并调用本机 JS 运行时
（deno）求解，见 https://github.com/yt-dlp/yt-dlp/wiki/EJS 。

不配 remote_components 时签名求解被跳过，只剩免签名低画质格式
（如 itag=18 360p），高画质选择器报 "Requested format is not available"。
"""
import os
import shutil
import sys
from pathlib import Path

# 允许 yt-dlp 按需拉取的远程组件（EJS challenge solver）
REMOTE_COMPONENTS = ["ejs:github"]

_DENO_DIRS = (
    "/opt/homebrew/bin",
    "/usr/local/bin",
    str(Path.home() / ".deno" / "bin"),
)


def _deno_name() -> str:
    return "deno.exe" if sys.platform == "win32" else "deno"


def ensure_js_runtime_path() -> None:
    """GUI / 打包环境 PATH 可能不含 homebrew：补全 deno 常见安装位置。"""
    if shutil.which("deno") or shutil.which("deno.exe"):
        return
    for directory in _DENO_DIRS:
        if (Path(directory) / _deno_name()).exists():
            os.environ["PATH"] = (
                directory + os.pathsep + os.environ.get("PATH", "")
            )
            return


# 导入即修补 PATH：保证所有 yt-dlp 使用点（含未来新增）都能找到 deno
ensure_js_runtime_path()
