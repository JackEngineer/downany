"""协议常量冻结测试。"""
from src.sidecar.protocol import PROTOCOL_VERSION, ErrorCode, Method, EventName


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
    }
    assert {m.value for m in Method} == required


def test_error_codes_are_stable_strings():
    assert ErrorCode.INVALID_MESSAGE.value == "INVALID_MESSAGE"
    assert ErrorCode.PROTOCOL_MISMATCH.value == "PROTOCOL_MISMATCH"
    assert ErrorCode.METHOD_NOT_FOUND.value == "METHOD_NOT_FOUND"
    assert ErrorCode.NOT_IMPLEMENTED.value == "NOT_IMPLEMENTED"
    assert ErrorCode.INTERNAL.value == "INTERNAL"
