# Telegram Cloud Video Segmentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Downany send downloaded videos larger than the Telegram cloud Bot API limit as resumable playable parts while preserving the existing single-file local Bot API path.

**Architecture:** Electron Main owns ffmpeg process execution and Telegram network calls. Sidecar SQLite owns the canonical segment manifest and per-part committed progress so a restart resumes after the last confirmed part. Each part uses the existing `preparing → sending` request boundary; `markSegmentSent` either returns to `preparing` or finalizes `sent`.

**Tech Stack:** Electron, TypeScript, Node `child_process`, ffmpeg, Python 3, SQLite, pytest, Vitest.

## Global Constraints

- Never modify, move, or delete the original downloaded file.
- Cloud parts must be ordinary playable video files smaller than `49_000_000` bytes.
- Local Bot API uploads up to `2_000_000_000` bytes remain single-file uploads.
- Do not expose Bot Token, local paths, manifest paths, or Telegram credentials to Renderer.
- All ffmpeg invocations use argument arrays with `shell: false` and support cancellation.
- Preserve unrelated dirty-worktree changes.
- Use `npm.cmd` and `npx.cmd` on Windows.

---

### Task 1: Persist segment manifest and progress

**Files:**
- Modify: `src/data/models.py`
- Modify: `src/data/telegram_delivery_store.py`
- Modify: `src/sidecar/telegram_delivery_service.py`
- Modify: `src/sidecar/handlers.py`
- Modify: `src/sidecar/protocol.py`
- Test: `tests/data/test_telegram_delivery_store.py`
- Test: `tests/sidecar/test_telegram_delivery_service.py`

**Interfaces:**
- Produces: `TelegramDeliverySegmentPart`, `TelegramDeliverySegmentManifest`, `set_segment_manifest(...)`, `mark_segment_sent(...)`.
- Produces claim fields: `segmentManifest`, `segmentNextIndex`, `segmentMessageIds`.

- [ ] **Step 1: Write failing store tests**

Add literal fixtures that create three parts, persist the manifest while leased in `preparing`, and assert:

```python
first = store.mark_segment_sent(delivery.id, lease_id, 0, "101", sent_at)
assert first.status == "preparing"
assert first.segment_next_index == 1
assert first.segment_message_ids == ("101",)
```

After lease recovery and re-claim, assert index `1` is returned. After part `2`, assert final status `sent`, IDs `("101", "102", "103")`, and no lease.

- [ ] **Step 2: Run tests and verify RED**

Run: `venv\Scripts\python.exe -m pytest tests/data/test_telegram_delivery_store.py tests/sidecar/test_telegram_delivery_service.py -q`

Expected: FAIL because segment types/methods do not exist.

- [ ] **Step 3: Add schema migration and atomic APIs**

Add nullable `segment_manifest_json`, integer `segment_next_index`, and JSON `segment_message_ids_json`. Parse strict canonical JSON into immutable dataclasses. `set_segment_manifest` accepts only `preparing` with the matching lease and no prior committed progress. `mark_segment_sent` accepts only `sending`, matching expected index, appends exactly one message ID, and returns to `preparing` unless it was the final part.

- [ ] **Step 4: Expose strict Sidecar protocol handlers**

Add `telegram.setSegmentManifest` and `telegram.markSegmentSent` with exact payload validation. Include segment fields only in Main-process claims; do not add paths to Renderer summaries.

- [ ] **Step 5: Run focused Python tests**

Run: `venv\Scripts\python.exe -m pytest tests/data/test_telegram_delivery_store.py tests/sidecar/test_telegram_delivery_service.py tests/sidecar/test_handlers.py tests/sidecar/test_protocol.py -q`

Expected: PASS.

### Task 2: Build a safe ffmpeg video segmenter

**Files:**
- Create: `desktop/electron/telegram/videoSegmenter.ts`
- Test: `desktop/electron/telegram/videoSegmenter.test.ts`

**Interfaces:**
- Produces: `TelegramVideoSegmenter.prepare(input, signal): Promise<TelegramSegmentManifest>`.
- Produces: `cleanupCompleted(deliveryId, manifest): Promise<void>`.

- [ ] **Step 1: Write failing behavior tests**

Use a fake process runner with real temporary files. Assert: a 49 MB input returns `null`; a 149 MB source creates ordered parts with literal indices, all sizes below `49_000_000`; an oversized copy result triggers a shorter retry; abort kills the runner; input/output links and paths outside the contained root fail before spawn; the original stat and SHA remain unchanged.

- [ ] **Step 2: Run tests and verify RED**

Run: `cd desktop; npm.cmd test -- videoSegmenter.test.ts`

Expected: FAIL because `videoSegmenter.ts` does not exist.

- [ ] **Step 3: Implement minimal segmenter**

Implement a focused module using `spawn(ffmpegPath, args, { shell: false, windowsHide: true, signal })`. Parse duration and stream codecs from bounded stderr, stream-copy only H.264/AAC-compatible sources, and transcode AV1/HEVC/non-AAC/unknown inputs to H.264/AAC (`yuv420p`, `avc1`) from the first attempt. Cap the first transcode segment at 135 seconds, verify every output with `lstat/open/fstat/SHA-256`, retry with shorter duration, and retain H.264/AAC fallback after bounded copy attempts for otherwise compatible sources.

- [ ] **Step 4: Add deterministic containment and cleanup**

Use `<dataDir>/telegram/segments/<deliveryId>/.building-<uuid>` then atomic rename to `ready`. Cleanup only paths derived from a validated delivery ID beneath the exact segments root. Never delete the source file.

- [ ] **Step 5: Run segmenter tests**

Run: `cd desktop; npm.cmd test -- videoSegmenter.test.ts`

Expected: PASS.

### Task 3: Send cloud video parts without duplicates

**Files:**
- Modify: `desktop/electron/telegram/types.ts`
- Modify: `desktop/electron/telegram/deliveryWorker.ts`
- Modify: `desktop/electron/telegram/controller.ts`
- Modify: `desktop/electron/main.ts`
- Test: `desktop/electron/telegram/deliveryWorker.test.ts`
- Test: `desktop/electron/telegram/delivery.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 claim segment fields and Task 2 `TelegramVideoSegmenter`.
- Produces: captions `第 i/N 段`; calls `telegram.markSegmentSent` after each explicit Telegram message ID.

- [ ] **Step 1: Replace the oversize-video expectation with failing part tests**

Test a three-part plan with message IDs `101`, `102`, `103`. Assert the client receives part paths in order and Sidecar calls alternate `markSending`, `markSegmentSent`. Start a claim with `segmentNextIndex=2` and assert only the third file is sent. Abort during preparation and assert no Telegram request plus safe `releaseClaim`. Abort during a part upload and assert `markUncertain` with prior progress unchanged.

- [ ] **Step 2: Run tests and verify RED**

Run: `cd desktop; npm.cmd test -- deliveryWorker.test.ts delivery.integration.test.ts`

Expected: FAIL because oversized videos still call `sendOversizeNotice`.

- [ ] **Step 3: Implement segmented orchestration**

For cloud clients and videos over `maxUploadBytes`, reuse a validated persisted manifest or prepare and persist a new one before the first `markSending`. Send from `segmentNextIndex`. Build a bounded caption containing title, `第 i/N 段`, size, and source URL. After each explicit message ID call `markSegmentSent`; only then advance in memory.

- [ ] **Step 4: Wire data and ffmpeg paths**

Construct the segmenter with `downanyDataDir()` and `<resourcesRoot>/bin/ffmpeg[.exe]`. Keep optional injection in Controller tests. Do not change Renderer IPC.

- [ ] **Step 5: Run focused desktop tests**

Run: `cd desktop; npm.cmd test -- videoSegmenter.test.ts deliveryWorker.test.ts delivery.integration.test.ts`

Expected: PASS.

### Task 4: Recovery, cleanup, and regression coverage

**Files:**
- Modify: `src/data/telegram_delivery_store.py`
- Modify: `desktop/electron/telegram/videoSegmenter.ts`
- Test: `tests/data/test_telegram_delivery_store.py`
- Test: `desktop/electron/telegram/deliveryWorker.test.ts`
- Test: `desktop/electron/telegram/videoSegmenter.test.ts`

**Interfaces:**
- Consumes: persisted manifests and final `sent` result.
- Produces: cleanup only after committed final success; orphan cleanup only for unowned build directories.

- [ ] **Step 1: Add crash-boundary tests**

Cover crash before manifest commit, after part message response but before `markSegmentSent`, after `markSegmentSent` but before the next request, and after final state commit but before temp cleanup. Use literal expected call sequences and verify no previously committed part is submitted again.

- [ ] **Step 2: Run crash tests and verify RED**

Run focused Python and desktop test files from Tasks 1–3.

Expected: at least the orphan/final cleanup assertions fail.

- [ ] **Step 3: Implement idempotent cleanup**

Delete only a validated manifest's contained directory after final `markSegmentSent` returns `sent`. On the next startup/claim, absence after committed `sent` is success. Preserve files for `failed`, `retry_wait`, and `uncertain`.

- [ ] **Step 4: Run focused tests**

Run the focused Python and desktop test files again.

Expected: PASS.

### Task 5: Full Windows verification and real Telegram acceptance

**Files:**
- Modify if needed: `docs/TELEGRAM.md`
- Generated only, do not commit: `desktop/release-next/**`

**Interfaces:**
- Produces: a Windows unpacked build and an evidence-backed live Telegram send.

- [ ] **Step 1: Run the full automated suite**

Run:

```powershell
venv\Scripts\python.exe -m pytest tests/core tests/data tests/sidecar tests/cli -q
cd desktop
npm.cmd test
npm.cmd run build
cd ..
node browser-extension/shared.test.js
```

Expected: all commands exit `0`.

- [ ] **Step 2: Package the Windows app**

Run the existing Windows packaging command into `desktop/release-next`, preserving the isolated acceptance data directory with Unicode and spaces.

- [ ] **Step 3: Launch the actual packaged executable**

Launch `desktop/release-next/win-unpacked/Downany.exe` with the isolated data directory. Verify the existing Bot/target configuration or let the user bind it again if DPAPI requires it.

- [ ] **Step 4: Send the real 148.83 MB video**

Download or reuse the already downloaded local source through the normal app flow. Verify Telegram receives every numbered part as an actual playable upload, no part exceeds the cloud limit, the source link is not used as a substitute, and the original local file remains byte-identical.

- [ ] **Step 5: Record evidence and hand off**

Report exact automated test counts, package path, segment sizes/message count, cleanup result, and any remaining macOS-only acceptance work. Do not claim completion without the live Telegram result.
