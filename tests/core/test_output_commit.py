from __future__ import annotations

import os
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

import pytest

from src.core.downloader import (
    DownloadResult,
    SourceFacts,
    SubtitleArtifact,
)
from src.core.error_codes import OutputVerificationFailed
from src.core.output_commit import (
    CommittedOutput,
    cleanup_stale_hidden_files,
    commit_output_bundle,
    publish_no_replace,
    rollback_committed_output,
)


def _result_with_main_and_subtitle(
    staging: Path,
    *,
    payload: bytes = b"main payload",
    rendered_leaf: str = "Title [site-id].mp4",
) -> DownloadResult:
    staging.mkdir(parents=True, exist_ok=True)
    main = staging / "media.mp4"
    subtitle = staging / "media.zh-Hans.srt"
    main.write_bytes(payload)
    subtitle.write_bytes(b"subtitle:" + payload)
    return DownloadResult(
        main_file=main.resolve(),
        subtitles=(
            SubtitleArtifact(
                path=subtitle.resolve(),
                language="zh-Hans",
                extension="srt",
            ),
        ),
        info={},
        rendered_leaf=rendered_leaf,
        source_key="site-id",
        downloaded_this_run=True,
        source_facts=SourceFacts(
            selected_subtitle_languages=("zh-Hans",),
            missing_requested_subtitles=False,
            thumbnail_available=False,
            chapters_available=False,
            title_available=True,
        ),
    )


def _hidden_files(directory: Path) -> list[Path]:
    return sorted(directory.glob(".*.downany-*.tmp"))


def _directory_link_or_junction(link: Path, target: Path) -> None:
    try:
        link.symlink_to(target, target_is_directory=True)
        return
    except OSError as exc:
        if os.name != "nt":
            pytest.skip(f"directory symlinks unavailable: {exc}")
    created = subprocess.run(
        ["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(target)],
        check=False,
        capture_output=True,
        text=True,
    )
    if created.returncode != 0:
        pytest.skip(f"directory links unavailable: {created.stderr.strip()}")


def test_publish_no_replace_is_atomic_and_never_overwrites(tmp_path):
    hidden = tmp_path / ".ready.mp4.downany-0123456789abcdef0123456789abcdef.tmp"
    target = tmp_path / "ready.mp4"
    hidden.write_bytes(b"new")

    publish_no_replace(hidden, target)

    assert target.read_bytes() == b"new"
    assert not hidden.exists()

    another_hidden = tmp_path / ".ready.mp4.downany-fedcba9876543210fedcba9876543210.tmp"
    another_hidden.write_bytes(b"replacement")
    with pytest.raises(FileExistsError):
        publish_no_replace(another_hidden, target)

    assert target.read_bytes() == b"new"
    assert another_hidden.read_bytes() == b"replacement"


def test_existing_target_is_unchanged_and_bundle_uses_suffix_two(tmp_path):
    existing = tmp_path / "Title [site-id].mp4"
    existing.write_bytes(b"customer file")
    result = _result_with_main_and_subtitle(tmp_path / "staging")

    committed = commit_output_bundle(
        download_root=tmp_path,
        playlist_folder="",
        result=result,
    )

    assert existing.read_bytes() == b"customer file"
    assert committed.main_file.name == "Title [site-id] (2).mp4"
    assert committed.subtitle_files[0].name == "Title [site-id] (2).zh-Hans.srt"
    assert committed.main_file.read_bytes() == b"main payload"
    assert committed.subtitle_files[0].read_bytes() == b"subtitle:main payload"
    assert _hidden_files(tmp_path) == []


def test_subtitles_publish_before_main_and_file_copies_are_fsynced(tmp_path, monkeypatch):
    result = _result_with_main_and_subtitle(tmp_path / "staging")
    publish_order: list[str] = []
    fsynced: list[int] = []
    real_fsync = os.fsync

    def recording_fsync(fd: int) -> None:
        fsynced.append(fd)
        real_fsync(fd)

    def recording_publisher(hidden: Path, target: Path) -> None:
        publish_order.append(target.name)
        publish_no_replace(hidden, target)

    monkeypatch.setattr("src.core.output_commit.os.fsync", recording_fsync)

    committed = commit_output_bundle(
        download_root=tmp_path,
        playlist_folder="",
        result=result,
        publisher=recording_publisher,
    )

    assert publish_order == [
        "Title [site-id].zh-Hans.srt",
        "Title [site-id].mp4",
    ]
    assert len(fsynced) >= 2
    assert committed.created_fingerprints[-1].path == committed.main_file


def test_main_collision_rolls_back_attempt_and_cleans_hidden_before_retry(tmp_path):
    result = _result_with_main_and_subtitle(tmp_path / "staging")
    calls: list[str] = []

    def racing_publisher(hidden: Path, target: Path) -> None:
        calls.append(target.name)
        if target.name == "Title [site-id].mp4":
            target.write_bytes(b"racing customer")
            raise FileExistsError(str(target))
        if target.name == "Title [site-id] (2).zh-Hans.srt":
            assert not (tmp_path / "Title [site-id].zh-Hans.srt").exists()
            retry_hidden = _hidden_files(tmp_path)
            assert len(retry_hidden) == 2
            assert all(" (2)." in path.name for path in retry_hidden)
        publish_no_replace(hidden, target)

    committed = commit_output_bundle(
        download_root=tmp_path,
        playlist_folder="",
        result=result,
        publisher=racing_publisher,
    )

    assert (tmp_path / "Title [site-id].mp4").read_bytes() == b"racing customer"
    assert not (tmp_path / "Title [site-id].zh-Hans.srt").exists()
    assert committed.main_file.name == "Title [site-id] (2).mp4"
    assert committed.subtitle_files[0].name == "Title [site-id] (2).zh-Hans.srt"
    assert _hidden_files(tmp_path) == []
    assert calls == [
        "Title [site-id].zh-Hans.srt",
        "Title [site-id].mp4",
        "Title [site-id] (2).zh-Hans.srt",
        "Title [site-id] (2).mp4",
    ]


def test_unsupported_publication_rolls_back_visible_files_and_retains_hidden(tmp_path):
    existing = tmp_path / "Title [site-id].mp4"
    existing.write_bytes(b"customer file")
    result = _result_with_main_and_subtitle(tmp_path / "staging")

    def unsupported_after_subtitle(hidden: Path, target: Path) -> None:
        if target.suffix == ".srt":
            publish_no_replace(hidden, target)
            return
        raise OutputVerificationFailed("当前磁盘无法安全保存成品")

    with pytest.raises(OutputVerificationFailed, match="当前磁盘无法安全保存成品"):
        commit_output_bundle(
            download_root=tmp_path,
            playlist_folder="",
            result=result,
            publisher=unsupported_after_subtitle,
        )

    assert existing.read_bytes() == b"customer file"
    assert not (tmp_path / "Title [site-id] (2).zh-Hans.srt").exists()
    assert not (tmp_path / "Title [site-id] (2).mp4").exists()
    retained = _hidden_files(tmp_path)
    assert len(retained) == 1
    assert retained[0].read_bytes() == b"main payload"


def test_rollback_removes_unchanged_outputs_in_reverse_publication_order(
    tmp_path,
    monkeypatch,
):
    committed = commit_output_bundle(
        download_root=tmp_path,
        playlist_folder="",
        result=_result_with_main_and_subtitle(tmp_path / "staging"),
    )
    removed: list[str] = []
    original_unlink = Path.unlink

    def recording_unlink(path: Path, *args, **kwargs):
        if path in {committed.main_file, *committed.subtitle_files}:
            removed.append(path.name)
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", recording_unlink)

    rollback_committed_output(committed)

    assert removed == [
        "Title [site-id].mp4",
        "Title [site-id].zh-Hans.srt",
    ]
    assert not committed.main_file.exists()
    assert not committed.subtitle_files[0].exists()


def test_rollback_refuses_changed_fingerprint_but_removes_unchanged_sibling(tmp_path):
    committed = commit_output_bundle(
        download_root=tmp_path,
        playlist_folder="",
        result=_result_with_main_and_subtitle(tmp_path / "staging"),
    )
    committed.main_file.write_bytes(b"customer changed this file")

    rollback_committed_output(committed)

    assert committed.main_file.read_bytes() == b"customer changed this file"
    assert not committed.subtitle_files[0].exists()


def test_rollback_refuses_path_that_became_a_symlink(tmp_path):
    committed = commit_output_bundle(
        download_root=tmp_path,
        playlist_folder="",
        result=_result_with_main_and_subtitle(tmp_path / "staging"),
    )
    outside = tmp_path / "customer-target"
    outside.mkdir()
    customer = outside / "customer.mp4"
    customer.write_bytes(b"customer")
    committed.main_file.unlink()
    _directory_link_or_junction(committed.main_file, outside)

    rollback_committed_output(committed)

    assert committed.main_file.exists()
    assert customer.read_bytes() == b"customer"
    assert not committed.subtitle_files[0].exists()


def test_cleanup_stale_hidden_files_is_nonrecursive_and_strict(tmp_path):
    now = time.time()
    old = tmp_path / ".old.mp4.downany-0123456789abcdef0123456789abcdef.tmp"
    fresh = tmp_path / ".fresh.mp4.downany-fedcba9876543210fedcba9876543210.tmp"
    customer = tmp_path / ".customer.mp4.downany-not-ours.tmp"
    directory = tmp_path / ".folder.downany-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp"
    nested_dir = tmp_path / "nested"
    nested = nested_dir / ".nested.downany-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.tmp"
    for path in (old, fresh, customer):
        path.write_bytes(path.name.encode())
    directory.mkdir()
    nested_dir.mkdir()
    nested.write_bytes(b"nested")
    os.utime(old, (now - 90_000, now - 90_000))
    os.utime(fresh, (now - 10, now - 10))
    os.utime(customer, (now - 90_000, now - 90_000))
    os.utime(nested, (now - 90_000, now - 90_000))

    removed = cleanup_stale_hidden_files(tmp_path, now=lambda: now)

    assert removed == 1
    assert not old.exists()
    assert fresh.exists()
    assert customer.exists()
    assert directory.is_dir()
    assert nested.exists()


def test_cleanup_stale_hidden_files_never_removes_symlink(tmp_path):
    now = time.time()
    target = tmp_path / "customer-target"
    target.mkdir()
    customer = target / "customer.bin"
    customer.write_bytes(b"customer")
    link = tmp_path / ".link.downany-cccccccccccccccccccccccccccccccc.tmp"
    _directory_link_or_junction(link, target)
    os.utime(customer, (now - 90_000, now - 90_000))

    assert cleanup_stale_hidden_files(tmp_path, now=lambda: now) == 0
    assert link.exists()
    assert customer.read_bytes() == b"customer"


def test_commit_cleans_only_aged_owned_hidden_files_before_staging(tmp_path):
    now = time.time()
    stale = tmp_path / ".stale.downany-dddddddddddddddddddddddddddddddd.tmp"
    customer = tmp_path / ".stale.downany-customer.tmp"
    stale.write_bytes(b"old hidden")
    customer.write_bytes(b"customer")
    os.utime(stale, (now - 90_000, now - 90_000))
    os.utime(customer, (now - 90_000, now - 90_000))

    commit_output_bundle(
        download_root=tmp_path,
        playlist_folder="",
        result=_result_with_main_and_subtitle(tmp_path / "staging"),
    )

    assert not stale.exists()
    assert customer.read_bytes() == b"customer"


def test_two_threads_publish_same_leaf_without_overwrite(tmp_path):
    barrier = Barrier(2)
    results = [
        _result_with_main_and_subtitle(tmp_path / "staging-a", payload=b"payload-a"),
        _result_with_main_and_subtitle(tmp_path / "staging-b", payload=b"payload-b"),
    ]

    def worker(result: DownloadResult) -> CommittedOutput:
        barrier.wait(timeout=5)
        return commit_output_bundle(
            download_root=tmp_path / "downloads",
            playlist_folder="",
            result=result,
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        committed = list(executor.map(worker, results))

    names = {item.main_file.name for item in committed}
    payloads = {item.main_file.read_bytes() for item in committed}
    subtitle_payloads = {
        item.subtitle_files[0].read_bytes() for item in committed
    }
    assert names == {"Title [site-id].mp4", "Title [site-id] (2).mp4"}
    assert payloads == {b"payload-a", b"payload-b"}
    assert subtitle_payloads == {b"subtitle:payload-a", b"subtitle:payload-b"}
    assert _hidden_files(tmp_path / "downloads") == []
