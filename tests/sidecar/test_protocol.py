"""协议常量冻结测试。"""
import json
from pathlib import Path

from src.sidecar.protocol import (
    APP_VERSION,
    PROTOCOL_VERSION,
    ErrorCode,
    EventName,
    Method,
)


PROJECT_ROOT = Path(__file__).resolve().parents[2]


def test_candidate_version_matches_desktop_package():
    package = json.loads(
        (PROJECT_ROOT / "desktop" / "package.json").read_text(encoding="utf-8")
    )
    lockfile = json.loads(
        (PROJECT_ROOT / "desktop" / "package-lock.json").read_text(encoding="utf-8")
    )

    assert {
        "desktop": package["version"],
        "lockfile": lockfile["version"],
        "lockfile_root": lockfile["packages"][""]["version"],
        "sidecar": APP_VERSION,
    } == dict.fromkeys(("desktop", "lockfile", "lockfile_root", "sidecar"), "0.3.0")


def test_protocol_version_is_one():
    assert PROTOCOL_VERSION == 1


def test_required_methods_exist():
    required = {
        "app.getSnapshot",
        "app.ping",
        "app.shutdown",
        "app.runMigration",
        "app.exportDiagnostics",
        "download.parseUrls",
        "download.cancelParse",
        "download.createTasks",
        "download.pause",
        "download.pauseAll",
        "download.resume",
        "download.resumeAll",
        "download.cancel",
        "download.retry",
        "download.remove",
        "download.removeGroup",
        "download.applyGroupAction",
        "download.clearFinished",
        "download.updateTask",
        "download.reorder",
        "search.query",
        "history.list",
        "history.delete",
        "history.clear",
        "settings.get",
        "settings.update",
        "updater.checkYtDlp",
        "updater.checkHealth",
        "updater.updateYtDlp",
        "telegram.getConfig",
        "telegram.configure",
        "telegram.listDeliveries",
        "telegram.claimNext",
        "telegram.renewLease",
        "telegram.releaseClaim",
        "telegram.markSending",
        "telegram.setSegmentManifest",
        "telegram.markSegmentSent",
        "telegram.markFallbackUsed",
        "telegram.markSent",
        "telegram.markRetry",
        "telegram.markRetryNotSubmitted",
        "telegram.markFailed",
        "telegram.markUncertain",
        "telegram.markSkippedOversize",
        "telegram.markTargetFailed",
        "telegram.retry",
        "telegram.cancelPending",
        "telegram.getTargetBlock",
        "telegram.clearTargetBlock",
    }
    assert {m.value for m in Method} == required


def test_error_codes_are_stable_strings():
    assert ErrorCode.INVALID_MESSAGE.value == "INVALID_MESSAGE"
    assert ErrorCode.PROTOCOL_MISMATCH.value == "PROTOCOL_MISMATCH"
    assert ErrorCode.METHOD_NOT_FOUND.value == "METHOD_NOT_FOUND"
    assert ErrorCode.NOT_IMPLEMENTED.value == "NOT_IMPLEMENTED"
    assert ErrorCode.INTERNAL.value == "INTERNAL"
