"""先选择下载引擎，再进入协议服务或同版本解析子进程。"""
from __future__ import annotations

import importlib
import json
import sys
from typing import Optional

from src.core.ytdlp_runtime import activate_engine


def main(argv: Optional[list[str]] = None) -> int:
    # 参数、引擎激活和探测导入也会输出中文错误，须先固定管道编码。
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    args = list(sys.argv[1:] if argv is None else argv)
    mode = "server"
    selection = None
    cli_args: list[str] = []
    if args:
        if len(args) == 3 and args[:2] == ["--engine-probe", "--engine-id"]:
            mode, selection = "probe", args[2]
        elif len(args) >= 4 and args[:2] == ["--engine-cli", "--engine-id"] and args[3] == "--":
            mode, selection, cli_args = "cli", args[2], args[4:]
        else:
            sys.stderr.write("无法识别启动参数。\n")
            return 2

    try:
        engine = activate_engine(selection)
    except (ValueError, RuntimeError, OSError, ImportError):
        # 启动错误可能包含本地路径；工具模式不输出原文或协议 hello。
        sys.stderr.write("无法启动下载引擎，请重新更新后重试。\n")
        return 2

    if mode == "probe":
        try:
            # 只导入实际消费者，不创建服务/队列，提前发现新版库接口不兼容。
            importlib.import_module("src.sidecar.server")
            importlib.import_module("src.core.video_info_extractor")
        except (Exception, SystemExit):
            sys.stderr.write("新版下载工具与当前应用不兼容。\n")
            return 2
        sys.stdout.write(json.dumps(engine, ensure_ascii=True) + "\n")
        return 0
    if mode == "cli":
        importlib.import_module("yt_dlp").main(cli_args)
        return 0

    # server 会导入下载器并绑定 YoutubeDL，必须晚于引擎选择。
    return importlib.import_module("src.sidecar.server").main()
