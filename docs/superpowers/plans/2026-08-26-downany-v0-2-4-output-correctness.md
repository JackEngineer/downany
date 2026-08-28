# Downany v0.2.4 成品正确性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让单条内容和播放列表只在安全命名、后处理、ffprobe 验证和原子提交全部成功后才显示完成，并使字幕、封面、元数据、章节与分组目录符合用户设置。

**Architecture:** `OutputPlan` 先把任务设置编译为明确的 yt-dlp Python API 参数和后处理顺序，`Downloader` 只在任务专属暂存目录中产生结构化 `DownloadResult`。管理器先用 ffprobe 验证暂存成品，再通过安全路径规划与原子 no-replace 提交器发布到用户目录，最后完成历史、队列、自定义脚本和 Telegram 交接。

**Tech Stack:** Python 3.11, yt-dlp 2026.7.4 Python API, ffmpeg/ffprobe 7.x, SQLite, Electron 33, React 18, TypeScript 5.7, Vitest 2, Pytest.

**Spec:** `docs/superpowers/specs/2026-08-26-downany-v0-2-4-output-correctness-design.md`

## Global Constraints

- **用户范围调整（2026-08-27）：** 必须先读 `docs/superpowers/specs/2026-08-27-downany-windows-execution-scope.md`。本任务仅负责 Windows；Mac 相关步骤不执行、不计入未完成门槛，不得用 Windows 证据标记 Mac 通过。
- 继续使用 Electron Main + preload IPC + React Renderer + Python Sidecar + yt-dlp 唯一主线；不引入 PyQt、SwiftUI 或第二套下载引擎。
- 所有单任务下载保持 `noplaylist=true`；播放列表必须先展开为带 `group_id` 与 `playlist_index` 的单任务。
- 任务专属暂存目录固定为 `<AppPaths.temp_dir>/<task_id>`；用户标题、URL 和模板不参与该目录命名。
- 文件名单组件最多 120 个 UTF-16 代码单元；Windows 最终绝对路径最多 240 个 UTF-16 代码单元；叶子名剩余预算少于 40 时在网络请求前失败。
- 新任务不得覆盖或复用已有目标；冲突时使用 ` (2)`、` (3)`；不得使用 `os.replace` 覆盖未知文件。
- 用户可见主文件不得作为边复制边增长的目标；平台无法原子 no-replace 发布时安全失败。
- ffprobe 固定参数为 `-v error -print_format json -show_format -show_streams -show_chapters`，超时 15 秒，stdout/stderr 各最多使用 1 MiB。
- `download_sections` 和 `sponsorblock_remove` 继续读写旧配置，但 v0.2.4 不再向 yt-dlp 传递也不在界面展示。
- 不改队列重排或整组暂停/恢复/重试状态机，不新增任意后处理步骤，也不承诺规格之外的网站列表形态。
- 已完成历史文件不迁移、不改名、不移动、不删除；只有用户显式执行既有删除动作时才处理该动作记录的文件。
- 不启用自动替换更新、代码签名或公证；这些不是 v0.2.4-A 候选门槛的一部分。
- 原始 ffmpeg/ffprobe 输出、URL、Cookie、Token 和本地绝对路径不得进入普通用户界面或 `completion_note`。
- 默认视频容器仅允许 MP4/MKV，转换模式仅允许 MP4，音频模式仅允许 MP3。
- 本计划不授权合并、推送、创建 tag、清理分支/工作树、部署官网或公开 Release。

---

## File responsibility map

### New focused units

- `src/core/output_contract.py` — 不执行 I/O 的产品语义编译器；定义 `OutputPlan`、字幕模式、容器和显式后处理顺序。
- `src/core/output_paths.py` — 模板校验、Unicode/Windows 安全组件、来源键、路径预算和最终候选路径。
- `src/core/media_verifier.py` — 受限 ffprobe 调用、JSON 解析、媒体流/容器/字幕/封面/标签/章节合同。
- `src/core/output_commit.py` — 同目录隐藏暂存、原子 no-replace 发布、成品包回滚和冲突后缀。
- `desktop/renderer/lib/outputSettings.ts` — 四种字幕产品选项与旧布尔字段之间的双向映射。
- `scripts/test_packaged_media_tools.mjs` — 对包内 ffmpeg/ffprobe 成对运行、生成短样本并用 ffprobe 解析。
- `tests/core/test_media_pipeline_integration.py` — 使用真实 ffmpeg/ffprobe/yt-dlp 后处理器验证字幕、封面、元数据、章节和容器。

### Existing orchestration units

- `src/core/downloader.py` 只负责 yt-dlp 会话、重试、暂存产物定位和结构化 `DownloadResult`。
- `src/core/download_manager.py` 负责状态机、暂存验证、提交、脚本复验、持久化、事件和 Telegram 交接；不再手工组装 yt-dlp 后处理字典。
- `src/sidecar/bin_paths.py` 统一发现 ffmpeg/ffprobe 配对；`src/sidecar/diagnostics.py` 只输出可用性和主版本。
- `src/core/download_task.py`、`src/data/queue_store.py`、`src/data/database.py`、`src/data/models.py` 负责 `completion_note` 的升级兼容持久化。
- `desktop/renderer/SettingsApp.tsx` 只展示真实可用的处理选项；任务卡片只显示稳定错误动作和产品化完成提示。
- `src/core/url_parser.py`、`src/sidecar/handlers.py`、`desktop/renderer/lib/urls.ts` 共同保证列表先展开、已分组条目不再展开。
- 发布脚本从同一锁定资产一起提取/构建 ffmpeg 与 ffprobe；CI 在打包前后运行真实工具链冒烟。

## Spec coverage map

| Spec section | Implemented and verified by |
| --- | --- |
| 1. 目标 | Tasks 4–9 establish one verified output pipeline; Task 14 applies the stable-candidate gate. |
| 2. 已确认的现状问题 | Tasks 2–13 replace permissive path guessing, implicit postprocessing, missing ffprobe packaging, premature completion, and partial playlist tests. |
| 3. 范围与非目标 | Global Constraints preserve the sole Electron/Python path and exclusions; Tasks 4, 10, and 11 implement only approved v0.2.4 behavior. |
| 4. 核心完成合同 | Tasks 5, 7, 8, and 9 require real files, media validation, bundle publication, persistence, and downstream handoff in order. |
| 5. 架构 | Task 4 owns `OutputPlan`; Task 6 owns `DownloadResult`; Tasks 5 and 7 own verification/commit; Tasks 8 and 9 orchestrate state and consumers. |
| 6. yt-dlp 输出与后处理规则 | Tasks 4, 5, 6, 10, and 13 cover containers, remux/conversion, metadata, cover, chapters, four subtitle modes, MP3 downgrade, and hidden options. |
| 7. 文件名、目录和冲突规则 | Tasks 2 and 7 cover leaf-only templates, portable components, stable keys, budgets, group directories, suffixes, and no-overwrite publication. |
| 8. ffmpeg/ffprobe 工具链 | Tasks 3, 12, and 13 cover discovery, privacy-safe diagnostics, paired provenance, packaging, and real execution. |
| 9. 播放列表数据流 | Task 11 covers candidate parsing, one-time expansion, selection, persistence, restart grouping, deletion regressions, and opening children; Task 14 performs visible journeys. |
| 10. 错误处理 | Tasks 1, 8, and 10 provide stable codes, product-safe messages, recovery actions, and confirmed verification retry. |
| 11. 测试与验收 | Tasks 1–11 add contract tests; Task 13 adds deterministic media; Task 12 adds package smoke; Task 14 records dual-platform visible evidence. |
| 12. 兼容性与提交边界 | Tasks 1, 8, 10, and 11 preserve fields and historical outputs; Global Constraints and Task 14 prohibit unapproved repository/release actions. |
| 13. 完成定义 | Tasks 12–14 require full regression, paired packages, deterministic media, seven journeys per platform, and an evidence-only candidate record. |

---

### Task 1: Add stable output-result state, errors, and persistence

**Files:**
- Modify: `src/core/download_task.py:49-181`
- Modify: `src/core/error_codes.py:1-66`
- Modify: `src/data/models.py:20-43`
- Modify: `src/data/queue_store.py:45-272`
- Modify: `src/data/database.py:62-223`
- Modify: `desktop/renderer/lib/types.ts:38-65`
- Modify: `desktop/renderer/test/taskFixture.ts:3-30`
- Test: `tests/core/test_task_snapshot.py`
- Test: `tests/core/test_error_codes.py`
- Test: `tests/data/test_queue_store.py`
- Test: `tests/data/test_database.py`

**Interfaces:**
- Produces: `DownloadTask.completion_note: str`, `TaskSnapshot.completion_note: str`, `DownloadRecord.completion_note: str`.
- Produces: `OutputPathInvalid`, `MediaToolsMissing`, and `OutputVerificationFailed`; each exposes a stable `.error_code` and a product-safe exception message.
- Consumes: no new interface.

- [ ] **Step 1: Write failing model, persistence, and error-code tests**

```python
def test_completion_note_roundtrips_through_snapshot_and_queue(tmp_path):
    store = QueueStore(str(tmp_path / "queue.db"))
    task = _make_task()
    task.completion_note = "未找到所选语言字幕"
    store.upsert_task(task)

    loaded = store.load_tasks()[0]
    assert loaded.completion_note == "未找到所选语言字幕"
    assert loaded.to_snapshot().completion_note == "未找到所选语言字幕"


@pytest.mark.parametrize(
    ("exception", "expected"),
    [
        (OutputPathInvalid("下载位置或文件名不可用"), "output_path_invalid"),
        (MediaToolsMissing("媒体工具不完整，请重新安装"), "media_tools_missing"),
        (OutputVerificationFailed("成品无法验证，请导出诊断后重试"), "output_verification_failed"),
    ],
)
def test_output_contract_exceptions_keep_stable_codes(exception, expected):
    assert exception.error_code == expected
    assert classify_download_error(exception) == expected
```

Add a `HistoryDB` round-trip assertion using `DownloadRecord(completion_note="视频已下载，后处理脚本未完成")` and verify `get_download_record()` returns the exact note.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
& 'D:\work\downany\venv\Scripts\python.exe' -m pytest tests/core/test_task_snapshot.py tests/core/test_error_codes.py tests/data/test_queue_store.py tests/data/test_database.py -q
```

Expected: FAIL because `completion_note` and the three coded exceptions do not exist.

- [ ] **Step 3: Add the model fields and coded exceptions**

```python
class OutputContractError(RuntimeError):
    error_code = "unknown"


class OutputPathInvalid(OutputContractError):
    error_code = "output_path_invalid"


class MediaToolsMissing(OutputContractError):
    error_code = "media_tools_missing"


class OutputVerificationFailed(OutputContractError):
    error_code = "output_verification_failed"
```

Add all three constants to `ALL_ERROR_CODES`, and make the first branch of `classify_download_error` return `exc_or_message.error_code` for `OutputContractError` before regex classification.

Add the same defaulted field to the task, snapshot, and history models:

```diff
 class DownloadTask:
+    completion_note: str = ""

 class TaskSnapshot:
+    completion_note: str = ""

 class DownloadRecord:
+    completion_note: str = ""
```

Pass `completion_note` through `DownloadTask.to_dict()` and `DownloadTask.to_snapshot()`.

- [ ] **Step 4: Add backward-compatible SQLite migrations and mappings**

Use exact additive migrations:

```python
conn.execute(
    "ALTER TABLE task_queue ADD COLUMN completion_note TEXT NOT NULL DEFAULT ''"
)
```

```python
migrations = {
    "output_state": "ALTER TABLE download_history ADD COLUMN output_state TEXT NOT NULL DEFAULT 'pending'",
    "output_ready_at": "ALTER TABLE download_history ADD COLUMN output_ready_at TEXT",
    "output_recovery_safe": "ALTER TABLE download_history ADD COLUMN output_recovery_safe INTEGER NOT NULL DEFAULT 0",
    "output_owner_id": "ALTER TABLE download_history ADD COLUMN output_owner_id TEXT",
    "output_lease_expires_at": "ALTER TABLE download_history ADD COLUMN output_lease_expires_at TEXT",
    "completion_note": "ALTER TABLE download_history ADD COLUMN completion_note TEXT NOT NULL DEFAULT ''",
}
```

Include `completion_note` in each `INSERT`, `ON CONFLICT ... UPDATE`, row conversion, and queue upsert/load parameter list. Use `str(row["completion_note"] or "")` so an old or manually edited database cannot return `None`.

- [ ] **Step 5: Run focused persistence tests and the existing Telegram-store tests**

Run:

```powershell
& 'D:\work\downany\venv\Scripts\python.exe' -m pytest tests/core/test_task_snapshot.py tests/core/test_error_codes.py tests/data/test_queue_store.py tests/data/test_database.py tests/data/test_telegram_delivery_store.py -q
```

Expected: PASS; existing output-state migrations and writer-fence behavior remain green.

- [ ] **Step 6: Commit the state contract**

```powershell
git add src/core/download_task.py src/core/error_codes.py src/data/models.py src/data/queue_store.py src/data/database.py desktop/renderer/lib/types.ts desktop/renderer/test/taskFixture.ts tests/core/test_task_snapshot.py tests/core/test_error_codes.py tests/data/test_queue_store.py tests/data/test_database.py
git commit -m "feat: persist verified output results"
```

---

### Task 2: Build portable filename and final-path planning

**Files:**
- Create: `src/core/output_paths.py`
- Modify: `src/data/json_config.py:20-50,272-323`
- Test: `tests/core/test_output_paths.py`
- Test: `tests/data/test_json_config.py`

**Interfaces:**
- Produces: `validate_filename_template(template: str) -> str`.
- Produces: `safe_component(value: str, *, fallback: str, max_units: int = 120) -> str`.
- Produces: `stable_source_key(url: str, *, extractor: str = "", media_id: str = "") -> str`.
- Produces: `build_final_path_plan(download_root: Path, playlist_folder: str, rendered_leaf: str, source_key: str, subtitle_specs: tuple[tuple[str, str], ...], copy_index: int = 1) -> FinalPathPlan`.
- Consumes later: `OutputPlan.playlist_folder`, `DownloadResult.rendered_leaf`, and `DownloadResult.source_key`.

- [ ] **Step 1: Write failing template and portable-name tests**

```python
@pytest.mark.parametrize(
    "template",
    [
        "../%(title)s.%(ext)s",
        r"..\%(title)s.%(ext)s",
        r"C:\%(title)s.%(ext)s",
        r"\\server\share\%(title)s.%(ext)s",
        "/tmp/%(title)s.%(ext)s",
        "bad\x00%(title)s.%(ext)s",
    ],
)
def test_template_is_a_leaf_on_every_host(template):
    with pytest.raises(OutputPathInvalid):
        validate_filename_template(template)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("CON.mp4", "_CON.mp4"),
        ("aux ", "_aux"),
        ("title..", "title"),
        ("a/b\\c", "a b c"),
        ("e\u0301", "é"),
    ],
)
def test_safe_component_is_windows_portable(raw, expected):
    assert safe_component(raw, fallback="video") == expected
```

Add cases proving: 120 UTF-16 units, surrogate-pair-safe truncation, preservation of `.mp4`, preservation of `[youtube-abc123]`, `group8`, `001 - `, Windows 240-unit rejection, leaf budget below 40 rejection, root containment, and `copy_index=2` producing ` (2)` for both the main file and every subtitle.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
& 'D:\work\downany\venv\Scripts\python.exe' -m pytest tests/core/test_output_paths.py tests/data/test_json_config.py -q
```

Expected: FAIL because the new module is absent and the current validator accepts backslash traversal on non-Windows hosts.

- [ ] **Step 3: Implement exact portable primitives and leaf validation**

Start `output_paths.py` with these fixed constants and exception behavior:

```python
MAX_COMPONENT_UTF16 = 120
MAX_WINDOWS_PATH_UTF16 = 240
MIN_LEAF_BUDGET_UTF16 = 40
WINDOWS_RESERVED = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{i}" for i in range(1, 10)}
    | {f"LPT{i}" for i in range(1, 10)}
)


def utf16_units(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def truncate_utf16(value: str, budget: int) -> str:
    kept: list[str] = []
    used = 0
    for char in value:
        width = utf16_units(char)
        if used + width > budget:
            break
        kept.append(char)
        used += width
    return "".join(kept)
```

`safe_component` must NFC-normalize, replace `/\\:*?"<>|` and ASCII control characters with spaces, collapse whitespace, strip trailing dots/spaces, prefix Windows reserved stems with `_`, use the fallback for empty/dot-only values, and call `truncate_utf16`.

`validate_filename_template` must reject either path separator before using host-dependent path functions, reject drive/UNC/absolute/control forms, require `%(ext)s`, and retain the existing placeholder whitelist. It raises only `OutputPathInvalid` with product-safe messages.

- [ ] **Step 4: Implement stable keys and path-budgeted candidates**

```python
@dataclass(frozen=True)
class FinalPathPlan:
    root: Path
    directory: Path
    main_file: Path
    subtitle_files: tuple[Path, ...]


def stable_source_key(url: str, *, extractor: str = "", media_id: str = "") -> str:
    extractor = safe_component(extractor, fallback="unknown", max_units=32)
    media_id = safe_component(media_id, fallback="unknown", max_units=48)
    if extractor != "unknown" and media_id != "unknown":
        return f"{extractor}-{media_id}"
    normalized = normalize_download_url(url)
    return f"url-{hashlib.sha256(normalized.encode('utf-8')).hexdigest()[:8]}"
```

`build_final_path_plan` must resolve `download_root`, construct only a trusted sanitized `playlist_folder`, split the rendered extension, preserve `source_key`, append the numeric collision suffix before the extension, derive subtitles as `<main-stem>.<language>.<ext>`, and require:

```python
resolved_candidate = candidate.resolve(strict=False)
try:
    inside_root = os.path.commonpath(
        [os.path.normcase(str(root)), os.path.normcase(str(resolved_candidate))]
    ) == os.path.normcase(str(root))
except ValueError:
    inside_root = False
if not inside_root:
    raise OutputPathInvalid("成品路径超出下载位置")
```

This check must reject an existing playlist-directory symlink that resolves outside the download root. Directory creation remains Task 7's I/O responsibility and repeats containment validation immediately before creating hidden files.

On Windows, compute the remaining leaf budget from the resolved directory; raise `OutputPathInvalid("下载位置过长，请选择更短的目录")` below 40 UTF-16 units and keep the final absolute path at or below 240.

- [ ] **Step 5: Make settings reuse the one validator without mutating invalid config**

Remove the duplicate validator/constants from `json_config.py`, import `validate_filename_template`, and keep validation before `self._data = next_data` and `_save()`. Extend `test_json_config.py` to snapshot the file text, submit an invalid Windows-style template, assert `ValueError`, and assert the file bytes are unchanged.

- [ ] **Step 6: Run path and settings tests**

Run:

```powershell
& 'D:\work\downany\venv\Scripts\python.exe' -m pytest tests/core/test_output_paths.py tests/data/test_json_config.py -q
```

Expected: PASS on Windows; the same tests are deliberately host-independent and must also pass in macOS CI.

- [ ] **Step 7: Commit portable path planning**

```powershell
git add src/core/output_paths.py src/data/json_config.py tests/core/test_output_paths.py tests/data/test_json_config.py
git commit -m "feat: plan portable output paths"
```

---

### Task 3: Resolve a complete ffmpeg/ffprobe toolchain and report it safely

**Files:**
- Modify: `src/sidecar/bin_paths.py:1-64`
- Modify: `src/sidecar/diagnostics.py:18-96`
- Test: `tests/sidecar/test_bin_paths.py`
- Test: `tests/sidecar/test_diagnostics.py`

**Interfaces:**
- Produces: `MediaToolchain(ffmpeg: Path, ffprobe: Path, ffmpeg_location: Path | None, source: str)`.
- Produces: `resolve_ffprobe_path(*, project_root: Path | None = None) -> Path | None` and `resolve_media_toolchain(*, project_root: Path | None = None) -> MediaToolchain | None`.
- Preserves: `resolve_ffmpeg_path(*, project_root: Path | None = None) -> Path | None` for local thumbnails and Telegram segmentation.
- Consumed by Tasks 5, 6, 8, 12, and 13.

- [ ] **Step 1: Write failing discovery-order and privacy tests**

```python
def test_env_requires_both_tools_from_the_same_directory(tmp_path, monkeypatch):
    bin_dir = tmp_path / "env-bin"
    make_executable(bin_dir / executable_name("ffmpeg"))
    monkeypatch.setenv("DOWNANY_BIN_DIR", str(bin_dir))
    assert resolve_media_toolchain(project_root=tmp_path) is None

    make_executable(bin_dir / executable_name("ffprobe"))
    pair = resolve_media_toolchain(project_root=tmp_path)
    assert pair is not None
    assert pair.ffmpeg.parent == pair.ffprobe.parent == bin_dir
    assert pair.ffmpeg_location == bin_dir
    assert pair.source == "environment"
```

Add tests for packaged `resources/bin`, development `desktop/resources/bin`, development `bin`, and PATH fallback where `ffmpeg` and `ffprobe` may have different parents and therefore `ffmpeg_location is None`. Diagnostics tests must assert `ffprobe_available` and major versions exist but neither absolute executable path appears in `environment.json`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
& 'D:\work\downany\venv\Scripts\python.exe' -m pytest tests/sidecar/test_bin_paths.py tests/sidecar/test_diagnostics.py -q
```

Expected: FAIL because only ffmpeg is currently resolved and diagnostics has no ffprobe fields.

- [ ] **Step 3: Implement ordered pair discovery**

```python
@dataclass(frozen=True)
class MediaToolchain:
    ffmpeg: Path
    ffprobe: Path
    ffmpeg_location: Optional[Path]
    source: str


def _pair_from_directory(directory: Path, source: str) -> Optional[MediaToolchain]:
    ffmpeg = _first_executable(directory, "ffmpeg")
    ffprobe = _first_executable(directory, "ffprobe")
    if ffmpeg is None or ffprobe is None:
        return None
    return MediaToolchain(ffmpeg, ffprobe, directory, source)
```

Build candidate directories in this exact order: `DOWNANY_BIN_DIR`; frozen executable `Path(sys.executable).resolve().parents[2] / "bin"`; `<project_root>/desktop/resources/bin`; `<project_root>/bin`. Only after all directory pairs fail, use `shutil.which` for both tools and return source `path` with `ffmpeg_location=None`.

Keep single-tool resolvers by searching the same directory order and then PATH independently; a feature that only needs ffmpeg must not regress because ffprobe is absent.

- [ ] **Step 4: Add bounded version reporting for both tools**

Use the existing `_run_version` timeout and add a separate ffprobe regex. Resolve the single tools independently for diagnostics, while using `resolve_media_toolchain()` for download readiness. Diagnostics output must include exactly these media-tool fields:

```python
{
    "ffmpeg_available": ffmpeg is not None,
    "ffmpeg_version": safe_ffmpeg_version,
    "ffprobe_available": ffprobe is not None,
    "ffprobe_version": safe_ffprobe_version,
}
```

Return only the major/version token; do not add `ffmpeg_path`, `ffprobe_path`, command lines, or raw stderr.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
& 'D:\work\downany\venv\Scripts\python.exe' -m pytest tests/sidecar/test_bin_paths.py tests/sidecar/test_diagnostics.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit paired media-tool discovery**

```powershell
git add src/sidecar/bin_paths.py src/sidecar/diagnostics.py tests/sidecar/test_bin_paths.py tests/sidecar/test_diagnostics.py
git commit -m "feat: resolve paired media tools"
```

---

### Task 4: Compile product settings into an immutable yt-dlp output plan

**Files:**
- Create: `src/core/output_contract.py`
- Test: `tests/core/test_output_contract.py`
- Modify: `tests/core/test_quality.py`

**Interfaces:**
- Produces: `MediaKind`, `SubtitleMode`, and immutable `OutputPlan`.
- Produces: `compile_output_plan(task: DownloadTask) -> OutputPlan`.
- `OutputPlan.to_ydl_options()` returns a fresh mutable dict for `yt_dlp.YoutubeDL`.
- Consumes: `validate_filename_template`, `safe_component`, `stable_source_key`, and existing quality/cookie/header settings.
- Consumed by: `Downloader.download` in Task 6 and `DownloadManager` in Task 8.

- [ ] **Step 1: Write failing table-driven compiler tests**

```python
@pytest.mark.parametrize(
    ("download_subtitles", "embed_subs", "expected"),
    [
        (False, False, SubtitleMode.NONE),
        (True, False, SubtitleMode.EXTERNAL),
        (False, True, SubtitleMode.EMBEDDED),
        (True, True, SubtitleMode.BOTH),
    ],
)
def test_subtitle_modes(download_subtitles, embed_subs, expected):
    task = make_task(download_subtitles=download_subtitles, embed_subs=embed_subs)
    plan = compile_output_plan(task)
    assert plan.subtitle_mode is expected
```

Add assertions for:

```python
assert postprocessor_keys(default_video_plan) == [
    "FFmpegVideoRemuxer", "FFmpegMetadata", "EmbedThumbnail"
]
assert postprocessor_keys(mp4_with_subs_plan) == [
    "FFmpegVideoConvertor", "FFmpegEmbedSubtitle", "FFmpegMetadata", "EmbedThumbnail"
]
assert postprocessor_keys(mp3_plan) == [
    "FFmpegExtractAudio", "FFmpegMetadata", "EmbedThumbnail"
]
```

Also prove: default allowed containers are `{"mp4", "mkv"}`; MP4 and MP3 each allow only their requested container; blank subtitle languages omit `subtitleslangs`; explicit languages become `("zh-Hans", "en")`; `download_sections` and `sponsorblock_remove` never appear; page and direct source-key templates differ; playlist folder contains safe title plus stable `group8`; the plan cannot be field-assigned.

For a blank language list, call the pinned yt-dlp 2026.7.4 `YoutubeDL.process_subtitles()` with controlled author/automatic dictionaries and prove it selects exactly one language in this order: English author, English automatic, another author language, another automatic language. This locks the dependency behavior the product copy promises without reimplementing yt-dlp's selector.

- [ ] **Step 2: Run compiler tests and verify RED**

Run:

```powershell
& 'D:\work\downany\venv\Scripts\python.exe' -m pytest tests/core/test_output_contract.py tests/core/test_quality.py -q
```

Expected: FAIL because `OutputPlan` does not exist and option assembly still lives in `DownloadManager`.

- [ ] **Step 3: Define immutable plan types and safe copying**

```python
class MediaKind(str, Enum):
    VIDEO = "video"
    AUDIO = "audio"


class SubtitleMode(str, Enum):
    NONE = "none"
    EXTERNAL = "external"
    EMBEDDED = "embedded"
    BOTH = "both"


@dataclass(frozen=True)
class OutputPlan:
    media_kind: MediaKind
    allowed_containers: frozenset[str]
    subtitle_mode: SubtitleMode
    requested_subtitle_languages: tuple[str, ...]
    ydl_options: Mapping[str, object]
    postprocessors: tuple[Mapping[str, object], ...]
    final_leaf_template: str
    source_key_template: str
    playlist_folder: str
    requires_ffmpeg: bool
    requires_ffprobe: bool
    completion_note: str = ""

    def to_ydl_options(self) -> dict[str, object]:
        copied = {key: copy.deepcopy(value) for key, value in self.ydl_options.items()}
        copied["postprocessors"] = [dict(item) for item in self.postprocessors]
        return copied
```

Wrap `ydl_options` and each postprocessor in `MappingProxyType`, and use tuples/frozensets for nested sequences so callers cannot mutate the plan shared between download and verification.

- [ ] **Step 4: Implement format, remux, metadata, cover, and subtitle semantics**

Use these exact postprocessor dictionaries and order:

```python
DEFAULT_REMUX = {
    "key": "FFmpegVideoRemuxer",
    "preferedformat": "mp4>mp4/mkv>mkv/webm>mkv/mov>mp4/m4v>mp4/mkv",
}
MP4_CONVERT = {"key": "FFmpegVideoConvertor", "preferedformat": "mp4"}
MP3_EXTRACT = {
    "key": "FFmpegExtractAudio",
    "preferredcodec": "mp3",
    "preferredquality": "192",
}
EMBED_SUBTITLES = {"key": "FFmpegEmbedSubtitle", "already_have_subtitle": False}
WRITE_METADATA = {
    "key": "FFmpegMetadata",
    "add_metadata": True,
    "add_chapters": True,
    "add_infojson": False,
}
EMBED_THUMBNAIL = {"key": "EmbedThumbnail", "already_have_thumbnail": False}
```

For default video set a MP4-first selector plus `merge_output_format="mp4/mkv"`; for height limits retain the limit in every fallback branch. A direct-media task without explicit `format_id` uses `bestvideo+bestaudio/best` but still receives remux and allowed-container enforcement.

When subtitles are enabled set both `writesubtitles` and `writeautomaticsub`; store normalized explicit values in `requested_subtitle_languages` and set `subtitleslangs` only for a non-empty language list. Add `FFmpegEmbedSubtitle` only for embedded/both video modes and set `already_have_subtitle=True` only for `both`. MP3 embedded/both modes compile to external subtitles and set `completion_note="音频已下载，字幕已保存为独立文件"`.

- [ ] **Step 5: Compile trusted final-name templates**

For page tasks use a page key template `%(extractor)s-%(id)s`; for direct media use the literal URL hash from `stable_source_key`. The default leaf is:

```python
"%(title)s [%(extractor)s-%(id)s].%(ext)s"
```

If a custom template lacks either `%(extractor)s` or `%(id)s`, insert ` [<source-key-template>]` immediately before `%(ext)s`. Prefix playlist leaves with `f"{playlist_index:03d} - "`; build the folder from `safe_component(f"{group_title} [{group_key}]")`, where `group_key` is the first eight hexadecimal characters of `group_id` or the first eight characters of its SHA-256 when the ID is not hexadecimal.

- [ ] **Step 6: Run compiler tests**

Run:

```powershell
& 'D:\work\downany\venv\Scripts\python.exe' -m pytest tests/core/test_output_contract.py tests/core/test_quality.py -q
```

Expected: PASS, including exact postprocessor order and absence of the two hidden nonfunctional options.

- [ ] **Step 7: Commit the output compiler**

```powershell
git add src/core/output_contract.py tests/core/test_output_contract.py tests/core/test_quality.py
git commit -m "feat: compile verified output plans"
```

### Task 5: Verify media structure with a bounded ffprobe contract

**Files:**
- Create: `src/core/media_verifier.py`
- Test: `tests/core/test_media_verifier.py`

**Interfaces:**
- Consumes: `MediaKind` from `src/core/output_contract.py` and `OutputVerificationFailed` from `src/core/error_codes.py`.
- Produces: `VerificationExpectation`, `MediaVerification`, and `verify_media()`.

```python
@dataclass(frozen=True)
class VerificationExpectation:
    media_kind: MediaKind
    allowed_containers: frozenset[str]
    require_title: bool = False
    require_cover: bool = False
    require_chapters: bool = False
    embedded_subtitle_languages: tuple[str, ...] = ()


@dataclass(frozen=True)
class MediaVerification:
    container: str
    stream_types: tuple[str, ...]
    subtitle_languages: tuple[str, ...]
    has_cover: bool
    has_title: bool
    chapter_count: int


def verify_media(
    path: Path,
    ffprobe_path: Path,
    expectation: VerificationExpectation,
    *,
    timeout_seconds: float = 15.0,
    run: Callable[..., subprocess.CompletedProcess[bytes]] = subprocess.run,
) -> MediaVerification:
    """Return a normalized report or raise OutputVerificationFailed."""
```

- [ ] **Step 1: Write failing process-boundary and media-contract tests**

Use an injected `run` fake and assert the complete argv, timeout, `shell=False`, and bounded capture behavior:

```python
def test_verify_media_uses_fixed_ffprobe_contract(tmp_path):
    media = tmp_path / "ready.mp4"
    media.write_bytes(b"media")
    run = Mock(return_value=CompletedProcess([], 0, _mp4_payload(), b""))

    report = verify_media(
        media,
        Path("ffprobe"),
        VerificationExpectation(MediaKind.VIDEO, frozenset({"mp4"})),
        run=run,
    )

    assert report.container == "mp4"
    assert run.call_args.args[0] == [
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", "-show_chapters", str(media),
    ]
    assert run.call_args.kwargs == {
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "timeout": 15.0,
        "check": False,
        "shell": False,
    }
```

Add RED cases for a missing path, a directory, a zero-byte file, non-zero ffprobe exit, timeout, malformed JSON, JSON larger than 1 MiB, a missing video/audio stream, and a container outside the allowlist. Assert only the stable product message is exposed through `OutputVerificationFailed`; subprocess output and the absolute path must not appear in `str(exc)`.

- [ ] **Step 2: Run the focused tests and verify RED**

```powershell
& 'D:\work\downany\venv\Scripts\python.exe' -m pytest tests/core/test_media_verifier.py -q
```

Expected: FAIL because `src.core.media_verifier` does not exist.

- [ ] **Step 3: Implement the bounded ffprobe invocation and normalization**

Invoke exactly:

```python
argv = [
    str(ffprobe_path),
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    "-show_chapters",
    str(path),
]
```

Before JSON decoding, reject `stdout` or `stderr` longer than `1024 * 1024` bytes and decode at most that bound. Normalize ffprobe `format.format_name` and the suffix into these product containers:

```python
CONTAINER_ALIASES = {
    "mp4": frozenset({"mp4", "mov", "m4a", "3gp", "3g2", "mj2"}),
    "mkv": frozenset({"matroska", "webm"}),
    "mp3": frozenset({"mp3"}),
}
```

Choose `mp4` for `.mp4`/`.m4v` when the ffprobe names include the MP4 family, `mkv` for `.mkv`/`.webm` when they include Matroska/WebM, and `mp3` for `.mp3`. A suffix/ffprobe disagreement fails verification.

- [ ] **Step 4: Implement stream and optional-feature checks**

- `MediaKind.VIDEO` requires at least one stream with `codec_type == "video"`; `MediaKind.AUDIO` requires at least one audio stream.
- `has_cover` is true for a stream whose `disposition.attached_pic == 1` or whose `codec_type == "attachment"`.
- `has_title` is true when a non-empty `title` exists in format tags or any stream tags.
- `chapter_count` is the number of objects in the top-level `chapters` array.
- Subtitle languages come only from subtitle streams. Normalize language tags with `casefold()` and compare requested languages without inventing a match for an untagged stream.
- Compare BCP-47 primary tags with ffprobe ISO-639 aliases: `en`/`eng` and `zh`/`zho`/`chi`; for example `zh-Hans` may match `zho`, but never `und` or an absent tag.
- Enforce `require_title`, `require_cover`, `require_chapters`, and every `embedded_subtitle_languages` entry only when requested by the expectation.

Return a frozen `MediaVerification`; log raw diagnostics only through the existing stderr logger.

- [ ] **Step 5: Run the verifier tests**

```powershell
& 'D:\work\downany\venv\Scripts\python.exe' -m pytest tests/core/test_media_verifier.py -q
```

Expected: PASS for valid MP4/MKV/MP3 payloads and every failure boundary above.

- [ ] **Step 6: Commit the verifier**

```powershell
git add src/core/media_verifier.py tests/core/test_media_verifier.py
git commit -m "feat: verify completed media structure"
```

### Task 6: Make Downloader return one structured staging result

**Files:**
- Modify: `src/core/downloader.py:1-281`
- Test: `tests/core/test_downloader.py`

**Interfaces:**
- Consumes: `OutputPlan` and `MediaToolchain`.
- Replaces: `Downloader.download(url, opts) -> str` with the structured call below.
- Removes: `resolve_output_path()` and every completion decision based on a progress-hook filename, `_filename`, `requested_downloads`, or guessed siblings.
- Preserves intermediate-commit compatibility with `Downloader(download_dir=None, *, ydl_factory=yt_dlp.YoutubeDL)`; `download_dir` is no longer used for output placement and is removed from manager construction in Task 8. The injectable factory lets tests return a real `YoutubeDL` with a local fixture extractor.

```python
@dataclass(frozen=True)
class SubtitleArtifact:
    path: Path
    language: str
    extension: str


@dataclass(frozen=True)
class SourceFacts:
    selected_subtitle_languages: tuple[str, ...]
    missing_requested_subtitles: bool
    thumbnail_available: bool
    chapters_available: bool
    title_available: bool


@dataclass(frozen=True)
class DownloadResult:
    main_file: Path
    subtitles: tuple[SubtitleArtifact, ...]
    info: Mapping[str, Any]
    rendered_leaf: str
    source_key: str
    downloaded_this_run: bool
    source_facts: SourceFacts


def download(
    self,
    url: str,
    plan: OutputPlan,
    *,
    toolchain: MediaToolchain,
    staging_dir: Path,
) -> DownloadResult:
    """Download into staging and return only postprocessed output facts."""
```

- [ ] **Step 1: Replace permissive path tests with strict result tests**

Delete the sibling-guessing expectations from `tests/core/test_downloader.py`. Add a fake `YoutubeDL` that records options and returns postprocessed info:

```python
def test_download_accepts_only_postprocessed_info_filepath(tmp_path, ydl_factory):
    staging = tmp_path / "task-1"
    final = staging / "media.mp4"
    final.parent.mkdir()
    final.write_bytes(b"verified later")
    ydl_factory.info = {
        "id": "abc",
        "extractor": "youtube",
        "title": "A title",
        "filepath": str(final),
        "requested_downloads": [{"filepath": str(staging / "media.f137.mp4")}],
    }

    result = _downloader(ydl_factory).download(
        "https://example.test/watch/abc",
        _video_plan(),
        toolchain=_toolchain(tmp_path),
        staging_dir=staging,
    )

    assert result.main_file == final
    assert result.rendered_leaf == "A title [youtube-abc].mp4"
```

Add RED cases where only `requested_downloads[*].filepath`, `_filename`, or a progress-hook filename exists; all must raise `OutputVerificationFailed`. Also test a `filepath` outside `staging_dir`, a directory, and an empty file.

- [ ] **Step 2: Test the fixed staging options and immutable plan copy**

Assert `outtmpl == str(staging_dir / "media.%(ext)s")`, `paths.home` and `paths.temp` both point inside `staging_dir`, `noplaylist is True`, the compiled postprocessor order is unchanged, and `ffmpeg_location` is present only when the complete pair was resolved. Mutating the dict seen by fake yt-dlp must not mutate `OutputPlan`.

Assert `ydl.evaluate_outtmpl(plan.final_leaf_template, info, sanitize=True)` is called once and `prepare_filename()` is never called for a final user-visible name.

- [ ] **Step 3: Run the focused tests and verify RED**

```powershell
& 'D:\work\downany\venv\Scripts\python.exe' -m pytest tests/core/test_downloader.py -q
```

Expected: FAIL against the current string-returning downloader.

- [ ] **Step 4: Implement strict staging and result extraction**

Create `staging_dir` before opening yt-dlp, resolve it, and reject any returned path for which `main_file.resolve().is_relative_to(staging_dir.resolve())` is false. Require `info["filepath"]` to name one existing, regular, non-empty file after `extract_info(download=True)` returns.

Read external subtitle artifacts only from `requested_subtitles` entries with an existing regular `filepath`; retain them only for `SubtitleMode.EXTERNAL` or `SubtitleMode.BOTH`. Normalize language from the entry key or `name` and extension from the actual suffix. Never scan the staging directory to infer output identity.

Build `SourceFacts` from the returned info:

- selected subtitles: requested subtitle entries that produced a file or an embedded subtitle request;
- missing requested subtitles: the plan requested subtitles but no requested language was selected;
- thumbnail: a non-empty `thumbnail` or `thumbnails` entry;
- chapters: a non-empty `chapters` list;
- title: a non-placeholder extracted title.

Set `downloaded_this_run` when the progress hook observed `downloading`/`finished`, or when `main_file` did not exist before the yt-dlp session. Keep the existing YouTube transient retry and Twitter direct-media fallback, but reuse the same `OutputPlan`, `MediaToolchain`, and task staging directory on every attempt.

- [ ] **Step 5: Preserve callback, cookie, and cancellation behavior**

Keep protocol output quiet, retain `apply_cookiefile_from_headers()`/`cleanup_cookiefile()`, and preserve `DownloadCancelled` classification. The finished callback may report transfer completion but must not set product task state or supply a completion path.

- [ ] **Step 6: Run downloader tests**

```powershell
& 'D:\work\downany\venv\Scripts\python.exe' -m pytest tests/core/test_downloader.py tests/core/test_ytdlp_cookies.py tests/core/test_twitter_fallback.py -q
```

Expected: PASS with no final-path fallback to progress data or fragments.

- [ ] **Step 7: Commit the structured downloader**

```powershell
git add src/core/downloader.py tests/core/test_downloader.py
git commit -m "feat: return structured staging outputs"
```

### Task 7: Publish a collision-safe output bundle atomically

**Files:**
- Create: `src/core/output_commit.py`
- Test: `tests/core/test_output_commit.py`

**Interfaces:**
- Consumes: `DownloadResult` and `build_final_path_plan()`.
- Produces: `OutputFingerprint`, `CommittedOutput`, `publish_no_replace()`, `cleanup_stale_hidden_files()`, `rollback_committed_output()`, and `commit_output_bundle()`.

```python
@dataclass(frozen=True)
class OutputFingerprint:
    path: Path
    device: int
    inode: int
    size: int
    mtime_ns: int


@dataclass(frozen=True)
class CommittedOutput:
    main_file: Path
    subtitle_files: tuple[Path, ...]
    created_fingerprints: tuple[OutputFingerprint, ...]


def publish_no_replace(hidden: Path, target: Path) -> None:
    """Atomically make hidden visible at target, failing if target exists."""


def cleanup_stale_hidden_files(
    directory: Path,
    *,
    older_than_seconds: int = 86_400,
    now: Callable[[], float] = time.time,
) -> int:
    """Remove only aged Downany-owned hidden output copies in one directory."""


def rollback_committed_output(committed: CommittedOutput) -> None:
    """Remove only unchanged paths proven to have been created by this commit."""


def commit_output_bundle(
    *,
    download_root: Path,
    playlist_folder: str,
    result: DownloadResult,
    copy_file: Callable[[Path, Path], object] = shutil.copyfile,
    publisher: Callable[[Path, Path], None] = publish_no_replace,
) -> CommittedOutput:
    """Publish a complete bundle without replacing an existing target."""
```

- [ ] **Step 1: Write failing collision, rollback, and publication-order tests**

```python
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
```

Add tests that inject a publisher which raises `FileExistsError` during main publication after subtitles were published, and one which reports that atomic no-replace publication is unsupported. For a collision, assert every path and hidden `.downany-*.tmp` file created by that attempt is removed before retry. For unsupported publication, assert visible paths created by the attempt are rolled back, pre-existing paths remain byte-for-byte unchanged, and the unpublished hidden copy remains for controlled cleanup. Record calls and assert subtitles publish before the main file.

Add rollback tests proving `rollback_committed_output()` removes the just-created main and subtitles in reverse publication order, but refuses to remove a path whose device/inode/size/mtime fingerprint changed or that became a symlink.

- [ ] **Step 2: Run the focused tests and verify RED**

```powershell
& 'D:\work\downany\venv\Scripts\python.exe' -m pytest tests/core/test_output_commit.py -q
```

Expected: FAIL because the commit module does not exist.

- [ ] **Step 3: Implement durable hidden copies and one bundle collision index**

Hold a process-local lock keyed by the case-normalized resolved download root. For collision indices `1, 2, 3` and onward, call `build_final_path_plan()` once and derive the main and every external subtitle name from the same planned stem.

For each source, create a same-directory hidden path shaped as `.{target.name}.downany-{uuid4().hex}.tmp`, copy into it, reopen it, flush and `os.fsync()` the file descriptor, and verify source/destination sizes match. Do not write bytes directly to a user-visible final name.

- [ ] **Step 4: Implement true atomic no-replace publication**

First try `os.link(hidden, target)`, then unlink `hidden` after the link succeeds. When hard links are unavailable:

- on Windows call `MoveFileExW(hidden, target, MOVEFILE_WRITE_THROUGH)` without `MOVEFILE_REPLACE_EXISTING` and map `ERROR_FILE_EXISTS`/`ERROR_ALREADY_EXISTS` to `FileExistsError`;
- on macOS call `renamex_np(hidden, target, RENAME_EXCL)` through `ctypes` and map `EEXIST` to `FileExistsError`;
- on an unsupported platform raise `OutputVerificationFailed("当前磁盘无法安全保存成品")`.

Never call `os.replace()`. Publish external subtitles first and the main file last. Immediately capture `lstat()` device, inode, size, and nanosecond mtime for every path this commit created. After a successful bundle, fsync each affected directory where the platform supports directory fsync. A collision cleans hidden files before selecting the next suffix; an unsupported or indeterminate publisher failure rolls back only visible paths created by this attempt and retains unpublished hidden files for the controlled `.downany-*.tmp` cleanup path.

`cleanup_stale_hidden_files()` must be non-recursive and accept only regular, non-symlink files whose basename matches `^\..+\.downany-[0-9a-f]{32}\.tmp$` and whose age is at least 24 hours. Call it under the download-root lock before staging a new bundle in that directory. Tests must prove it never removes a fresh hidden copy, a symlink, a directory, or a similarly named customer file.

`rollback_committed_output()` is best-effort and never replaces the original pipeline exception. It logs cleanup failures only to the controlled stderr logger and never exposes a path through the product error.

- [ ] **Step 5: Run output-commit tests, including the race case**

Add a two-thread barrier test in which both calls initially target the same leaf. Assert one receives the base name, one receives ` (2)`, neither overwrites the other, and both byte payloads remain intact.

```powershell
& 'D:\work\downany\venv\Scripts\python.exe' -m pytest tests/core/test_output_commit.py tests/core/test_output_paths.py -q
```

Expected: PASS for collision retry, fingerprint-safe rollback, aged-hidden cleanup, main-last ordering, subtitle naming, and concurrent publication.

- [ ] **Step 6: Commit the publisher**

```powershell
git add src/core/output_commit.py tests/core/test_output_commit.py
git commit -m "feat: publish output bundles without overwrite"
```

### Task 8: Gate core completion on staging and final verification

**Files:**
- Modify: `src/core/download_manager.py:556-910`
- Modify: `src/core/interfaces.py:1-40`
- Test: `tests/core/test_download_manager.py`
- Create: `tests/core/test_download_manager_output_contract.py`

**Interfaces:**
- Consumes: `compile_output_plan()`, `resolve_media_toolchain()`, `Downloader.download()`, `verify_media()`, and `commit_output_bundle()`.
- Produces: no new public interface; changes the exact transition into `TaskStatus.COMPLETED`.
- Produces: private `_verification_expectation(plan: OutputPlan, facts: SourceFacts) -> VerificationExpectation` in `download_manager.py`.
- Produces: private `_verify_external_subtitles(paths: tuple[Path, ...], root: Path) -> None` in `download_manager.py`.

- [ ] **Step 1: Write failing state-order tests with injected pipeline fakes**

Use one recording fake for compiler, toolchain, downloader, verifier, committer, history, queue, event sink, and `OutputReadySink`:

```python
def test_completed_is_persisted_only_after_final_verification(manager, pipeline):
    manager._process_task(pipeline.task)

    assert pipeline.calls == [
        "compile",
        "toolchain",
        "download",
        "verify:staging",
        "commit",
        "verify:final",
        "history:completed",
        "queue:completed",
        "telegram:ready",
        "event:task_completed",
    ]
    assert pipeline.task.file_path == str(pipeline.committed.main_file)
    assert pipeline.task.status is TaskStatus.COMPLETED
```

Add a test at each failure point. Before final verification succeeds, assert there is no completed history row, no completed queue snapshot, no `task_completed`, and no Telegram `mark_ready()`. A collision with an existing target must yield a newly committed path; it must never accept the old path as this task's result. When final ffprobe, root containment, or any external-subtitle check fails after publication, assert `rollback_committed_output()` removes the unchanged paths created by this task and leaves every pre-existing path untouched.

- [ ] **Step 2: Test exact error codes and safe messages**

Cover these boundaries:

| Failure | `error_code` | Product message |
| --- | --- | --- |
| path/template/root budget | `output_path_invalid` | `下载位置或文件名不可用` |
| required pair missing | `media_tools_missing` | `媒体工具不完整，请重新安装` |
| staging/final ffprobe or commit | `output_verification_failed` | `成品无法验证，请导出诊断后重试` |

Assert `task_failed` contains the product message only. The task staging path, final absolute path, URL, ffprobe output, and exception repr must be absent from `error_message`, event payload, and `completion_note`.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
& 'D:\work\downany\venv\Scripts\python.exe' -m pytest tests/core/test_download_manager.py tests/core/test_download_manager_output_contract.py -q
```

Expected: FAIL because the manager currently sets completed immediately after `Downloader.download()`.

- [ ] **Step 4: Add one explicit pipeline to `_process_task`**

Implement this order for ordinary tasks:

```python
plan = compile_output_plan(task)
project_root = Path(__file__).resolve().parents[2]
toolchain = resolve_media_toolchain(project_root=project_root)
if toolchain is None:
    raise MediaToolsMissing("媒体工具不完整，请重新安装")
staging_dir = Path(self.temp_dir) / task.id
result = downloader.download(
    task.video_info.url,
    plan,
    toolchain=toolchain,
    staging_dir=staging_dir,
)
expectation = _verification_expectation(plan, result.source_facts)
verify_media(result.main_file, toolchain.ffprobe, expectation)
committed = commit_output_bundle(
    download_root=Path(task.options.output_path),
    playlist_folder=plan.playlist_folder,
    result=result,
)
try:
    final_root = Path(task.options.output_path).resolve()
    if not committed.main_file.resolve().is_relative_to(final_root):
        raise OutputVerificationFailed("成品无法验证，请导出诊断后重试")
    verify_media(committed.main_file, toolchain.ffprobe, expectation)
    _verify_external_subtitles(committed.subtitle_files, final_root)
except Exception:
    rollback_committed_output(committed)
    raise
```

`_verification_expectation()` requires title, cover, or chapters only when metadata embedding is enabled and `SourceFacts` says the source supplied that feature. It requires selected embedded subtitle languages only for embedded/both video modes. Verify every external subtitle is a regular non-empty file before and after commit.

- [ ] **Step 5: Finalize state only after the second verification**

Inside the manager lock, backfill title/thumbnail from `result.info`, set `file_path` to the committed main path, set progress to 100, set `completed_at`, and build `completion_note` from the plan plus `SourceFacts.missing_requested_subtitles`. Use `未找到所选语言字幕` when `plan.requested_subtitle_languages` is non-empty and `未找到可用字幕` for blank-language automatic selection. Persist completed history and queue state only after those fields are final.

For an ordinary task, call `output_ready_sink.mark_ready()` after completed persistence and before emitting exactly one `task_completed`. If `mark_ready()` itself fails, log the downstream failure but do not invalidate a verified local file; the existing Telegram retry ledger owns delivery recovery.

Delete the task staging directory only after successful final verification and durable completed persistence. A paused task keeps its staging directory for yt-dlp resume. A failed task keeps diagnostic staging data until the next explicit retry prepares that same task directory.

- [ ] **Step 6: Remove obsolete option assembly from the manager**

Delete manager-side postprocessor construction and stop passing `download_sections` and `sponsorblock_remove` to yt-dlp. Preserve both fields in settings/queue serialization for downgrade compatibility. Keep proxy, cookies, headers, rate limit, concurrent fragments, quality, format selection, metadata, and subtitle inputs by compiling them through `OutputPlan`.

- [ ] **Step 7: Run core manager regression tests**

```powershell
& 'D:\work\downany\venv\Scripts\python.exe' -m pytest tests/core/test_download_manager.py tests/core/test_download_manager_output_contract.py tests/data/test_queue_store.py tests/data/test_database.py -q
```

Expected: PASS with no completed transition on an unverified or absent file.

- [ ] **Step 8: Commit the verified completion gate**

```powershell
git add src/core/download_manager.py src/core/interfaces.py tests/core/test_download_manager.py tests/core/test_download_manager_output_contract.py
git commit -m "feat: gate completion on verified output"
```

### Task 9: Make custom-script and Telegram handoff a single completion transaction

**Files:**
- Modify: `src/core/download_manager.py:483-519`
- Modify: `src/core/download_manager.py:835-884`
- Test: `tests/core/test_download_manager.py`
- Modify: `tests/core/test_download_manager_output_contract.py`

**Interfaces:**
- Consumes: the verified `CommittedOutput` from Task 8 and the existing `OutputReadySink` lease methods.
- Produces: exactly one renderer completion event and at most one Telegram-ready transition per task execution.

- [ ] **Step 1: Write failing event-order tests for the no-script path**

Use a sink and event emitter that append to the same list. Assert the ordinary verified flow finishes in this order:

```python
assert calls[-4:] == [
    "history:completed",
    "queue:completed",
    "telegram:ready",
    "event:task_completed",
]
assert calls.count("event:task_completed") == 1
assert calls.count("telegram:ready") == 1
```

This test protects the Task 8 order after the script branch is introduced.

- [ ] **Step 2: Write failing script-success and script-failure tests**

For a successful script assert:

1. the base committed file is verified;
2. `task.file_path` is persisted while the task is still `downloading`;
3. `mark_processing(task, "postprocess:<task-id>", lease)` runs before the command;
4. the script receives only the committed main path;
5. the possibly modified main file is verified again;
6. completed history/queue state, `mark_ready(owner_id=owner_id)`, and one `task_completed` follow.

For a non-zero script exit with the media still valid, assert:

```python
assert task.status is TaskStatus.COMPLETED
assert task.completion_note == "视频已下载，后处理脚本未完成"
sink.mark_processing_failed.assert_called_once()
sink.mark_ready.assert_not_called()
events.assert_emitted_once("task_completed", {"task_id": task.id})
```

For a script that removes, empties, or corrupts the file, assert `TaskStatus.FAILED`, `error_code == "output_verification_failed"`, `mark_processing_failed()` once, no completed history state, no `mark_ready()`, and no `task_completed`.

- [ ] **Step 3: Run the focused tests and verify RED**

```powershell
& 'D:\work\downany\venv\Scripts\python.exe' -m pytest tests/core/test_download_manager.py tests/core/test_download_manager_output_contract.py -q
```

Expected: FAIL because the current manager emits completion before running the script.

- [ ] **Step 4: Move script execution inside the completion gate**

After the committed file passes its first final verification, set `task.file_path` and upsert a non-completed history/queue snapshot so restart recovery knows the exact local file. Keep the renderer-visible task status as `downloading` while the script runs.

Acquire the durable processing lease with a 900-second expiry, execute the existing 600-second bounded command, and then run the same `verify_media(committed.main_file, toolchain.ffprobe, expectation)` contract again. Do not pass subtitle files, URL, credentials, or temp paths to the script.

- [ ] **Step 5: Finalize each script outcome exactly once**

- Script success plus successful re-verification: set completed, clear `completion_note` unless the plan already has a subtitle note, persist once, call `mark_ready()` with the processing owner, then emit one completion.
- Script failure plus successful re-verification: keep the verified local result, set the fixed completion note, persist completed, call `mark_processing_failed()` with a stable non-secret reason, do not enqueue Telegram automatically, then emit one completion.
- Missing/invalid output after script: set the stable verification failure, persist failed, call `mark_processing_failed()`, emit `task_failed`, and never emit completion.

Do not emit a transient completion before any script outcome is known.

- [ ] **Step 6: Run manager and Telegram ledger tests**

```powershell
& 'D:\work\downany\venv\Scripts\python.exe' -m pytest tests/core/test_download_manager.py tests/core/test_download_manager_output_contract.py tests/sidecar/test_telegram_delivery_service.py tests/data/test_telegram_delivery_store.py -q
```

Expected: PASS with single-event ordering and no automatic delivery after script failure.

- [ ] **Step 7: Commit the handoff ordering**

```powershell
git add src/core/download_manager.py tests/core/test_download_manager.py tests/core/test_download_manager_output_contract.py
git commit -m "fix: serialize output completion handoff"
```

### Task 10: Expose truthful subtitle modes, completion notes, and recovery actions

**Files:**
- Create: `desktop/renderer/lib/outputSettings.ts`
- Create: `desktop/renderer/lib/outputSettings.test.ts`
- Modify: `desktop/renderer/lib/types.ts:38-90`
- Modify: `desktop/renderer/test/taskFixture.ts:3-30`
- Modify: `desktop/renderer/SettingsApp.tsx:105-289`
- Modify: `desktop/renderer/components/task/taskPresentation.ts:70-126`
- Modify: `desktop/renderer/components/task/taskPresentation.test.ts`
- Modify: `desktop/renderer/components/task/failureRecovery.ts:1-70`
- Create: `desktop/renderer/components/task/failureRecovery.test.ts`
- Modify: `desktop/renderer/components/task/useTaskCommands.ts:9-82`
- Modify: `desktop/renderer/components/task/TaskActionsMenu.tsx:136-238`
- Modify: `desktop/renderer/components/task/MediaTaskBanner.tsx:1-405`
- Modify: `desktop/renderer/components/task/MediaTaskBanner.test.tsx`

**Interfaces:**
- Produces: `SubtitleMode`, `subtitleModeFromSettings()`, and `subtitleModePatch()`.
- Extends: `TaskSnapshot.completion_note` and `FailureRecoveryView.requiresRetryConfirmation`.
- Extends: `TaskCommands` with `exportDiagnostics()` and `openAppDownload()`.

```typescript
export type SubtitleMode = "none" | "external" | "embedded" | "both";

export function subtitleModeFromSettings(settings: {
  download_subtitles?: boolean;
  embed_subs?: boolean;
}): SubtitleMode;

export function subtitleModePatch(mode: SubtitleMode): {
  download_subtitles: boolean;
  embed_subs: boolean;
};
```

- [ ] **Step 1: Write failing four-mode mapping tests**

```typescript
it.each([
  [{ download_subtitles: false, embed_subs: false }, "none"],
  [{ download_subtitles: true, embed_subs: false }, "external"],
  [{ download_subtitles: false, embed_subs: true }, "embedded"],
  [{ download_subtitles: true, embed_subs: true }, "both"],
] as const)("maps persisted subtitle booleans", (settings, mode) => {
  expect(subtitleModeFromSettings(settings)).toBe(mode);
  expect(subtitleModeFromSettings(subtitleModePatch(mode))).toBe(mode);
});
```

- [ ] **Step 2: Run the focused mapping test and verify RED**

```powershell
Set-Location desktop
$env:NODE_OPTIONS='--no-experimental-webstorage'
npm.cmd test -- --run renderer/lib/outputSettings.test.ts
```

Expected: FAIL because `outputSettings.ts` does not exist.

- [ ] **Step 3: Replace the two subtitle checkboxes with one product control**

Render a `select` labeled `字幕` with these exact choices:

- `不下载字幕`
- `保存独立字幕`
- `写入视频`
- `写入视频并保留独立字幕`

Changing it writes both legacy booleans in one settings patch. Keep the language input and change its placeholder to `如 zh-Hans,en（留空则自动选择一个可用字幕）`.

When `postprocessing === "mp3"` and the chosen mode is embedded/both, show `MP3 不支持写入字幕，将保存为独立字幕文件` without silently changing the stored preference. Rename the metadata setting to `写入媒体信息` and show `来源提供时写入标题、封面和章节` as its supporting text.

Remove the visible `片段裁剪` and `SponsorBlock 去除` rows. Do not delete their TypeScript fields or config persistence.

- [ ] **Step 4: Write failing completion-note and recovery-view tests**

Add these fixed views:

| Error code | Detail | Actions | Retry |
| --- | --- | --- | --- |
| `output_path_invalid` | `下载位置或文件名不可用，请检查下载位置和命名设置` | download settings | allowed |
| `media_tools_missing` | `媒体工具不完整，请重新安装 Downany` | app download, diagnostics | disabled |
| `output_verification_failed` | `成品无法验证，请导出诊断后重试` | diagnostics | allowed after confirmation |

Extend `FailureRecoveryAction` with `downloadSettings`, `appDownload`, and `diagnostics`. Extend every view with an explicit `requiresRetryConfirmation` boolean; it is true only for `output_verification_failed`.

Assert a completed task uses `completion_note` as `TaskPresentation.detail`, and that a raw `error_message` containing a URL, token, or local path is never rendered.

- [ ] **Step 5: Run recovery tests and verify RED**

```powershell
Set-Location desktop
$env:NODE_OPTIONS='--no-experimental-webstorage'
npm.cmd test -- --run renderer/components/task/failureRecovery.test.ts renderer/components/task/taskPresentation.test.ts renderer/components/task/MediaTaskBanner.test.tsx
```

Expected: FAIL because the new codes, completion detail, actions, and confirmation behavior do not exist.

- [ ] **Step 6: Implement safe recovery commands**

`exportDiagnostics()` must call `request<{ ok: boolean; path: string }>("app.exportDiagnostics", {})`, reveal the returned path with `window.api.showItemInFolder()`, and show only `诊断包已导出` or `诊断包导出失败，请稍后重试。`.

`openAppDownload()` must call `window.api.checkAppUpdate()`, open its `downloadUrl` with `window.api.openExternal()` when present, and otherwise show `暂时无法打开下载页面，请稍后重试。`. Do not display a caught exception string.

Map `downloadSettings` to the existing settings window, `appDownload` to `openAppDownload()`, and `diagnostics` to `exportDiagnostics()` with exhaustive TypeScript switches.

- [ ] **Step 7: Require confirmation for every verification retry entry point**

Add a controlled `ConfirmDialog` to `MediaTaskBanner` with:

- title: `重新下载这项内容？`
- message: `上次生成的文件未通过检查。重试会重新下载并保存为新文件，不会覆盖已有文件。`
- confirm label: `重新下载`

Primary-button and task-menu retry actions both call one `requestRetry()` callback. It opens the dialog only when `failureRecoveryFor(task.error_code).requiresRetryConfirmation` is true; all other retry/cancelled flows retain one-click behavior. Confirmation sends `download.retry` exactly once; cancellation sends nothing.

Change `runPrimaryAction()` and `dispatchTaskAction()` to accept that retry callback, and add `onRetryRequested: () => Promise<void>` to `TaskActionsMenuProps`. The `retry` switch branch calls this callback; pause, resume, cancel, remove, open, reveal, rename, and option editing keep their existing command paths.

- [ ] **Step 8: Run renderer tests and verify GREEN**

```powershell
Set-Location desktop
$env:NODE_OPTIONS='--no-experimental-webstorage'
npm.cmd test -- --run renderer/lib/outputSettings.test.ts renderer/components/task/failureRecovery.test.ts renderer/components/task/taskPresentation.test.ts renderer/components/task/MediaTaskBanner.test.tsx
```

Expected: PASS for the four modes, safe copy, recovery actions, and confirmation paths.

- [ ] **Step 9: Run the renderer build**

```powershell
Set-Location desktop
$env:NODE_OPTIONS='--no-experimental-webstorage'
npm.cmd run build
```

Expected: PASS with exhaustive unions and no hidden-option type deletion.

- [ ] **Step 10: Commit the renderer contract**

```powershell
git add desktop/renderer/lib/outputSettings.ts desktop/renderer/lib/outputSettings.test.ts desktop/renderer/lib/types.ts desktop/renderer/test/taskFixture.ts desktop/renderer/SettingsApp.tsx desktop/renderer/components/task/taskPresentation.ts desktop/renderer/components/task/taskPresentation.test.ts desktop/renderer/components/task/failureRecovery.ts desktop/renderer/components/task/failureRecovery.test.ts desktop/renderer/components/task/useTaskCommands.ts desktop/renderer/components/task/TaskActionsMenu.tsx desktop/renderer/components/task/MediaTaskBanner.tsx desktop/renderer/components/task/MediaTaskBanner.test.tsx
git commit -m "feat: expose truthful output recovery"
```

### Task 11: Detect playlist candidates once and restore grouped results from the same database

**Files:**
- Modify: `src/core/url_parser.py:121-145`
- Modify: `src/sidecar/handlers.py:308-420`
- Modify: `tests/core/test_url_parser.py`
- Modify: `tests/sidecar/test_handlers.py`
- Modify: `desktop/renderer/lib/urls.ts:18-39`
- Modify: `desktop/renderer/lib/urls.test.ts`
- Modify: `desktop/renderer/lib/addFlow.ts:31-67`
- Create: `desktop/renderer/lib/addFlow.test.ts`
- Modify: `desktop/renderer/components/AddConfirmDialog.tsx:101-291`
- Create: `desktop/renderer/components/AddConfirmDialog.test.tsx`
- Modify: `tests/data/test_queue_store.py`
- Modify: `tests/core/test_download_manager.py`
- Modify: `desktop/renderer/components/TaskList.test.tsx`

**Interfaces:**
- Preserves: `allow_playlist=True` only for candidate parsing and `noplaylist=True` for every resulting download task.
- Preserves: `group_id`, `group_title`, `playlist_index`, `file_path`, status, and `completion_note` across same-database restart.

- [ ] **Step 1: Write failing URL-classification tests**

Add identical Python and TypeScript tables:

```text
YouTube /playlist?list=PL123      candidate
YouTube /watch?v=abc&list=PL123   candidate
YouTube /watch?v=abc              single
Bilibili /video/BV1abc            candidate
Bilibili /video/BV1abc?p=2        candidate
Bilibili /bangumi/play/ep123      candidate
generic /playlist or /collection candidate
ordinary direct media URL          single
```

The bare Bilibili `/video/` case must be a candidate because only an `allow_playlist` metadata parse can distinguish one P from several P entries.

- [ ] **Step 2: Test one-time sidecar expansion**

Add handler tests for a bare Bilibili video whose parse yields one entry and another whose parse yields three entries. One entry must fall back to one ungrouped task. Three entries must become three tasks sharing one non-empty `group_id`, with stable `group_title`, indexes 1/2/3, and `page_url` set to the original page.

Send those already-grouped items back through `download.createTasks` and assert `ParseSession` is not called again. Keep the existing rule: any non-empty `group_id` or positive `playlist_index` proves client expansion already happened.

- [ ] **Step 3: Test renderer confirmation and selection**

In `addFlow.test.ts`, assert a bare Bilibili video opens the confirmation flow even when `auto_start_downloads` is true. In `AddConfirmDialog.test.tsx`, feed a three-entry parse payload, select entries 1 and 3, and assert `download.createTasks` receives two items with one shared generated group ID, original group title, and indexes 1 and 3.

Also assert a one-entry parse renders the normal single-item confirmation and sends no group fields.

- [ ] **Step 4: Run URL and handler tests and verify RED**

```powershell
& 'D:\work\downany\venv\Scripts\python.exe' -m pytest tests/core/test_url_parser.py tests/sidecar/test_handlers.py -q
Set-Location desktop
$env:NODE_OPTIONS='--no-experimental-webstorage'
npm.cmd test -- --run renderer/lib/urls.test.ts renderer/lib/addFlow.test.ts renderer/components/AddConfirmDialog.test.tsx
```

Expected: FAIL for the bare Bilibili candidate before implementation.

- [ ] **Step 5: Implement candidate detection and single expansion**

Update Python and TypeScript classifiers together. In `_expand_playlist_specs()`, continue returning `None` for zero/one usable entry so `_create_tasks()` creates one ungrouped task; return grouped specs only for two or more usable entries. Never set `allow_playlist` on a queued child task, and never pass a grouped parent URL to the downloader.

- [ ] **Step 6: Write and pass same-database restart tests**

Create a real `QueueStore` in a temporary directory, persist:

- one grouped `downloading` task with an external subtitle completion note;
- one grouped completed task with a real `file_path`;
- one ordinary completed task.

Construct a new `DownloadManager` against that exact database and call `restore_tasks()`. Assert downloading becomes paused, completed stays completed, and every group field, index, file path, and completion note is unchanged after loading the database a second time.

Snapshot the completed files before restore and assert their names, parent directories, sizes, mtimes, and bytes are unchanged. Exercise the existing group-delete API against one restored group and assert it removes only that group's tracked files and queue rows; the ordinary completed file and unrelated files in the same download root must remain.

In `TaskList.test.tsx`, hydrate the restored snapshots and assert the two grouped rows render inside one playlist group in playlist-index order, the ordinary task remains outside it, and the completed row's Open action uses its restored final path.

- [ ] **Step 7: Run playlist and restart regressions**

```powershell
& 'D:\work\downany\venv\Scripts\python.exe' -m pytest tests/core/test_url_parser.py tests/sidecar/test_handlers.py tests/core/test_download_manager.py tests/data/test_queue_store.py -q
Set-Location desktop
$env:NODE_OPTIONS='--no-experimental-webstorage'
npm.cmd test -- --run renderer/lib/urls.test.ts renderer/lib/addFlow.test.ts renderer/components/AddConfirmDialog.test.tsx renderer/components/TaskList.test.tsx
```

Expected: PASS with one expansion, stable grouping, and openable restored output.

- [ ] **Step 8: Commit playlist and restart behavior**

```powershell
git add src/core/url_parser.py src/sidecar/handlers.py tests/core/test_url_parser.py tests/sidecar/test_handlers.py desktop/renderer/lib/urls.ts desktop/renderer/lib/urls.test.ts desktop/renderer/lib/addFlow.ts desktop/renderer/lib/addFlow.test.ts desktop/renderer/components/AddConfirmDialog.tsx desktop/renderer/components/AddConfirmDialog.test.tsx tests/data/test_queue_store.py tests/core/test_download_manager.py desktop/renderer/components/TaskList.test.tsx
git commit -m "fix: preserve playlist output groups"
```

### Task 12: Package and smoke-test ffmpeg and ffprobe as one toolchain

**Files:**
- Modify: `scripts/fetch_release_binaries.ps1`
- Modify: `scripts/fetch_release_binaries.sh`
- Modify: `scripts/install_ffmpeg.sh`
- Modify: `scripts/build_windows_nsis.ps1`
- Modify: `scripts/build_macos_dmg.sh`
- Create: `scripts/test_packaged_media_tools.mjs`
- Create: `scripts/test_packaged_media_tools.test.mjs`
- Modify: `scripts/test_packaged_sidecar.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/RELEASE.md`

**Interfaces:**
- Produces: `node scripts/test_packaged_media_tools.mjs --bin-dir=<absolute-directory>`.
- Requires: one executable `ffmpeg`/`ffmpeg.exe` and `ffprobe`/`ffprobe.exe` pair in the supplied directory.
- Preserves: `desktop/electron-builder.yml`, whose existing whole-directory `resources/bin` mapping already packages both files.

- [ ] **Step 1: Write failing packaged-tool helper tests**

Export pure helpers from the new `.mjs` file and inject a command runner in unit tests. Cover platform executable names, missing either member, non-zero version probes, malformed ffprobe JSON, and a successful sample with one video and one audio stream.

The integration entry point must:

1. run both `-version` commands with a 15-second timeout;
2. create a temporary directory;
3. use the supplied ffmpeg to generate a 0.5-second color video plus sine-wave audio;
4. use the supplied ffprobe with the fixed JSON contract;
5. require a video stream, an audio stream, and a recognized container;
6. remove only its own temporary directory in `finally`.

Use this portable generation command shape, substituting the resolved executable and temp paths without a shell:

```text
ffmpeg -v error -y -f lavfi -i color=size=160x90:rate=10:duration=0.5 -f lavfi -i sine=frequency=880:duration=0.5 -c:v mpeg4 -c:a aac -shortest sample.mp4
```

Probe with `ffprobe -v error -print_format json -show_format -show_streams -show_chapters sample.mp4`. Each spawned process uses a 15-second timeout and a 1 MiB output buffer.

```javascript
const result = await smokeMediaTools({
  binDir,
  platform: process.platform,
  run: spawnSync,
});
if (!result.ok) throw new Error(result.productMessage);
```

- [ ] **Step 2: Run the helper tests and verify RED**

```powershell
node --test scripts/test_packaged_media_tools.test.mjs
```

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Extract the Windows pair from the same locked archive**

In both Windows fetch implementations, recursively find exactly one `ffmpeg.exe` and one `ffprobe.exe` beneath the extracted BtbN archive. Fail if either is absent or they do not share the same extracted `bin` directory. Copy both to `desktop/resources/bin` only after the archive SHA-256 passes.

Update comments and help text so they state the pair is retained. After copying, run `ffmpeg.exe -version` and `ffprobe.exe -version`; a non-zero exit fails the fetch. Keep the current fixed archive URL and SHA-256 so both binaries have one provenance boundary.

- [ ] **Step 4: Build and install the macOS pair from one source lock**

Remove `--disable-ffprobe` from `scripts/install_ffmpeg.sh`. Define `FFPROBE_BIN="${FFMPEG_STAGE}/bin/ffprobe"`, then apply the same executable, arm64 architecture, deployment target, and non-system dynamic-dependency checks to both binaries.

Install through hidden temporary names and publish both only after both validate. Write one `media-tools.sha256` containing exactly two relative entries, `ffmpeg` and `ffprobe`, then execute both installed `-version` commands and the packaged-tool smoke.

- [ ] **Step 5: Make both package scripts reject incomplete resources**

Windows preflight must require `resources\bin\ffmpeg.exe` and `resources\bin\ffprobe.exe`; macOS preflight must require executable `resources/bin/ffmpeg` and `resources/bin/ffprobe`. Each script runs `test_packaged_media_tools.mjs` against `desktop/resources/bin` before `electron-builder`. Missing or unusable tools stop the package before deleting or replacing any existing candidate artifacts.

- [ ] **Step 6: Extend Sidecar diagnostics smoke without leaking paths**

In `scripts/test_packaged_sidecar.mjs`, assert `app.exportDiagnostics` reports both `ffmpeg_available: true` and `ffprobe_available: true`, with version tokens other than `missing`/`unavailable`. Assert the serialized environment payload does not contain the resolved resource directory.

- [ ] **Step 7: Add pre-package and post-package CI gates**

Run the helper unit test in the desktop job. In each `native-resources` matrix leg, run the real helper against `desktop/resources/bin` and then against:

- Windows: the `win-unpacked\resources\bin` directory;
- macOS: `Downany.app/Contents/Resources/bin` inside the produced release tree.

Keep the existing packaged Sidecar handshake smoke after the tool smoke. A missing pair, unusable pair, invalid JSON, or missing expected streams must fail the job.

- [ ] **Step 8: Document the pair as a release invariant**

Update `docs/RELEASE.md` so fetch, preflight, package inspection, and unsigned-binary notes name both tools. Add both executable paths to the package checklist and state that they must come from the same locked archive/source build.

- [ ] **Step 9: Run local script and Python diagnostics tests**

```powershell
node --test scripts/test_packaged_media_tools.test.mjs scripts/package_smoke_helpers.test.mjs
& 'D:\work\downany\venv\Scripts\python.exe' -m pytest tests/sidecar/test_bin_paths.py tests/sidecar/test_diagnostics.py tests/sidecar/test_protocol.py -q
```

Expected: PASS. Run the real helper against `desktop/resources/bin` only after a native pair has been fetched; absence is a package-gate failure, not a unit-test skip.

- [ ] **Step 10: Commit paired packaging**

```powershell
git add scripts/fetch_release_binaries.ps1 scripts/fetch_release_binaries.sh scripts/install_ffmpeg.sh scripts/build_windows_nsis.ps1 scripts/build_macos_dmg.sh scripts/test_packaged_media_tools.mjs scripts/test_packaged_media_tools.test.mjs scripts/test_packaged_sidecar.mjs .github/workflows/ci.yml docs/RELEASE.md
git commit -m "build: package paired media tools"
```

### Task 13: Prove postprocessing with deterministic real media

**Files:**
- Create: `tests/core/test_media_pipeline_integration.py`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the `MediaToolchain`, `compile_output_plan()`, real yt-dlp postprocessors, and `verify_media()`.
- Uses: local loopback HTTP only; no public site or external network dependency.

- [ ] **Step 1: Write the five output assertions first and verify RED**

Create the five tests named in Step 5 against a `media_fixture` pytest fixture before defining that fixture. Run:

```powershell
& 'D:\work\downany\venv\Scripts\python.exe' -m pytest tests/core/test_media_pipeline_integration.py -q
```

Expected: ERROR at collection/setup because `media_fixture` is not defined; none of the tests may be marked passed or skipped at this RED point.

- [ ] **Step 2: Implement the environment gate and local fixture extractor**

Resolve the paired toolchain through production discovery. If it is absent, fail when `DOWNANY_REQUIRE_MEDIA_INTEGRATION=1`; otherwise use `pytest.skip()` only for developer unit runs that did not fetch native resources.

Create a test-only `InfoExtractor` with URLs `downanyfixture:mp4` and `downanyfixture:mkv`. It returns deterministic metadata and media/subtitle/thumbnail URLs served by a `ThreadingHTTPServer` bound to `127.0.0.1` on an ephemeral port. The server root is a pytest temp directory and is shut down in fixture cleanup.

- [ ] **Step 3: Generate controlled source assets with the resolved tools**

Use ffmpeg lavfi inputs to create:

- a one-second MPEG-4/AAC MP4 using built-in encoders;
- a one-second MPEG-4/AAC MKV fallback sample using built-in encoders;
- a PNG cover;
- a UTF-8 SRT containing one cue.

The extractor supplies title `Downany Fixture`, two chapters (`Intro`, `End`), the cover URL, and `zh-Hans` subtitles. Do not check generated binary fixtures into Git.

- [ ] **Step 4: Drive the real yt-dlp postprocessor queue**

For each product mode, compile an actual `OutputPlan`. Pass `Downloader(ydl_factory=fixture_ydl_factory)` a factory that constructs `yt_dlp.YoutubeDL(options)`, adds the fixture extractor, and returns that context manager. Call the production `Downloader.download()` with `downanyfixture:mp4` or its MKV counterpart. This must exercise the real `FFmpegVideoRemuxer`, `FFmpegVideoConvertor`, `FFmpegExtractAudio`, `FFmpegEmbedSubtitle`, `FFmpegMetadata`, and `EmbedThumbnail` classes selected by the plan.

Do not mock postprocessors or accept option-dictionary assertions as media evidence.

- [ ] **Step 5: Complete the five real output contracts**

1. Default MP4 contains video and audio streams and remains MP4.
2. Metadata MP4 contains title, cover, two chapters, and a `zh-Hans` subtitle stream.
3. The controlled fallback input remains MKV and passes the MKV allowlist; the compiler unit test separately proves a single-file WebM maps to stream-copy MKV remux.
4. MP3 extraction contains audio, title, and cover and has no video subtitle stream.
5. External/both modes retain a non-empty `.zh-Hans.srt` beside the committed main file; both mode also contains the subtitle stream.

Run `verify_media()` against both the staging main file and the committed main file. Assert the final bundle is beneath the requested output root and no visible media file exists before `commit_output_bundle()`.

- [ ] **Step 6: Run the deterministic test with a required local pair and verify GREEN**

```powershell
$env:DOWNANY_BIN_DIR=(Resolve-Path 'desktop/resources/bin').Path
$env:DOWNANY_REQUIRE_MEDIA_INTEGRATION='1'
& 'D:\work\downany\venv\Scripts\python.exe' -m pytest tests/core/test_media_pipeline_integration.py -q
```

Expected: PASS with five verified real-media contracts and zero external HTTP requests.

- [ ] **Step 7: Require the test in both native-resource CI legs**

After the package build has populated `desktop/resources/bin`, install `requirements-dev.txt`, set `DOWNANY_BIN_DIR` to that absolute directory and `DOWNANY_REQUIRE_MEDIA_INTEGRATION=1`, and run the focused pytest file on Windows and macOS. The required flag converts a missing pair into failure, so CI cannot report success through a skip.

- [ ] **Step 8: Commit deterministic media evidence**

```powershell
git add tests/core/test_media_pipeline_integration.py .github/workflows/ci.yml
git commit -m "test: verify real media postprocessing"
```

### Task 14: Build and accept the v0.2.4-A Windows candidate

**Files:**
- Modify: `desktop/package.json:3`
- Modify: `desktop/package-lock.json:3-9`
- Modify: `src/sidecar/protocol.py:8`
- Create after actual runs: `docs/acceptance/v0.2.4-output-correctness.md`
- Test: `tests/sidecar/test_protocol.py`

**Interfaces:**
- Produces: local candidate version `0.2.4` and an evidence record containing only observed results.
- Does not authorize: merge, push, tag, branch/worktree cleanup, website deployment, GitHub Release creation, or public artifact upload.

- [ ] **Step 1: Add a failing version-consistency assertion**

In `tests/sidecar/test_protocol.py`, read `desktop/package.json` and assert `package["version"] == APP_VERSION == "0.2.4"`. Run it before the bump and verify RED because both current sources still report 0.2.1.

```powershell
& 'D:\work\downany\venv\Scripts\python.exe' -m pytest tests/sidecar/test_protocol.py -q
```

Expected: FAIL only at the new candidate-version assertion.

- [ ] **Step 2: Set all application version sources to 0.2.4**

```powershell
Set-Location desktop
npm.cmd version 0.2.4 --no-git-tag-version
Set-Location ..
```

Update `APP_VERSION = "0.2.4"` in `src/sidecar/protocol.py`. Do not change `browser-extension/manifest.json`; its independently versioned `0.8.2` ZIP remains a required artifact for a later authorized release.

- [ ] **Step 3: Run the complete automated regression suite**

```powershell
& 'D:\work\downany\venv\Scripts\python.exe' -m pytest tests/core tests/data tests/sidecar tests/cli -q
Set-Location desktop
$env:NODE_OPTIONS='--no-experimental-webstorage'
npm.cmd test
npm.cmd run build
Set-Location ..\browser-extension
node shared.test.js
node sniff-core.test.js
node bridge-timeout.test.js
Set-Location ..
node --test scripts/package_smoke_helpers.test.mjs scripts/test_packaged_media_tools.test.mjs
```

Expected: every command exits zero. Record exact counts and durations from the real run; do not copy earlier baseline counts into acceptance evidence.

- [ ] **Step 4: Build and inspect the Windows NSIS candidate**

On Windows, fetch/build the paired resources and run:

```powershell
$env:BUILD_TELEGRAM_NATIVE='0'
$env:ALLOW_CLOUD_ONLY_PACKAGE='1'
$env:FETCH_BINS='1'
$env:BUILD_SIDECAR='1'
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\build_windows_nsis.ps1
```

Run the packaged media-tool, Sidecar, and Electron smokes against `win-unpacked`. Install the NSIS artifact on a real Windows user account, launch it, and confirm Open/In Folder uses the final verified output. Record installer filename, byte size, SHA-256, host architecture, and whether the build is unsigned.

- **Step 5: macOS DMG candidate — excluded by the user's 2026-08-27 scope change**

Historical instructions only; do not execute or wait for this step in the current task. On an Apple Silicon macOS host, the original plan was:

```bash
BUILD_TELEGRAM_NATIVE=0 ALLOW_CLOUD_ONLY_PACKAGE=1 FETCH_BINS=1 BUILD_SIDECAR=1 \
  ./scripts/build_macos_dmg.sh
```

Run the packaged media-tool, Sidecar, and Electron smokes against the `.app`, install/open the DMG on a real macOS account, and confirm Open/Reveal uses the final verified output. Record DMG filename, byte size, SHA-256, host architecture, deployment target, and unsigned Gatekeeper behavior.

No macOS host is required for the current task. Record macOS as out of scope, not passed; do not substitute a mocked, cross-compiled, or prior-version result.

- [ ] **Step 6: Perform the seven visible acceptance journeys on Windows**

Record date, OS version, app build hash, source URL or safe source identifier, final relative path, container/stream evidence, UI result, player used, and observed outcome for each:

1. one public video: download, source-provided metadata/cover, system-player open;
2. YouTube playlist: choose entries, independent folder, restart recovery, open child, then delete the group and verify only that group's tracked files are removed;
3. Bilibili multi-P/collection: ordering, Chinese names, restart recovery;
4. one ordinary-site list: parse, group, at least two outputs;
5. same title/different content, illegal characters, long title, and custom template;
6. external subtitles, embedded subtitles, both, and unavailable requested language;
7. MP4, MKV fallback, and MP3 opened in at least one common system player.

If a real site is unavailable, use a comparable public sample and record the replacement reason and date. Automated tests do not satisfy these visible journeys.

- [ ] **Step 7: Write evidence from observed values only**

Create `docs/acceptance/v0.2.4-output-correctness.md` only after the runs. Include:

- candidate commit and dirty-state check;
- exact automated command results;
- Windows artifact hashes and package-smoke results;
- one row per Windows visible journey; macOS explicitly out of scope and not claimed as passed;
- remaining known limitations;
- explicit statement that no merge, push, tag, cleanup, or public release occurred.

Do not pre-fill PASS, hashes, URLs, OS versions, or timestamps. A missing row remains an unmet gate and must be reported as such.

- [ ] **Step 8: Commit the verified candidate record**

Only after all automated, package, and visible gates pass:

```powershell
git add desktop/package.json desktop/package-lock.json src/sidecar/protocol.py tests/sidecar/test_protocol.py docs/acceptance/v0.2.4-output-correctness.md
git commit -m "chore: prepare v0.2.4 candidate"
git status --short
```

Expected: the worktree is clean and HEAD contains only the planned v0.2.4 commits. Stop here and request separate authorization before any merge, push, tag, worktree cleanup, or public release.
