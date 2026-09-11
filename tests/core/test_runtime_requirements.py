"""Keep development media features aligned with the packaged Sidecar."""

from pathlib import Path

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name


PROJECT_ROOT = Path(__file__).resolve().parents[2]
YTDLP_DISTRIBUTION_VERSION = "2026.8.19"
YTDLP_RUNTIME_VERSION = "2026.08.19"
YTDLP_MACOS_SHA256 = "0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202"
YTDLP_WINDOWS_SHA256 = "66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a"


def _requirement(path: Path, package_name: str) -> Requirement:
    wanted = canonicalize_name(package_name)
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        requirement = Requirement(line)
        if canonicalize_name(requirement.name) == wanted:
            return requirement
    raise AssertionError(f"{package_name} is missing from {path.relative_to(PROJECT_ROOT)}")


def test_development_ytdlp_features_match_packaged_runtime():
    development = _requirement(PROJECT_ROOT / "requirements.txt", "yt-dlp")
    packaged = _requirement(
        PROJECT_ROOT / "packaging" / "requirements-sidecar.txt",
        "yt-dlp",
    )

    assert development.specifier == packaged.specifier
    assert development.specifier.contains(YTDLP_DISTRIBUTION_VERSION)
    assert development.extras == packaged.extras
    assert {"default", "curl-cffi"} <= development.extras


def test_release_fetchers_pin_the_same_ytdlp_release_and_official_hashes():
    shell = (PROJECT_ROOT / "scripts" / "fetch_release_binaries.sh").read_text(
        encoding="utf-8"
    )
    powershell = (
        PROJECT_ROOT / "scripts" / "fetch_release_binaries.ps1"
    ).read_text(encoding="utf-8")

    for script in (shell, powershell):
        assert YTDLP_RUNTIME_VERSION in script
        assert YTDLP_WINDOWS_SHA256 in script
    assert YTDLP_MACOS_SHA256 in shell
