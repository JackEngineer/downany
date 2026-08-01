# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec：无 Qt 的 VideoDownloader Sidecar（onedir，避免 onefile 解压慢导致握手超时）。"""
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

ROOT = Path(SPECPATH).resolve().parent
block_cipher = None

hidden = collect_submodules("yt_dlp")
hidden += [
    "src.sidecar",
    "src.sidecar.server",
    "src.sidecar.handlers",
    "src.core.download_manager",
    "src.core.downloader",
    "src.data.database",
    "src.data.json_config",
    "src.data.queue_store",
]

a = Analysis(
    [str(ROOT / "src" / "sidecar" / "__main__.py")],
    pathex=[str(ROOT)],
    binaries=[],
    datas=[],
    hiddenimports=hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["PyQt6", "PyQt5", "tkinter", "matplotlib"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="VideoDownloaderSidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="VideoDownloaderSidecar",
)
