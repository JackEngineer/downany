from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
HELPERS = REPO_ROOT / "scripts" / "windows_release_helpers.ps1"

pytestmark = pytest.mark.skipif(
    sys.platform != "win32",
    reason="Windows release helpers require PowerShell on Windows",
)


def _powershell_literal(path: Path) -> str:
    return str(path).replace("'", "''")


def _resolve_electron_dist(desktop_path: Path) -> subprocess.CompletedProcess[str]:
    command = (
        f". '{_powershell_literal(HELPERS)}'; "
        f"Get-DownanyElectronDist -DesktopPath '{_powershell_literal(desktop_path)}'"
    )
    return subprocess.run(
        ["pwsh", "-NoProfile", "-NonInteractive", "-Command", command],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


def _electron_build_arguments(desktop_path: Path) -> subprocess.CompletedProcess[str]:
    command = (
        f". '{_powershell_literal(HELPERS)}'; "
        f"@(Get-DownanyElectronBuildArguments -DesktopPath "
        f"'{_powershell_literal(desktop_path)}') | ConvertTo-Json -Compress"
    )
    return subprocess.run(
        ["pwsh", "-NoProfile", "-NonInteractive", "-Command", command],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


def test_resolves_installed_electron_distribution(tmp_path: Path) -> None:
    desktop_path = tmp_path / "desktop"
    electron_executable = (
        desktop_path / "node_modules" / "electron" / "dist" / "electron.exe"
    )
    electron_executable.parent.mkdir(parents=True)
    electron_executable.write_bytes(b"MZ")

    result = _resolve_electron_dist(desktop_path)

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "node_modules/electron/dist"


def test_rejects_missing_electron_runtime(tmp_path: Path) -> None:
    result = _resolve_electron_dist(tmp_path / "desktop")

    assert result.returncode != 0
    assert "未找到 Electron runtime" in result.stderr


def test_build_arguments_pin_the_installed_electron_distribution(
    tmp_path: Path,
) -> None:
    desktop_path = tmp_path / "desktop"
    electron_executable = (
        desktop_path / "node_modules" / "electron" / "dist" / "electron.exe"
    )
    electron_executable.parent.mkdir(parents=True)
    electron_executable.write_bytes(b"MZ")

    result = _electron_build_arguments(desktop_path)

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == [
        "run",
        "dist:win",
        "--",
        "--config.electronDist=node_modules/electron/dist",
    ]
