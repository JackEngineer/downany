# Downany v0.3.0 Windows候选与正式发布收口 Implementation Plan

> **For Codex:** Use `superpowers:executing-plans` for local implementation and `publishing-downany-releases` for every release, resume, repair, or verification step. Use `superpowers:verification-before-completion` before any candidate/public completion claim.

**Goal:** 从已经集成的升级合同与产品一致性基线产生桌面端/Sidecar `0.3.0`、Chrome 扩展 `0.8.3`，用同一个 annotated tag 和 tag CI 生成 NSIS、扩展 ZIP，完成 Windows 可见核心旅程、草稿资产全量下载验真和公开匿名下载验证。

**Architecture:** 本地代码建立版本、资产和来源 SHA 合同。tag CI 在同一源码上构建 Windows NSIS 与扩展 ZIP，由独立 release-set job 汇总两件精确资产和 manifest；该交付 job 不依赖 Mac job，现有 Mac job 保留。只从通过验证的 tag CI 集合创建草稿，重新完整下载并核对大小、SHA256 和包内版本，再经单独授权公开。

**Tech Stack:** Python 3.11、pytest、Node.js 20、TypeScript/Vitest、Electron Builder、PowerShell、Bash、GitHub Actions、GitHub CLI、GitHub Releases、SHA-256。

**Spec:** `docs/superpowers/specs/2026-08-26-downany-v0-3-staged-upgrade-design.md` 第 4.5、5.4、6 节；执行时还必须重读当前 `docs/RELEASE.md`、`.github/workflows/ci.yml`、`desktop/electron-builder.yml` 和 `publishing-downany-releases` skill。

## Global Constraints

- **用户范围调整（2026-08-27）：** 先读 `docs/superpowers/specs/2026-08-27-downany-windows-execution-scope.md`。本任务只交付 Windows NSIS 与扩展 ZIP，不构建或等待 Mac；同源、草稿验真和公开授权要求不变。现有 Mac 代码、CI 和资产保留。

- 从升级迁移与产品一致性均已获授权集成后的最新 `main` 创建 `chore/v0-3-release-convergence`；发布分支不顺手修下载、迁移或 UI 缺陷。
- 应用版本固定为 `0.3.0`；当前扩展基线为 `0.8.2`，本轮公开文案/安装路径有变化，因此扩展补丁版本固定为 `0.8.3`。
- 正式资产名精确为 `Downany-0.3.0-win-x64.exe`、`Downany-chrome-extension-0.8.3.zip`。
- 两件资产必须来自 annotated tag `v0.3.0` 触发的同一 CI source SHA；本地 Windows 包、分支 CI 包或不同工作流运行只能用于候选，不得混入正式 Release。
- 正式基线默认 cloud-only Telegram 包模式。没有 `DOWNANY_TELEGRAM_API_ID/HASH` 时不伪造本地 Bot API 资源，不宣称本地 2 GB 能力；云端发送限制在 Release Notes 中如实说明。
- 没有有效 Windows 代码签名证书时，`distribution.signed=false`，如实说明 SmartScreen/Defender 和手动更新，不开启或承诺自动替换更新。
- 真实 URL 在执行时属于易变外部事实：先验证当前可用性，再运行候选；失效样本可替换为同类别公开样本，并在矩阵记录日期、替换理由和预期，不降低覆盖类别。
- 自动化、构建、可见运行、公开交付四层证据不可互相替代。尤其 tag CI 成功不等于 Windows 真实安装成功。
- 远程动作需要精确授权。第一授权点可一次列明：集成/推送 main、创建并推送 annotated tag、等待 tag CI、创建草稿和上传两资产。第二授权点只用于把已验真的草稿公开。
- 任何 remote mutation 返回不确定结果时先 GET 当前 branch/tag/workflow/Release/asset 状态，再决定；不得盲目重复 push、tag、draft create、upload 或 publish。
- 正式公开后若验证失败，冻结同一 source SHA 和已下载资产，按同版本修复/恢复流程处理；未经新授权不得重打 tag、替换 Release、重新构建或删资产。

## 任务 1：建立版本、资产与 release manifest 的可执行合同

**文件**

- 新建：`tests/release/__init__.py`
- 新建：`tests/release/test_release_contract.py`
- 新建：`scripts/release_contract.py`
- 新建：`scripts/package_browser_extension.mjs`
- 新建：`scripts/package_browser_extension.test.mjs`
- 修改：`docs/RELEASE.md`

**Interfaces:** consumes source version files, a target tag/source SHA, and exactly two artifact paths; produces `check-source`, deterministic extension packaging, `build-manifest`, and `verify-manifest` commands with exact names, sizes, SHA256, package mode, signing state, and source provenance.

- [ ] **Step 1: 写 source/version 合同失败测试**

`scripts/release_contract.py check-source` 必须验证：

- `desktop/package.json.version == 0.3.0`。
- `desktop/package-lock.json` 顶层和根 package version 均为 `0.3.0`。
- `src/sidecar/protocol.py APP_VERSION == 0.3.0`。
- `browser-extension/manifest.json.version == 0.8.3`。
- `docs/product-facts.json` 仍为 unsigned/manual/两资产。
- tag 精确为 `v0.3.0`，source SHA 为 40 位小写 hex。

测试先以当前版本运行并期望非零：

```powershell
python scripts/release_contract.py check-source --app-version 0.3.0 --extension-version 0.8.3 --tag v0.3.0 --source-sha 0000000000000000000000000000000000000000
```

- [ ] **Step 2: 写扩展 ZIP 的确定性失败测试**

打包器只包含 `browser-extension/` 的运行时文件，拒绝测试、隐藏文件、`__MACOSX`、`.DS_Store`、源码目录外符号链接和绝对路径；ZIP member 使用 `/`、固定排序和固定时间戳。测试两次打包同一 fixture，SHA256 必须相同。

正式命令：

```powershell
node scripts/package_browser_extension.mjs --source browser-extension --output desktop/release/Downany-chrome-extension-0.8.3.zip --expected-version 0.8.3
```

- [ ] **Step 3: 实现 manifest 合同**

`build-manifest` 只接受两个精确 basename，普通文件且非符号链接。单元测试用两个内容均为 `b"a"` 的一字节资产固定以下完整 manifest：

```json
{
  "schemaVersion": 1,
  "tag": "v0.3.0",
  "sourceSha": "0123456789abcdef0123456789abcdef01234567",
  "appVersion": "0.3.0",
  "extensionVersion": "0.8.3",
  "packageMode": "cloud-only",
  "signed": false,
  "assets": [
    { "name": "Downany-0.3.0-win-x64.exe", "size": 1, "sha256": "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb" },
    { "name": "Downany-chrome-extension-0.8.3.zip", "size": 1, "sha256": "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb" }
  ]
}
```

正式 size/hash 从文件计算，不能沿用单元测试的一字节值。`verify-manifest` 重算每个文件并拒绝缺失、额外同名、0 字节、大小/hash 不符、重复资产或 source/tag/version 不一致。

- [ ] **Step 4: 运行 RED/GREEN**

```powershell
python -m pytest tests/release/test_release_contract.py -q
node --test scripts/package_browser_extension.test.mjs
```

- [ ] **Step 5: 把严格流程写入 Release 文档**

替换当前“直接 `gh release create` 即公开”的旧步骤，写成：版本合同 → annotated tag → tag CI → 下载 release set → 本地 manifest 验证 → 创建草稿 → 记录 numeric release/asset IDs → 重新完整下载草稿资产并校验 → 单独授权公开 → 匿名 API/直链完整下载/`latest` 验证。保留签名、SmartScreen、Gatekeeper、Telegram 包模式边界。

- [ ] **Step 6: 本地提交检查点（仅在已授权时）**

```powershell
git add tests/release scripts/release_contract.py scripts/package_browser_extension.mjs scripts/package_browser_extension.test.mjs docs/RELEASE.md
git commit -m "build(release): enforce windows-asset provenance"
```

## 任务 2：升版到桌面/Sidecar 0.3.0 与扩展 0.8.3

**文件**

- 修改：`desktop/package.json`
- 修改：`desktop/package-lock.json`
- 修改：`src/sidecar/protocol.py`
- 修改：`tests/sidecar/test_protocol.py`
- 修改：`desktop/electron/sidecar.test.ts`
- 修改：`browser-extension/manifest.json`
- 修改：`browser-extension/README.md`
- 新建：`docs/RELEASE-NOTES-0.3.0.md`
- 修改：`docs/product-facts.json`
- 修改：`docs/roadmap.md`

**Interfaces:** consumes the fully green pre-release baseline and approved capability facts; produces synchronized app/Sidecar `0.3.0`, extension `0.8.3`, protocol/package tests, truthful release notes, and no behavioral feature change.

- [ ] **Step 1: 先把版本期望改为目标值并确认 RED**

```powershell
python -m pytest tests/sidecar/test_protocol.py tests/release/test_release_contract.py -q

Push-Location desktop
npm.cmd test -- electron/sidecar.test.ts
Pop-Location
```

预期仍是旧版本而失败。

- [ ] **Step 2: 使用包管理器更新桌面版本**

```powershell
Push-Location desktop
npm.cmd version 0.3.0 --no-git-tag-version
Pop-Location
```

修改 `APP_VERSION` 和扩展 manifest 为精确目标值；不要手工改 `node_modules` 或生成 tag。

- [ ] **Step 3: 编写用户语言 Release Notes**

`docs/RELEASE-NOTES-0.3.0.md` 包含：

- 新用户结果：安装、首次下载、网页识别、播放列表、失败恢复、诊断。
- 旧用户结果：从 v0.2.1/最近 v0.2.x 升级保留的设置、队列、历史与 Telegram 状态。
- 队列稳定、成品正确、Windows范围。
- 两资产名称和扩展版本。
- 未签名/手动更新/云端 Telegram 包模式及大文件限制。
- 当前已知限制与不包含事项。

不写内部任务编号、实现链路、无法证明的成功率或公开站点支持清单。

- [ ] **Step 4: 确认版本 GREEN**

```powershell
$downanySourceSha = git rev-parse HEAD
python scripts/release_contract.py check-source --app-version 0.3.0 --extension-version 0.8.3 --tag v0.3.0 --source-sha $downanySourceSha
python -m pytest tests/sidecar/test_protocol.py tests/release/test_release_contract.py -q

Push-Location desktop
npm.cmd test -- electron/sidecar.test.ts
Pop-Location
```

## 任务 3：让 tag CI 汇总同源两资产 release set

**文件**

- 修改：`.github/workflows/ci.yml`
- 修改：`scripts/package_smoke_helpers.test.mjs`
- 修改：`tests/release/test_release_contract.py`

**Interfaces:** consumes annotated tag `v0.3.0` and one checkout SHA; produces a tested Windows NSIS and deterministic extension ZIP, then one `downany-release-set-${{ github.sha }}` artifact containing the exact two files and verified `release-manifest.json`.

- [ ] **Step 1: 添加本地可测的 workflow 静态合同**

测试读取 `.github/workflows/ci.yml` 并断言：tag 构建获取完整 tag 历史，检查 annotated tag/source SHA；扩展调用唯一打包器；Windows upload 只包含精确 EXE；release-set 仅依赖独立 Windows package job 和扩展 job，不依赖 Mac job；最终执行 `verify-manifest`。保留原有 Mac workflow，不添加自动公开 Release 的命令。

- [ ] **Step 2: 在 tag job 验证 annotated tag 与 SHA**

tag 路径使用 `actions/checkout` 的 `fetch-depth: 0`。Unix 检查逻辑：

```bash
test "$(git cat-file -t "refs/tags/$GITHUB_REF_NAME")" = tag
tagged_sha="$(git rev-list -n 1 "$GITHUB_REF_NAME")"
test "$tagged_sha" = "$GITHUB_SHA"
python scripts/release_contract.py check-source \
  --app-version 0.3.0 \
  --extension-version 0.8.3 \
  --tag "$GITHUB_REF_NAME" \
  --source-sha "$tagged_sha"
```

Windows 使用等价 PowerShell，不通过字符串拼接执行不可信 tag 命令。

- [ ] **Step 3: 只上传正式候选文件**

Windows artifact path 只含 `desktop/release/Downany-0.3.0-win-x64.exe`。扩展 job 测试后生成并上传 `desktop/release/Downany-chrome-extension-0.8.3.zip`；unpacked 目录只用于 job 内 smoke，不进入 release set。已有 Mac job 和资产命名不作删除或修改，不进入本任务的集合。

- [ ] **Step 4: 新增 release-set 汇总 job**

tag-only Linux job 下载两个 job artifacts 到隔离目录，要求每个精确文件仅出现一次，运行：

```bash
python scripts/release_contract.py build-manifest \
  --tag v0.3.0 \
  --source-sha "$GITHUB_SHA" \
  --app-version 0.3.0 \
  --extension-version 0.8.3 \
  --package-mode cloud-only \
  --unsigned \
  --asset-dir release-set \
  --output release-set/release-manifest.json
python scripts/release_contract.py verify-manifest \
  --manifest release-set/release-manifest.json \
  --asset-dir release-set
```

上传 artifact 名 `downany-release-set-${{ github.sha }}`，内容只有两资产和 manifest。

- [ ] **Step 5: 本地静态和单元验证**

```powershell
python -m pytest tests/release/test_release_contract.py -q
node --test scripts/package_browser_extension.test.mjs scripts/package_smoke_helpers.test.mjs scripts/test_packaged_media_tools.test.mjs
git diff --check
```

实际 workflow 是否能跨 runner 通过只能由明确授权后的 tag CI 证明；本地测试不能伪装为该证据。

## 任务 4：合并 v0.2.2–v0.2.5 回归入口并运行固定真实 URL 矩阵

**文件**

- 新建：`docs/acceptance/v0.3-regression-matrix.md`
- 新建：`scripts/run_v03_regression.ps1`
- 新建：`tests/release/test_v03_regression_script.py`
- 修改：`docs/REGRESSION-2026-08.md`

**Interfaces:** consumes accepted automated/visible cases from v0.2.2–v0.2.5 and execution-time verified public samples; produces one ordered local regression entry point and a matrix that distinguishes deterministic local fixtures, live public successes, expected failures, recovery actions, and platform-visible evidence.

- [ ] **Step 1: 盘点并去重入口**

把已有证据映射到用户旅程：安装入口/首次使用、失败分类/恢复动作、单条/播放列表成品、长队列/恢复、诊断/隐私、升级、Telegram 独立结果。删除的只能是重复 shell wrapper 或已失效文档入口；底层 pytest/Vitest 合同测试保留并由统一脚本调用。

- [ ] **Step 2: 写统一脚本的失败测试**

`scripts/run_v03_regression.ps1` 使用 `$PSScriptRoot` 解析仓库，不依赖调用目录；支持：

```text
-AutomatedOnly
-IncludeWebsite
-IncludePackaged -SidecarExecutable D:\candidate\DownanySidecar.exe
```

失败即停止并保留退出码；不自动安装、不打开 UI、不访问真实账号、不 push/tag/release。脚本设置/恢复 `NODE_OPTIONS=--no-experimental-webstorage`，不覆盖通用 `$HOME` 等变量。

- [ ] **Step 3: 固定实时样本类别**

执行时先核验并记录：

- 一个公开直链媒体成功样本（优先沿用已验收的 MDN CC0 MP4）。
- 一个公开 Bilibili 合集/多项样本（优先沿用 v0.2.4 已验收合集，失效则换同类别公开样本）。
- 一个无需账号的普通页面下载成功样本。
- v0.2.3 已验收的登录需要、临时网络、已删除/不可用、下载工具过期等失败类别；不能稳定安全触发的类别用协议/本地 fixture 证明，不伪造“真实通过”。
- 本地确定性 HLS、字幕、封面、章节、重名、非法路径和恢复场景。

实时样本不得包含私人、付费、DRM、账号专属或已要求不公开描述的站点。每个失败类别记录 UI 原因和可执行动作，不记录原始响应。

- [ ] **Step 4: 运行自动化入口**

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\run_v03_regression.ps1 -AutomatedOnly -IncludeWebsite
```

- [ ] **Step 5: 运行候选真实旅程并记录**

使用隔离数据/输出目录和候选应用可见执行，记录日期、候选 SHA、URL 类别、成功/预期失败、错误码、用户动作、输出 ffprobe/播放器结果。实时 URL 失效本身不是产品失败；替换后仍无法完成类别才是阻断。

## 任务 5：构建并验证本地两资产候选

**文件**

- 新建：`docs/acceptance/v0.3-release-candidate.md`
- 修改：`docs/RELEASE.md`

**Interfaces:** consumes one reviewed local source SHA with green regression; produces a Windows unsigned candidate, deterministic extension ZIP, package smoke evidence, and a non-formal local manifest; formal publication still requires tag-CI provenance.

- [ ] **Step 1: Windows x64 构建与包内 smoke**

```powershell
$env:ALLOW_CLOUD_ONLY_PACKAGE = "1"
$env:BUILD_TELEGRAM_NATIVE = "0"
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\build_windows_nsis.ps1
```

验证精确 EXE 名、签名状态、安装包大小/SHA256、unpacked Electron、Sidecar hello 0.3.0、ffmpeg/ffprobe、诊断、两个升级夹具。真实安装在任务 6，构建成功不等于安装通过。

- **Step 2: macOS 构建（本任务不执行）**

用户已排除 Mac 工作。无需提供 DMG 或 Mac 主机，不能把此项当作 Windows 候选的前置条件；不删除现有 Mac 构建脚本。

- [ ] **Step 3: 构建扩展 ZIP**

```powershell
node scripts/package_browser_extension.mjs --source browser-extension --output desktop/release/Downany-chrome-extension-0.8.3.zip --expected-version 0.8.3
```

解压到临时目录，运行 manifest JSON/成员清单检查并在 Chrome 开发者模式加载。不要提交 ZIP 或解压目录。

- [ ] **Step 4: 生成本地候选 manifest**

在两个本地候选已经收齐时运行 `build-manifest`，source SHA 取当前 `git rev-parse HEAD`。文档明确标注 `provenance: local-candidate`；正式 Release 后续必须用 tag CI 重新生成的 manifest，不能上传这一组本地资产。

- [ ] **Step 5: 记录准确边界**

`docs/acceptance/v0.3-release-candidate.md` 记录命令、OS/arch、包模式、签名状态、版本、文件名、大小、SHA256、包内 smoke 和未执行项，不记录资源缓存、本机用户名或凭据。

## 任务 6：完成 Windows 安装、升级和核心链路可见验收

**文件**

- 修改：`docs/acceptance/v0.3-release-candidate.md`
- 修改：`docs/acceptance/v0.3-upgrade-migration.md`
- 修改：`docs/acceptance/v0.3-product-consistency.md`

**Interfaces:** consumes the local Windows candidate and accepted matrices from the first two plans; produces visible Windows fresh-install and in-place-upgrade evidence, extension bridge and real output checks.

- [ ] **Step 1: Windows 可见旅程（动作时需确认）**

- 干净用户 fresh install，处理 SmartScreen，启动、Sidecar 连接、公开链接、完成文件打开、诊断、更新检查、退出/重启、卸载。
- 执行 `v0.2.1 → v0.3.0` 和 `v0.2.5 → v0.3.0` 两条升级矩阵。
- Chrome 扩展在客户端在线、离线唤起成功、未安装三态下正确行动。
- 验证至少一个失败恢复、一个播放列表选择/分组、一个长队列恢复和 Telegram 下载/发送结果独立。

安装/卸载/SmartScreen/外部 Chrome 交互按动作时确认执行；未确认时保留 pending，不反复询问。

- **Step 2: macOS 可见旅程（本任务不执行）**

不执行或等待 Mac 实机验收，也不宣称 Mac 通过。Windows 可见旅程要求保持不变。

- [ ] **Step 3: 阻断判定**

以下任一出现即不能进入远程发布：无法安装/启动、Sidecar 不握手、旧资料丢失、完成文件改变、关键路径无可执行恢复、播放列表成品不可用、队列重复/丢失、诊断泄密、扩展无法到达真实安装入口、Windows 没有可见证据。

- [ ] **Step 4: 重跑自动化并冻结候选 SHA**

可见验收后重新运行 `run_v03_regression.ps1 -AutomatedOnly -IncludeWebsite`，`git diff --check`，记录最终候选 SHA。若可见验收促成修复，必须重建并重验受影响平台，旧证据不得沿用。

## 任务 7：第一远程授权点——集成、annotated tag、tag CI 和草稿验真

**文件**

- 新建：`docs/acceptance/v0.3-public-release.md`

**Interfaces:** consumes a clean, fully evidenced local candidate and one explicit bundled authorization; produces an exact main/tag SHA, successful tag CI release set, a draft GitHub Release with two assets, numeric release/asset IDs, and authenticated full-download hash verification while leaving the Release non-public.

- [ ] **Step 1: 零变更远程预检**

重读当前 `AGENTS.md`、`docs/RELEASE.md`、workflow、release notes 和 publishing skill。执行只读检查：

```powershell
git status --short --branch
git log -1 --oneline
git remote -v
git ls-remote --heads origin main
git ls-remote --tags origin refs/tags/v0.3.0 refs/tags/v0.3.0^{}
gh auth status
gh release view v0.3.0 --json id,isDraft,isPrerelease,tagName,assets 2>$null
```

若 tag/Release 已存在，停止创建路径，先按实际状态进入恢复审计。

- [ ] **Step 2: 请求一次精确的第一阶段授权**

只在所有本地门槛通过时，向用户列出：候选分支/完整 SHA、将执行的 merge/commit（如需要）、push main、创建并 push annotated `v0.3.0`、由 tag 触发 CI、从该 run 下载 release set、创建 draft Release 并上传精确两资产。没有清晰批准则停在本地候选，不反复追问。

- [ ] **Step 3: 按授权集成并验证远程 main**

执行完成后用只读命令确认 `origin/main` 精确等于目标 SHA；push 响应不确定时先 `git ls-remote`，不立即重推。

- [ ] **Step 4: 创建并推送 annotated tag**

```powershell
git tag -a v0.3.0 -m "Downany 0.3.0"
git cat-file -t v0.3.0
git rev-list -n 1 v0.3.0
git push origin v0.3.0
```

类型必须为 `tag`，peeled SHA 必须等于远程 main 目标 SHA。push 不确定时先 `git ls-remote --tags`。

- [ ] **Step 5: 等待并验证 tag CI**

定位精确 tag run，等待 Windows 交付依赖项结束。验证 run event/ref/head SHA，把精确 SHA 赋给 `$downanySourceSha`，下载 `downany-release-set-$downanySourceSha` 并运行 `verify-manifest`。Windows package、扩展或 manifest 失败均停止，不用本地资产补洞；Mac job 不作为本任务成功条件，也不冒充已验证。

- [ ] **Step 6: 创建 draft Release 并记录 numeric IDs**

从 tag CI release set 执行：

```powershell
gh release create v0.3.0 `
  .\release-set\Downany-0.3.0-win-x64.exe `
  .\release-set\Downany-chrome-extension-0.8.3.zip `
  --draft `
  --verify-tag `
  --title "Downany 0.3.0" `
  --notes-file docs/RELEASE-NOTES-0.3.0.md
```

创建响应不确定时先 `gh api repos/JackEngineer/downany/releases/tags/v0.3.0`；确认不存在才可重试。读取 Release JSON，记录 numeric release ID、每个 asset ID/name/size/state/digest（若 API 提供）。

- [ ] **Step 7: 从草稿重新完整下载并验真**

下载到新的空临时目录，不复用上传源：

```powershell
gh release download v0.3.0 --dir .\draft-redownload
python scripts/release_contract.py verify-manifest --manifest .\release-set\release-manifest.json --asset-dir .\draft-redownload
```

同时检查 NSIS/ZIP 包内版本、extension manifest、文件可读性。草稿必须保持 `isDraft=true`、`isPrerelease=false`。将结果写入 `docs/acceptance/v0.3-public-release.md`。

## 任务 8：第二远程授权点——公开并做匿名完整下载验证

**文件**

- 修改：`docs/acceptance/v0.3-public-release.md`
- 修改：`docs/REGRESSION-2026-08.md`
- 修改：`docs/roadmap.md`

**Interfaces:** consumes one fully verified draft and one explicit publish authorization; produces a public non-draft/non-prerelease Release, anonymous API/latest confirmation, two full public downloads matching the tag-CI manifest, and truthful final documentation.

- [ ] **Step 1: 向用户提供草稿证据并请求公开授权**

一次性给出 tag/source SHA、CI run、两资产名称/大小/SHA256、numeric IDs、草稿重下载结果、Windows 可见验收与签名/包模式边界。明确唯一待执行 mutation 是把 draft 设为 public；未批准不重复追问，Release 保持草稿。

- [ ] **Step 2: 公开 Release**

```powershell
gh release edit v0.3.0 --draft=false --prerelease=false
```

响应不确定时立刻 GET Release 状态，不重复 edit。

- [ ] **Step 3: 匿名 API 与 latest 验证**

使用不带 GitHub token 的 `curl.exe` 读取：

```powershell
curl.exe -fsSL https://api.github.com/repos/JackEngineer/downany/releases/tags/v0.3.0
curl.exe -fsSL https://api.github.com/repos/JackEngineer/downany/releases/latest
```

两者都必须是 `tag_name=v0.3.0`、`draft=false`、`prerelease=false`；assets 精确两件，name/size 与 manifest 相同。

- [ ] **Step 4: 匿名直链完整下载与 SHA256**

从 API 的两个 `browser_download_url` 下载到新的空目录，禁止发送 `Authorization` header。每个下载必须完整结束、HTTP 成功、文件 size 和 SHA256 与 tag CI manifest 相同；不要用 HEAD、Range 小片段或 API 元数据代替全文件。

- [ ] **Step 5: 最终公开状态核对**

- `releases/latest` 页面指向 v0.3.0。
- tag peeled SHA、origin/main SHA、CI head SHA、manifest source SHA 四者相同。
- Release 页面可见两资产和 Release Notes。
- 应用内更新检查从旧版发现 v0.3.0，并打开正确 Release 页面；未签名模式不声称自动安装。
- 官网仓库构建仍正确解析资产；若官网未部署，只记录“本地官网构建通过”，不擅自部署。

- [ ] **Step 6: 公开后失败的冻结规则**

任一验证失败时记录准确失败，不删除/替换资产、不移动 tag、不重新跑 publisher。先判断 API 缓存、下载中断还是资产不一致；任何修复 mutation 需要新的明确授权。

## 任务 9：最终证据审查与 v0.3.0 完成判定

**文件**

- 修改：`docs/acceptance/v0.3-public-release.md`
- 修改：`docs/superpowers/plans/2026-08-27-downany-v0-3-convergence-index.md`

**Interfaces:** consumes all source, package, visible, draft, and public evidence; produces the final v0.3.0 completion record only if every gate is current and exact, otherwise an accurately labeled local/draft/public-recovery state.

- [ ] **Step 1: 运行 completion verification**

重新执行可安全重复的本地测试、manifest 验证、只读 GitHub API/remote SHA 检查和匿名下载 hash。不要把早期日志当成当前状态。

- [ ] **Step 2: 审查文档与工作树**

```powershell
git status --short --branch
git diff --check
rg -n "TODO|TBD|待补|占位|上线后|开发联调" docs/RELEASE-NOTES-0.3.0.md docs/acceptance/v0.3-*.md README.md docs/roadmap.md browser-extension/README.md website/src/content/siteContent.ts
```

验收文档可用“待执行”描述真实未完成项，但正式 Release Notes 和公共载体不得有占位。Release 产物、下载文件、manifest 临时副本和凭据不得进入 Git。

- [ ] **Step 3: 完成判定**

只有以下全部成立才把 index 标为完成：

- 全自动化与生产构建通过。
- Windows fresh install、旧版升级和核心可见旅程通过。
- 固定实时/本地回归无阻断，预期失败动作正确。
- annotated tag 与 main/CI/manifest SHA 一致。
- 公共 Release 非 draft/non-prerelease，两个匿名完整下载 SHA 匹配。
- 未签名、cloud-only Telegram 和手动更新边界在 UI/docs/Release Notes 一致。

否则用最窄准确状态：`local candidate`、`tag CI failed`、`verified draft awaiting publish approval` 或 `public release recovery required`。
