"""Keep development media features aligned with the packaged Sidecar."""

from pathlib import Path

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name


PROJECT_ROOT = Path(__file__).resolve().parents[2]


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
    assert development.extras == packaged.extras
    assert {"default", "curl-cffi"} <= development.extras
