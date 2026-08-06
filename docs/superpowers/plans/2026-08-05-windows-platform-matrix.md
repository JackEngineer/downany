# Windows 平台矩阵同发 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使 Downany 在 macOS 与 Windows 上同版本、同功能发布（Windows 产出未签名 NSIS），满足规格 `docs/superpowers/specs/2026-08-05-windows-platform-matrix-design.md`。

**Architecture:** 共用 `src/core` / Sidecar 协议 / Renderer；平台差异收敛到 `AppPaths`、`bin_paths`、Electron `paths.ts` / `sidecar.ts` 杀进程、窗框/Tray 分支、以及 Win 打包脚本。Windows 数据目录为 `%LOCALAPPDATA%\Downany`，日志为 `…\logs`。

**Tech Stack:** Electron 33、electron-builder (NSIS)、Python 3.11、PyInstaller onedir、pytest、vitest、GitHub Actions `windows-latest`。

**Spec:** `docs/superpowers/specs/2026-08-05-windows-platform-matrix-design.md`

**执行建议:** 每个 Phase 单独 PR（`feat/m0-windows-foundation` → `feat/m0-windows-packaging` → `feat/m0-windows-shell` → `chore/windows-release-gate`）。本文件按顺序实施；未完成 Phase N 不得宣称同发就绪。

---

## File map

| 文件 | 职责 |
|---|---|
| `src/sidecar/paths.py` | 平台默认数据/日志目录 |
| `src/sidecar/bin_paths.py` | `ffmpeg` / `yt-dlp` 候选名（含 `.exe`） |
| `src/sidecar/ytdlp_updater.py` | 按 OS 选 release asset 与落盘名 |
| `src/sidecar/migration.py` | 非 macOS 跳过 Trae/VD 迁移 |
| `src/core/local_thumbnail.py` | `default_data_dir` 委托 `AppPaths` |
| `src/data/database.py` | 默认 db 路径委托 `AppPaths` |
| `src/core/ytdlp_opts.py` | deno 查找含 `deno.exe` |
| `src/core/download_manager.py` | 后处理脚本 Windows 安全 quoting |
| `desktop/electron/paths.ts` | venv/`Scripts`、sidecar `.exe` |
| `desktop/electron/sidecar.ts` | Win 进程树 `taskkill /T` |
| `desktop/electron/main.ts` | 数据目录、日志 IPC、窗框、Tray |
| `desktop/electron/settingsWindow.ts` | Win 窗框 |
| `desktop/electron/tray.ts` | 取消 `setTemplateImage` 仅 mac 语义；Win 可用 |
| `desktop/renderer/SettingsApp.tsx` | Win 隐藏 Safari cookie 选项 |
| `desktop/electron-builder.yml` | `win.nsis` |
| `scripts/fetch_release_binaries.sh` + `.ps1` 或平台分支 | 拉 Win ffmpeg/yt-dlp |
| `scripts/build_windows_nsis.sh` 或 `.ps1` | Win 打包编排 |
| `.github/workflows/ci.yml` | `windows-latest` 矩阵 |
| `docs/RELEASE.md` / `roadmap.md` / `AGENTS.md` / `README.md` | 双平台文档 |

---

## Phase 1 — 地基（可开发态运行 + CI）

### Task 1: AppPaths Windows 默认目录

**Files:**
- Modify: `src/sidecar/paths.py`
- Modify: `tests/sidecar/test_paths.py`

- [ ] **Step 1: 写失败测试**

在 `tests/sidecar/test_paths.py` 追加：

```python
import sys


def test_default_paths_on_windows(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "LocalAppData"))
    monkeypatch.delenv("DOWNANY_DATA_DIR", raising=False)
    monkeypatch.delenv("VIDEODL_DATA_DIR", raising=False)
    paths = AppPaths.default()
    assert paths.data_dir == (tmp_path / "LocalAppData" / "Downany").resolve()
    assert paths.log_dir == (tmp_path / "LocalAppData" / "Downany" / "logs").resolve()


def test_default_paths_on_darwin(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("DOWNANY_DATA_DIR", raising=False)
    monkeypatch.delenv("VIDEODL_DATA_DIR", raising=False)
    paths = AppPaths.default()
    assert paths.data_dir == tmp_path / "Library" / "Application Support" / "Downany"
    assert paths.log_dir == tmp_path / "Library" / "Logs" / "Downany"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pytest tests/sidecar/test_paths.py::test_default_paths_on_windows -v`  
Expected: FAIL（当前始终拼 `Library/...`）

- [ ] **Step 3: 实现**

改写 `AppPaths.default()` 无 env 覆盖分支：

```python
home = Path.home()
if sys.platform == "win32":
    local = (os.environ.get("LOCALAPPDATA") or "").strip()
    base = Path(local) if local else home / "AppData" / "Local"
    data_dir = base / "Downany"
    log_dir = data_dir / "logs"
else:
    data_dir = home / "Library" / "Application Support" / "Downany"
    log_dir = home / "Library" / "Logs" / "Downany"
return cls(data_dir=data_dir, log_dir=log_dir)
```

保留现有 env override：override 时 `log_dir = data_dir / "logs"`（已符合规格）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pytest tests/sidecar/test_paths.py -v`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sidecar/paths.py tests/sidecar/test_paths.py
git commit -m "$(cat <<'EOF'
feat: use LocalAppData for Windows AppPaths defaults

EOF
)"
```

---

### Task 2: 委托 database / local_thumbnail 到 AppPaths

**Files:**
- Modify: `src/data/database.py`
- Modify: `src/core/local_thumbnail.py`
- Create: `tests/core/test_local_thumbnail_paths.py`（若尚无）

- [ ] **Step 1: 写失败测试**

```python
# tests/core/test_local_thumbnail_paths.py
import sys
from pathlib import Path

from src.core.local_thumbnail import default_data_dir


def test_default_data_dir_windows(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "LA"))
    monkeypatch.delenv("DOWNANY_DATA_DIR", raising=False)
    monkeypatch.delenv("VIDEODL_DATA_DIR", raising=False)
    assert default_data_dir() == (tmp_path / "LA" / "Downany").resolve()
```

- [ ] **Step 2: 跑测确认失败**

Run: `pytest tests/core/test_local_thumbnail_paths.py -v`  
Expected: FAIL

- [ ] **Step 3: 实现（顶层 import，禁止 inline）**

`local_thumbnail.py`:

```python
from src.sidecar.paths import AppPaths

def default_data_dir() -> Path:
    return AppPaths.default().data_dir
```

`database.py` 默认分支：

```python
from src.sidecar.paths import AppPaths

# in __init__ when db_path is None:
paths = AppPaths.default()
paths.ensure()
self.db_path = str(paths.history_db_path)
```

注意：若 circular import，可将 `AppPaths` 抽到 `src/data/app_paths.py` 或 `src/sidecar/paths` 保持不依赖 data 层（当前 `paths.py` 无 data 依赖，可直接用）。

- [ ] **Step 4: 全量相关测试**

Run: `pytest tests/core tests/data tests/sidecar/test_paths.py -q`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/data/database.py src/core/local_thumbnail.py tests/core/test_local_thumbnail_paths.py
git commit -m "$(cat <<'EOF'
refactor: route default data dirs through AppPaths

EOF
)"
```

---

### Task 3: bin_paths 解析 `.exe`

**Files:**
- Modify: `src/sidecar/bin_paths.py`
- Modify: `tests/sidecar/test_bin_paths.py`

- [ ] **Step 1: 写失败测试**

```python
def test_resolve_ffmpeg_exe_on_windows(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    ffmpeg = bin_dir / "ffmpeg.exe"
    ffmpeg.write_bytes(b"MZ")
    ffmpeg.chmod(0o755)
    monkeypatch.setenv("DOWNANY_BIN_DIR", str(bin_dir))
    assert resolve_ffmpeg_path() == ffmpeg.resolve()


def test_resolve_bundled_ytdlp_exe(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    ytdlp = bin_dir / "yt-dlp.exe"
    ytdlp.write_bytes(b"MZ")
    ytdlp.chmod(0o755)
    monkeypatch.setenv("DOWNANY_BIN_DIR", str(bin_dir))
    assert resolve_bundled_ytdlp_path() == ytdlp.resolve()
```

- [ ] **Step 2: 跑测确认失败**

Run: `pytest tests/sidecar/test_bin_paths.py::test_resolve_ffmpeg_exe_on_windows -v`  
Expected: FAIL

- [ ] **Step 3: 实现**

在 `bin_paths.py` 增加：

```python
def _candidate_names(base: str) -> list[str]:
    if sys.platform == "win32":
        return [f"{base}.exe", base]
    return [base, f"{base}.exe"]


def _first_executable(directory: Path, base: str) -> Optional[Path]:
    for name in _candidate_names(base):
        candidate = directory / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    # Windows 上裸写的 .exe 有时 X_OK 怪异：若 is_file 仍接受 .exe
    if sys.platform == "win32":
        exe = directory / f"{base}.exe"
        if exe.is_file():
            return exe
    return None
```

`resolve_ffmpeg_path` / `resolve_bundled_ytdlp_path` 改为经 `_first_executable`。

- [ ] **Step 4: 跑测确认通过**（含既有无后缀用例）

Run: `pytest tests/sidecar/test_bin_paths.py -v`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sidecar/bin_paths.py tests/sidecar/test_bin_paths.py
git commit -m "$(cat <<'EOF'
feat: resolve ffmpeg/yt-dlp with .exe on Windows

EOF
)"
```

---

### Task 4: yt-dlp updater 按平台选 asset

**Files:**
- Modify: `src/sidecar/ytdlp_updater.py`
- Modify: `tests/sidecar/test_ytdlp_updater.py`

- [ ] **Step 1: 写/改失败测试**

将硬编码 `yt-dlp_macos` 的断言改为调用可测函数：

```python
from src.sidecar.ytdlp_updater import release_asset_name, ytdlp_path


def test_release_asset_name_windows(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    assert release_asset_name() == "yt-dlp.exe"


def test_release_asset_name_darwin(monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    assert release_asset_name() == "yt-dlp_macos"


def test_ytdlp_path_windows(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    paths = AppPaths(data_dir=tmp_path, log_dir=tmp_path / "logs")
    assert ytdlp_path(paths).name == "yt-dlp.exe"
```

更新现有 mock release JSON，按被测平台返回匹配 asset。

- [ ] **Step 2: 跑测确认失败**

Run: `pytest tests/sidecar/test_ytdlp_updater.py -v`  
Expected: FAIL（`ASSET_NAME` 常量）

- [ ] **Step 3: 实现**

```python
import sys

def release_asset_name() -> str:
    if sys.platform == "win32":
        return "yt-dlp.exe"
    if sys.platform == "darwin":
        return "yt-dlp_macos"
    return "yt-dlp"  # 预留；本期无 Linux 发版


def ytdlp_path(paths: AppPaths) -> Path:
    name = "yt-dlp.exe" if sys.platform == "win32" else "yt-dlp"
    return ytdlp_bin_dir(paths) / name
```

下载匹配处用 `release_asset_name()` 替代 `ASSET_NAME`。Windows 下载后无需 `chmod` 可执行位时可 `os.chmod` 跳过或 no-op。

- [ ] **Step 4: 跑测通过**

Run: `pytest tests/sidecar/test_ytdlp_updater.py -v`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sidecar/ytdlp_updater.py tests/sidecar/test_ytdlp_updater.py
git commit -m "$(cat <<'EOF'
feat: select yt-dlp release asset by platform

EOF
)"
```

---

### Task 5: Deno 路径与后处理 quoting

**Files:**
- Modify: `src/core/ytdlp_opts.py`
- Modify: `src/core/download_manager.py`
- Modify: `tests/core/test_download_manager.py`（后处理断言）

- [ ] **Step 1: 调整后处理测试期望**

现有断言 `assert "'/tmp/my file.mp4'" in command` 依赖 POSIX `shlex.quote`。改为测试辅助函数：

```python
# 在 download_manager 增加（或独立小函数）
def format_postprocess_command(script: str, file_path: str) -> str:
    if sys.platform == "win32":
        quoted = subprocess.list2cmdline([file_path])
    else:
        quoted = shlex.quote(file_path)
    if "{file}" in script:
        return script.format(file=quoted)
    return f"{script} {quoted}"
```

测试：

```python
def test_format_postprocess_posix(monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    cmd = format_postprocess_command("echo {file}", "/tmp/my file.mp4")
    assert "'/tmp/my file.mp4'" in cmd


def test_format_postprocess_windows(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    cmd = format_postprocess_command("echo {file}", r"C:\Users\a\my file.mp4")
    assert "my file.mp4" in cmd
    assert "'" not in cmd or '"' in cmd  # list2cmdline 用双引号
```

- [ ] **Step 2: `_run_postprocess_script` 改用 `format_postprocess_command`**

- [ ] **Step 3: `ensure_js_runtime_path` 同时检查 `deno` / `deno.exe`**

```python
def _deno_name() -> str:
    return "deno.exe" if sys.platform == "win32" else "deno"

# in loop:
if (Path(directory) / _deno_name()).exists():
```

保留 `~/.deno/bin`；Win 额外可加入 `str(Path.home() / ".deno" / "bin")`（已有）。

- [ ] **Step 4: 跑测**

Run: `pytest tests/core/test_download_manager.py -q`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/download_manager.py src/core/ytdlp_opts.py tests/core/test_download_manager.py
git commit -m "$(cat <<'EOF'
fix: Windows-safe postprocess quoting and deno.exe lookup

EOF
)"
```

---

### Task 6: 迁移在非 macOS 跳过

**Files:**
- Modify: `src/sidecar/migration.py`
- Modify: `tests/sidecar/test_migration.py`

- [ ] **Step 1: 写测试**

```python
def test_run_migration_skips_on_windows(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    paths = AppPaths(data_dir=tmp_path / "data", log_dir=tmp_path / "logs")
    result = run_migration(paths)
    assert result["status"] == "skipped"
    assert "Windows" in result["message"] or "非 macOS" in result["message"]
```

- [ ] **Step 2: 跑测失败 → 实现 → 通过**

在 `run_migration` 开头：

```python
if sys.platform != "darwin":
    return {
        "status": "skipped",
        "message": "非 macOS，跳过旧版迁移",
        "details": {"platform": sys.platform},
    }
```

- [ ] **Step 3: Commit**

```bash
git add src/sidecar/migration.py tests/sidecar/test_migration.py
git commit -m "$(cat <<'EOF'
fix: skip macOS-only migration on Windows

EOF
)"
```

---

### Task 7: Electron paths — python.exe / Sidecar.exe

**Files:**
- Modify: `desktop/electron/paths.ts`
- Modify: `desktop/electron/paths.test.ts`

- [ ] **Step 1: 扩展单测**

```typescript
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bundledSidecarPath, resolveSidecarLaunch } from "./paths";

it("dev launch prefers Scripts/python.exe layout when present", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "downany-"));
  const scripts = path.join(repo, "venv", "Scripts");
  fs.mkdirSync(scripts, { recursive: true });
  const py = path.join(scripts, "python.exe");
  fs.writeFileSync(py, "");
  const launch = resolveSidecarLaunch(__dirname, { repoRoot: repo });
  expect(launch.command).toBe(py);
});

it("bundledSidecarPath finds DownanySidecar.exe", () => {
  // 若难以 mock resourcesRoot，可将「候选列表」抽成纯函数 exeCandidates(base) 单测
});
```

更稳妥：抽出纯函数并单测：

```typescript
export function platformExecutable(baseName: string): string[] {
  if (process.platform === "win32") {
    return [`${baseName}.exe`, baseName];
  }
  return [baseName, `${baseName}.exe`];
}

export function defaultDevPython(repoRoot: string): string {
  const win = path.join(repoRoot, "venv", "Scripts", "python.exe");
  const posix = path.join(repoRoot, "venv", "bin", "python");
  if (process.platform === "win32") {
    if (fs.existsSync(win)) return win;
    return win; // 约定路径，即便尚未创建
  }
  if (fs.existsSync(posix)) return posix;
  return posix;
}
```

`bundledSidecarPath`：对 onedir 根下对每个候选名 `existsSync` 后返回。

- [ ] **Step 2: `npm test` 在 desktop 通过**

Run: `cd desktop && npm test -- paths.test.ts`  
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/electron/paths.ts desktop/electron/paths.test.ts
git commit -m "$(cat <<'EOF'
feat: resolve Windows venv python and sidecar.exe

EOF
)"
```

---

### Task 8: Windows 进程树 taskkill /T

**Files:**
- Modify: `desktop/electron/sidecar.ts`
- Create: `desktop/electron/processTree.ts`（隔离可测）
- Create: `desktop/electron/processTree.test.ts`

- [ ] **Step 1: 抽纯函数 + 测试**

```typescript
// processTree.ts
import { execFileSync } from "node:child_process";

export function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // 进程可能已退出
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore
    }
  }
}
```

```typescript
// processTree.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { killProcessTree } from "./processTree";

it("uses taskkill /T /F on win32", () => {
  killProcessTree(4242, "win32");
  expect(execFileSync).toHaveBeenCalledWith(
    "taskkill",
    ["/pid", "4242", "/T", "/F"],
    expect.objectContaining({ windowsHide: true }),
  );
});
```

- [ ] **Step 2: `SidecarClient.killProcess` 调用 `killProcessTree(pid)`**，去掉仅 `child.kill` 的 Win 分支。

- [ ] **Step 3: `cd desktop && npm test`**

- [ ] **Step 4: Commit**

```bash
git add desktop/electron/processTree.ts desktop/electron/processTree.test.ts desktop/electron/sidecar.ts
git commit -m "$(cat <<'EOF'
fix: kill sidecar process tree with taskkill on Windows

EOF
)"
```

---

### Task 9: Electron 数据/日志目录平台分支

**Files:**
- Modify: `desktop/electron/main.ts`（`resolveDownanyDataDir`，约 L80–88；`sidecar:getLogDir` 约 L713）

- [ ] **Step 1: 抽出与 Python 对齐的路径助手到 `desktop/electron/appDataDir.ts`（便于测）**

```typescript
import * as path from "node:path";
import { app } from "electron";

export function resolveDownanyDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = app.getPath("home"),
): string {
  const override = (env.DOWNANY_DATA_DIR || env.VIDEODL_DATA_DIR || "").trim();
  if (override) return path.resolve(override);
  if (platform === "win32") {
    const local = (env.LOCALAPPDATA || "").trim();
    const base = local || path.join(home, "AppData", "Local");
    return path.join(base, "Downany");
  }
  return path.join(home, "Library", "Application Support", "Downany");
}

export function resolveDownanyLogDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = app.getPath("home"),
): string {
  const data = resolveDownanyDataDir(env, platform, home);
  if ((env.DOWNANY_DATA_DIR || env.VIDEODL_DATA_DIR || "").trim()) {
    return path.join(data, "logs");
  }
  if (platform === "win32") {
    return path.join(data, "logs");
  }
  return path.join(home, "Library", "Logs", "Downany");
}
```

- [ ] **Step 2: 单测覆盖 win32 / darwin / override**

- [ ] **Step 3: `main.ts` 改用上述函数；删除硬编码 `Library/Logs`**

- [ ] **Step 4: Commit**

```bash
git add desktop/electron/appDataDir.ts desktop/electron/appDataDir.test.ts desktop/electron/main.ts
git commit -m "$(cat <<'EOF'
feat: align Electron data/log dirs with Windows LocalAppData

EOF
)"
```

---

### Task 10: CI 增加 windows-latest

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: 将 `python-tests` 与 `desktop` 改为 matrix**

```yaml
python-tests:
  strategy:
    fail-fast: false
    matrix:
      os: [macos-latest, windows-latest]
  runs-on: ${{ matrix.os }}
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-python@v5
      with:
        python-version: "3.11"
    - name: Install dependencies
      run: |
        python -m pip install --upgrade pip
        pip install -r requirements-dev.txt
    - name: Run pytest (mainline)
      run: pytest tests/core tests/data tests/sidecar -q

desktop:
  strategy:
    fail-fast: false
    matrix:
      os: [macos-latest, windows-latest]
  runs-on: ${{ matrix.os }}
  defaults:
    run:
      working-directory: desktop
  # … 同现有 npm ci / build / test
```

`browser-extension` 可仍只跑 macos（纯 JS，省分钟）。

- [ ] **Step 2: 推分支后确认 GitHub Actions 绿（或本地无法跑 CI 时至少 yaml 合法）**

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
ci: run pytest and desktop tests on windows-latest

EOF
)"
```

**Phase 1 完成标志:** 在一台 Windows 开发机上 `venv\Scripts\python.exe -m src.sidecar` 能 hello；`cd desktop && npm run dev` 能连上 Sidecar（手动验收，记录在 PR）。

---

## Phase 2 — 可安装（NSIS）

### Task 11: electron-builder Windows 目标

**Files:**
- Modify: `desktop/electron-builder.yml`
- Modify: `desktop/package.json`
- Add: `desktop/build/icon.ico`（可用现有 `icon.png` 用 `png2icons` 或 electron-icon-builder 生成；提交真实 `.ico`）

- [ ] **Step 1: 在 `electron-builder.yml` 追加**

```yaml
win:
  icon: build/icon.ico
  target:
    - target: nsis
      arch:
        - x64
  artifactName: Downany-${version}-win-${arch}.${ext}
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  shortcutName: Downany
  uninstallDisplayName: Downany · 百纳
```

- [ ] **Step 2: `package.json` scripts**

```json
"dist:win": "electron-builder --win --config electron-builder.yml"
```

- [ ] **Step 3: Commit（含 icon.ico）**

```bash
git add desktop/electron-builder.yml desktop/package.json desktop/build/icon.ico
git commit -m "$(cat <<'EOF'
build: add Windows NSIS target to electron-builder

EOF
)"
```

---

### Task 12: 拉取 Windows 二进制

**Files:**
- Modify: `scripts/fetch_release_binaries.sh`（增加 `OS` 检测或 `TARGET_OS`）
- Create: `scripts/fetch_release_binaries.ps1`（Windows 原生，或文档要求 Git Bash）

约定（写死在脚本注释与 README）：

| 工具 | Windows URL 策略 |
|---|---|
| yt-dlp | `…/releases/download/${VER}/yt-dlp.exe` |
| ffmpeg | 使用 BtbN/gyan 固定版本 zip，解压后只复制 `ffmpeg.exe` 到 `desktop/resources/bin/` |

示例 env：

```bash
TARGET_OS="${TARGET_OS:-$(uname -s)}"
# Darwin -> yt-dlp_macos / ffmpeg (现有)
# MINGW*|MSYS*|Windows_NT|当 TARGET_OS=windows -> yt-dlp.exe + ffmpeg.exe
```

- [ ] **Step 1: 实现分支并在注释中记录选用的 ffmpeg 发布源与校验方式（sha256）**

- [ ] **Step 2: 干跑：脚本把文件放到 `desktop/resources/bin/`**

- [ ] **Step 3: Commit**

```bash
git add scripts/fetch_release_binaries.sh scripts/fetch_release_binaries.ps1
git commit -m "$(cat <<'EOF'
build: fetch Windows ffmpeg and yt-dlp.exe into resources/bin

EOF
)"
```

---

### Task 13: Windows Sidecar 构建说明与编排

**Files:**
- Create: `scripts/build_windows_nsis.ps1`（或 `.sh` 供 CI 的 windows runner）
- Modify: `scripts/build_sidecar.sh`（文档：在 Win 上 PyInstaller 产出 `.exe`；smoke 检查 `.exe`）

编排顺序：

1. `fetch_release_binaries`（TARGET_OS=windows）
2. PyInstaller `packaging/sidecar.spec` → 复制到 `desktop/resources/sidecar/DownanySidecar/`
3. `cd desktop && npm ci && npm run build && npm run dist:win`

- [ ] **Step 1: 写脚本并在 Windows runner 或本地跑通至少一次（人工）**

- [ ] **Step 2: Commit**

```bash
git add scripts/build_windows_nsis.ps1 scripts/build_sidecar.sh
git commit -m "$(cat <<'EOF'
build: add Windows NSIS packaging orchestration script

EOF
)"
```

---

### Task 14: Release workflow 挂 NSIS（可选本 Phase）

若仓库尚无 release workflow，在 `docs/RELEASE.md` 先写入手动步骤；有 workflow 则增加 `windows-latest` job 上传 `Downany-*-win-*.exe`。

- [ ] **Step 1: 更新文档步骤（完整命令）**

- [ ] **Step 2: Commit**

```bash
git add docs/RELEASE.md
git commit -m "$(cat <<'EOF'
docs: document Windows NSIS build and upload steps

EOF
)"
```

**Phase 2 完成标志:** 在干净 Win 机安装 NSIS → 启动 → hello → 下载一条公开视频。

---

## Phase 3 — 壳层体验

### Task 15: 窗口 chrome 平台分支

**Files:**
- Modify: `desktop/electron/main.ts`（BrowserWindow 创建，约 L476）
- Modify: `desktop/electron/settingsWindow.ts`

- [ ] **Step 1: 抽 options**

```typescript
function mainWindowOptions(platform: NodeJS.Platform = process.platform): Electron.BrowserWindowConstructorOptions {
  const common = { /* width/height/webPreferences… */ };
  if (platform === "darwin") {
    return {
      ...common,
      titleBarStyle: "hiddenInset",
      vibrancy: "under-window",
      transparent: true,
    };
  }
  return {
    ...common,
    frame: true,
    transparent: false,
  };
}
```

settings 窗口同理。

- [ ] **Step 2: 目视确认 Win 下标题栏正常（无透明黑洞）**

- [ ] **Step 3: Commit**

```bash
git add desktop/electron/main.ts desktop/electron/settingsWindow.ts
git commit -m "$(cat <<'EOF'
fix: use standard window frame on Windows

EOF
)"
```

---

### Task 16: 启用 Windows Tray + 关闭到托盘

**Files:**
- Modify: `desktop/electron/main.ts`（`syncMenuBarMode` 勿在非 darwin early-return；Win 允许 Tray）
- Modify: `desktop/electron/tray.ts`（`setTemplateImage` 仅 darwin）

```typescript
if (process.platform === "darwin") {
  image.setTemplateImage(true);
}
```

`syncMenuBarMode`：在 `win32` 上也 `tray.enable/disable`；关闭窗口行为与 mac menuBarMode 对齐（`close` → hide）。

设置项文案可仍叫「菜单栏模式」或 Win 改为「关闭时最小化到托盘」——改 `SettingsApp.tsx` 文案分支。

- [ ] **Step 1: 实现 + 手动点验**

- [ ] **Step 2: Commit**

```bash
git add desktop/electron/main.ts desktop/electron/tray.ts desktop/renderer/SettingsApp.tsx
git commit -m "$(cat <<'EOF'
feat: enable system tray minimize-to-tray on Windows

EOF
)"
```

---

### Task 17: Cookie 选项隐藏 Safari（Windows）

**Files:**
- Modify: `desktop/renderer/SettingsApp.tsx`

```tsx
{typeof navigator !== "undefined" && !/Win/.test(navigator.userAgent) && (
  <option value="safari">Safari</option>
)}
```

更好：preload 暴露 `platform`，用 `window.downany.platform === "darwin"`。若已有 IPC，用之；否则加 `platform: process.platform` 到 preload bridge。

- [ ] **Step 1: 实现 + 组件测（可选）**

- [ ] **Step 2: Commit**

```bash
git add desktop/renderer/SettingsApp.tsx desktop/electron/preload.ts
git commit -m "$(cat <<'EOF'
fix: hide Safari cookie source on Windows settings

EOF
)"
```

---

## Phase 4 — 文档闸门与同发

### Task 18: 文档与 roadmap

**Files:**
- Modify: `docs/roadmap.md`（删除「明确不做 Windows」段，改为双平台同发基线）
- Modify: `docs/RELEASE.md`（SmartScreen 步骤、产物矩阵）
- Modify: `AGENTS.md`、`CLAUDE.md`、`README.md`（数据目录、Win 开发命令）

Win 开发命令摘录写入 AGENTS：

```bash
python -m venv venv
.\venv\Scripts\activate
pip install -r requirements-dev.txt
# 将 ffmpeg.exe / yt-dlp.exe 放入 bin\ 或 desktop\resources\bin\
cd desktop && npm install && npm run dev
```

SmartScreen 用户步骤：

1. 双击安装包 →「Windows 已保护你的电脑」
2. 更多信息 → 仍要运行

- [ ] **Step 1: 编辑文档**

- [ ] **Step 2: Commit**

```bash
git add docs/roadmap.md docs/RELEASE.md AGENTS.md CLAUDE.md README.md
git commit -m "$(cat <<'EOF'
docs: declare dual-platform release and Windows install notes

EOF
)"
```

---

### Task 19: 同发验收清单（人工，阻塞合并到「可宣称完成」）

在真实 Windows x64 上勾选规格 §10：

- [ ] NSIS 安装 → hello → 下载公开视频
- [ ] Chrome 或 Edge 扩展入队
- [ ] `downany://` 二次唤起同实例
- [ ] 退出无残留进程（任务管理器）
- [ ] macOS DMG 不回归
- [ ] 同一 Release 挂 DMG + NSIS + 扩展 zip
- [ ] CI windows-latest 绿

全部勾选后打第一个双平台 tag（版本号与 `desktop/package.json` / 扩展 manifest 对齐）。

---

## Spec coverage（自检）

| 规格条目 | Task |
|---|---|
| `%LOCALAPPDATA%\Downany` + logs | 1, 2, 9 |
| `.exe` / updater asset | 3, 4, 12 |
| venv Scripts / Sidecar.exe | 7, 13 |
| taskkill 进程树 | 8 |
| 迁移跳过 | 6 |
| 后处理 quoting / deno | 5 |
| NSIS + 图标 | 11–14 |
| 窗框 / Tray / Safari | 15–17 |
| CI windows-latest | 10 |
| RELEASE / roadmap / AGENTS | 18 |
| 验收清单 | 19 |

无 TBD 占位；Linux 明确不做；签名明确后补。
