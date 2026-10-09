"""冷启动进程验证引擎选择；合成归档只证明加载协议，不代表官方升级验收。"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import textwrap
import zipfile

import pytest


ROOT = Path(__file__).resolve().parents[2]
VERSION = "2026.09.27"
SECRET = "private-cookie-and-path-must-not-leak"


def _archive(tmp_path, *, version=VERSION, init=None, omit=(), extra=None):
    entries = {
        "__main__.py": "from yt_dlp import main\nmain()\n",
        "yt_dlp/__init__.py": init or "ENGINE_MARKER = 'synthetic'\n",
        "yt_dlp/version.py": f"__version__ = {version!r}\n",
        "yt_dlp_ejs/__init__.py": "version = 'synthetic-ejs'\n",
    }
    entries.update(extra or {})
    temporary = tmp_path / "candidate.zip"
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in entries.items():
            if name not in omit:
                # ZipInfo normally rewrites Windows separators and truncates NUL.
                # Preserve malformed names so the fixture contains the raw input.
                member = zipfile.ZipInfo(name)
                member.filename = member.orig_filename = name
                member.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(member, content)
    with zipfile.ZipFile(temporary) as archive:
        assert [member.orig_filename for member in archive.infolist()] == [
            name for name in entries if name not in omit
        ]
    digest = hashlib.sha256(temporary.read_bytes()).hexdigest()
    directory = tmp_path / "engines" / digest
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "yt-dlp.zip"
    temporary.replace(path)
    return digest, path


def _active(tmp_path, digest, version=VERSION, **changes):
    manifest = {"schemaVersion": 1, "sha256": digest, "version": version, **changes}
    directory = tmp_path / "engines"
    directory.mkdir(exist_ok=True)
    (directory / "active.json").write_text(json.dumps(manifest), encoding="utf-8")


def _run(tmp_path, body):
    code = (
        "import json, sys\n"
        "from src.core.ytdlp_runtime import activate_engine, current_engine, engine_cli_command\n"
        "try:\n" + textwrap.indent(textwrap.dedent(body), "    ") + "\n"
        "except Exception as exc:\n"
        "    print(json.dumps({'error': str(exc), 'errorType': type(exc).__name__}))\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=ROOT,
        env={**os.environ, "DOWNANY_DATA_DIR": str(tmp_path)},
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=20,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stderr == ""
    assert SECRET not in result.stdout
    assert str(tmp_path) not in result.stdout
    return json.loads(result.stdout)


def test_importing_runtime_does_not_import_engine(tmp_path):
    assert _run(tmp_path, "print(json.dumps({'loaded': 'yt_dlp' in sys.modules}))") == {"loaded": False}


def test_no_pointer_activates_actual_bundled_version_without_creating_data(tmp_path):
    result = _run(tmp_path, """
        info = activate_engine()
        import yt_dlp.version
        print(json.dumps({'info': info, 'actual': yt_dlp.version.__version__}))
    """)
    assert result["info"] == {"version": result["actual"], "source": "bundled", "selection": "bundled"}
    assert not (tmp_path / "engines").exists()


def test_valid_pointer_uses_archive_and_matching_ejs(tmp_path):
    digest, _ = _archive(tmp_path)
    _active(tmp_path, digest)
    result = _run(tmp_path, """
        info = activate_engine()
        import yt_dlp, yt_dlp.version, yt_dlp_ejs
        print(json.dumps({'info': info, 'marker': yt_dlp.ENGINE_MARKER,
                          'ejs': yt_dlp_ejs.version,
                          'same': all(module.__file__.replace(chr(92), '/').startswith(
                                          sys.path[0].replace(chr(92), '/') + '/')
                                      for module in (yt_dlp, yt_dlp.version, yt_dlp_ejs))}))
    """)
    assert result == {
        "info": {"version": VERSION, "source": "updated", "selection": digest},
        "marker": "synthetic", "ejs": "synthetic-ejs", "same": True,
    }


def test_explicit_pin_does_not_follow_new_active_pointer(tmp_path):
    digest, _ = _archive(tmp_path)
    other, _ = _archive(tmp_path, version="2026.09.28")
    _active(tmp_path, other, "2026.09.28")
    assert _run(tmp_path, f"print(json.dumps(activate_engine({digest!r})))") == {
        "version": VERSION, "source": "updated", "selection": digest,
    }


def test_explicit_bundled_ignores_pointer(tmp_path):
    digest, _ = _archive(tmp_path)
    _active(tmp_path, digest)
    result = _run(tmp_path, "print(json.dumps(activate_engine('bundled')))")
    assert result["source"] == result["selection"] == "bundled"
    assert "fallbackReason" not in result


@pytest.mark.parametrize("selection", ["../private", "/tmp/private.zip", "A" * 64, "a" * 63, "", 42])
def test_invalid_explicit_selection_is_safe_error(tmp_path, selection):
    result = _run(tmp_path, f"print(json.dumps(activate_engine({selection!r})))")
    assert result == {"error": "invalid_selection", "errorType": "EngineActivationError"}


@pytest.mark.parametrize("manifest", [
    "not-json", "[]", '{"schemaVersion":true}', '{}', '[' * 1100 + ']' * 1100,
], ids=["not-json", "array", "boolean-schema", "missing-fields", "deep-json"])
def test_invalid_pointer_falls_back_with_fixed_reason(tmp_path, manifest):
    (tmp_path / "engines").mkdir()
    (tmp_path / "engines" / "active.json").write_text(manifest, encoding="utf-8")
    result = _run(tmp_path, "print(json.dumps(activate_engine()))")
    assert result["source"] == "bundled"
    assert result["fallbackReason"] == "invalid_manifest"


@pytest.mark.parametrize("explicit", [False, True])
def test_missing_archive_falls_back_only_for_default_selection(tmp_path, explicit):
    digest = "0" * 64
    _active(tmp_path, digest)
    selection = repr(digest) if explicit else "None"
    result = _run(tmp_path, f"print(json.dumps(activate_engine({selection})))")
    if explicit:
        assert result == {"error": "archive_missing", "errorType": "EngineActivationError"}
    else:
        assert result["source"] == "bundled"
        assert result["fallbackReason"] == "archive_missing"


@pytest.mark.parametrize("explicit", [False, True])
def test_digest_mismatch_never_imports_unverified_archive(tmp_path, explicit):
    digest, path = _archive(tmp_path)
    _active(tmp_path, digest)
    path.write_bytes(path.read_bytes() + b"tampering")
    selection = repr(digest) if explicit else "None"
    result = _run(tmp_path, f"print(json.dumps(activate_engine({selection})))")
    if explicit:
        assert result == {"error": "digest_mismatch", "errorType": "EngineActivationError"}
    else:
        assert result["source"] == "bundled"
        assert result["fallbackReason"] == "digest_mismatch"


@pytest.mark.parametrize("extra,omit", [
    ({}, ("yt_dlp_ejs/__init__.py",)),
    ({"../private.py": "pass"}, ()),
    ({"/private.py": "pass"}, ()),
    ({"yt_dlp\\private.py": "pass"}, ()),
    ({"yt_dlp/version.py": "__version__ = get_version()\n"}, ()),
    ({"yt_dlp/private.py\x00hidden.py": "pass"}, ()),
    ({"C:/private.py": "pass"}, ()),
])
def test_invalid_archive_structure_or_static_version_is_rejected(tmp_path, extra, omit):
    digest, _ = _archive(tmp_path, extra=extra, omit=omit)
    result = _run(tmp_path, f"print(json.dumps(activate_engine({digest!r})))")
    assert result == {"error": "invalid_archive", "errorType": "EngineActivationError"}


@pytest.mark.parametrize("raw_name", ["yt_dlp\\private.py", "yt_dlp/private.py\x00hidden.py"])
def test_raw_archive_name_failure_falls_back_without_importing_archive(tmp_path, raw_name):
    digest, _ = _archive(tmp_path, extra={raw_name: "pass"})
    _active(tmp_path, digest)
    result = _run(tmp_path, """
        info = activate_engine()
        import yt_dlp
        print(json.dumps({'info': info, 'synthetic': hasattr(yt_dlp, 'ENGINE_MARKER')}))
    """)
    assert result["info"]["source"] == "bundled"
    assert result["info"]["fallbackReason"] == "invalid_archive"
    assert result["synthetic"] is False


def test_manifest_version_must_match_archive(tmp_path):
    digest, _ = _archive(tmp_path)
    _active(tmp_path, digest, "2026.09.26")
    result = _run(tmp_path, "print(json.dumps(activate_engine()))")
    assert result["source"] == "bundled"
    assert result["fallbackReason"] == "version_mismatch"


def test_imported_version_must_match_static_version(tmp_path):
    digest, _ = _archive(tmp_path, init="from . import version\nversion.__version__ = '2026.09.26'\n")
    result = _run(tmp_path, f"print(json.dumps(activate_engine({digest!r})))")
    assert result == {"error": "version_mismatch", "errorType": "EngineActivationError"}


def test_matching_digest_does_not_accept_corrupt_compressed_member(tmp_path):
    _, path = _archive(tmp_path, init="ENGINE_MARKER = 'synthetic'\n" * 100)
    with zipfile.ZipFile(path) as archive:
        member = archive.getinfo("yt_dlp/__init__.py")
        offset = member.header_offset + 30 + len(member.filename.encode()) + len(member.extra)
    content = bytearray(path.read_bytes())
    content[offset:offset + member.compress_size] = b"\x00" * member.compress_size
    digest = hashlib.sha256(content).hexdigest()
    damaged_path = tmp_path / "engines" / digest / "yt-dlp.zip"
    damaged_path.parent.mkdir()
    damaged_path.write_bytes(content)
    _active(tmp_path, digest)
    result = _run(tmp_path, "print(json.dumps(activate_engine()))")
    assert result["source"] == "bundled"
    assert result["fallbackReason"] == "invalid_archive"


def test_failed_bootstrap_removes_partial_modules_before_bundled_fallback(tmp_path):
    digest, _ = _archive(
        tmp_path,
        init=f"from . import poison\nraise RuntimeError({SECRET!r})\n",
        extra={"yt_dlp/poison.py": "VALUE = 'partial'\n"},
    )
    _active(tmp_path, digest)
    result = _run(tmp_path, """
        info = activate_engine()
        import yt_dlp
        print(json.dumps({'info': info, 'partial': 'yt_dlp.poison' in sys.modules,
                          'archiveRetained': any(path.replace(chr(92), '/').endswith('/yt-dlp.zip')
                                                 for path in sys.path),
                          'synthetic': hasattr(yt_dlp, 'ENGINE_MARKER')}))
    """)
    assert result["info"]["source"] == "bundled"
    assert result["info"]["fallbackReason"] == "import_failed"
    assert result["partial"] is result["archiveRetained"] is result["synthetic"] is False


@pytest.mark.parametrize("exception", ["RuntimeError", "SystemExit", "EngineActivationError"])
def test_explicit_import_failure_does_not_fall_back_or_leak_exception(tmp_path, exception):
    digest, _ = _archive(tmp_path, init=(
        "from src.core.ytdlp_runtime import EngineActivationError\n"
        f"raise {exception}({SECRET!r})\n"
    ))
    assert _run(tmp_path, f"print(json.dumps(activate_engine({digest!r})))") == {
        "error": "import_failed", "errorType": "EngineActivationError",
    }


@pytest.mark.parametrize("preload", ["import yt_dlp", "import yt_dlp_ejs"])
def test_already_imported_engine_cannot_be_switched(tmp_path, preload):
    digest, _ = _archive(tmp_path)
    _active(tmp_path, digest)
    result = _run(tmp_path, f"{preload}\nprint(json.dumps(activate_engine()))")
    assert result == {"error": "already_imported", "errorType": "EngineActivationError"}


def test_current_engine_adopts_actual_preloaded_bundled_for_normal_cli(tmp_path):
    digest, _ = _archive(tmp_path)
    _active(tmp_path, digest)
    result = _run(tmp_path, """
        import yt_dlp.version
        info = current_engine()
        print(json.dumps({'info': info, 'actual': yt_dlp.version.__version__,
                          'command': engine_cli_command()[1:]}))
    """)
    assert result["info"] == {"version": result["actual"], "source": "bundled", "selection": "bundled"}
    assert result["command"] == ["-m", "src.sidecar", "--engine-cli", "--engine-id", "bundled", "--"]


def test_activation_is_idempotent_and_metadata_is_not_mutable(tmp_path):
    digest, _ = _archive(tmp_path)
    result = _run(tmp_path, f"""
        first = activate_engine({digest!r})
        first['version'] = 'changed'
        same = activate_engine({digest!r})
        print(json.dumps({{'same': same, 'current': current_engine(), 'default': activate_engine()}}))
    """)
    expected = {"version": VERSION, "source": "updated", "selection": digest}
    assert result == {"same": expected, "current": expected, "default": expected}


def test_second_activation_cannot_change_engine(tmp_path):
    digest, _ = _archive(tmp_path)
    result = _run(tmp_path, f"activate_engine('bundled')\nprint(json.dumps(activate_engine({digest!r})))")
    assert result == {"error": "already_activated", "errorType": "EngineActivationError"}


@pytest.mark.parametrize("frozen", [False, True])
def test_cli_command_pins_actual_active_engine(tmp_path, frozen):
    digest, _ = _archive(tmp_path)
    result = _run(tmp_path, f"""
        activate_engine({digest!r})
        sys.frozen = {frozen!r}
        command = engine_cli_command()
        print(json.dumps({{'sameExecutable': command[0] == sys.executable, 'arguments': command[1:]}}))
    """)
    prefix = [] if frozen else ["-m", "src.sidecar"]
    assert result == {"sameExecutable": True, "arguments": prefix + ["--engine-cli", "--engine-id", digest, "--"]}
