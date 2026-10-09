# Downany 0.3.1：Windows x64 验收交接

这份清单供你在 Windows 电脑上执行。目标源码为公开候选提交 **`e3e860b5a0f0344bc9eae7ed53bd038e890ff552`**（标签 `v0.3.1`），桌面版本 **0.3.1**、Chrome 插件 **0.9.2**。仅验证 Windows x64；ARM64 Windows 不在本轮范围。Mac 已完成的验证不能填写为 Windows 通过。五人首次使用者试用已取消，不需要再招募参与者。

## 0. 先明确现状和执行顺序

截至 2026-10-09 的实际查询：

- [v0.3.1 Release](https://github.com/JackEngineer/downany/releases/tag/v0.3.1) 是 **Mac 预发布**，只有 Mac DMG、插件 ZIP 和校验和；**没有 Windows 安装包**。DMG 不能用于 Windows。
- 同一提交的 [CI 运行 37946913482](https://github.com/JackEngineer/downany/actions/runs/37946913482) 中，Windows 打包、包内工具/Sidecar/Electron 冒烟及桌面测试成功，存在 **`downany-installer-win32-x64`** Actions 工件。这是当前 Windows 候选的优先来源，不是正式 Windows Release。
- 整次 CI 失败：Windows Python **1 failed、1067 passed、7 skipped**。失败项为 `tests/core/test_ytdlp_runtime.py::test_invalid_archive_structure_or_static_version_is_rejected[extra3-omit3]`。它属于引擎归档校验，原因未在本交接中确认；不得当作无关失败忽略。
- 标签触发的 CI 没有执行 `workflow_dispatch` 专属的 Windows 覆盖升级门禁，因此不能把打包成功当作真实安装/升级通过。

建议顺序：**取得并锁定候选 → 源码回归/失败项复核 → 可选自动升级门禁（须在安装前）→ 人工首次安装 → 桌面/插件/网站 → 0.3.0 升级 → 卸载重装 → 填表**。先完成下文所有“必需”，再考虑可选项目。未执行填“未执行”，受系统或素材阻挡填“受阻”，不勾通过。

## 1. 准备工具与安全的测试空间（必需）

- [ ] 确认 Windows x64、当前账户可在自选目录写文件；记录 Windows、Chrome 的版本号，不记录用户名、机器名或真实个人路径。
- [ ] 安装/准备 Git、Node.js **20**、Python **3.11**；这是仓库 CI 使用的构建版本。包管理器是 `npm.cmd` 与 `python -m pip`，无需 Chocolatey。GitHub CLI `gh` 仅下载 Actions 工件时需要，网页也可下载。只使用已有 GitHub 登录；不要创建新 token 或扩大权限。
- [ ] 打开普通 PowerShell。以下命令按当前 Git 克隆目录执行；若多行命令复制失败，可合为一行。每个工具安装/脚本命令结束都检查退出码，失败后不要继续下游步骤。

```powershell
git --version
node --version
npm.cmd --version
py -3.11 --version
# 安装了 GitHub CLI 才执行：
gh --version
```

- [ ] 使用一个新克隆，不覆盖已有开发目录：

```powershell
git clone https://github.com/JackEngineer/downany.git downany-windows-check
Set-Location downany-windows-check
git switch --detach e3e860b5a0f0344bc9eae7ed53bd038e890ff552
git rev-parse HEAD
$Repo = (Get-Location).Path
$Work = Join-Path $Repo '.build\windows-handoff'
New-Item -ItemType Directory -Force -Path $Work | Out-Null
```

预期 HEAD 与上面的完整 SHA 相同；`desktop/package.json` 是 0.3.1，`browser-extension/manifest.json` 是 0.9.2。不要改产品代码或升级依赖后仍沿用原候选身份。

- [ ] **如果已有日常 Downany 安装，不要并装旧版做升级试验。** NSIS 的安装标识、快捷方式和 `downany://` 注册属于账户；选择另一个 `/D` 目录不能隔离这些状态。优先在你已有的专用测试 Windows 环境/虚拟机里做安装、升级与卸载。没有安全环境时，将这些项记为受阻，先做不影响日常安装的源码回归。
- [ ] 如涉及现有数据，先完全退出 Downany，私下备份 `%LOCALAPPDATA%\Downany`、下载目录，以及已有旧产品数据目录（如有）；备份不要提交 GitHub。默认日志在 `%LOCALAPPDATA%\Downany\logs`。不要通过清空日常数据伪造首次安装。

## 2. 取得当前 Windows 候选（必需，A/B 选一种）

### A. 下载已成功构建的 Actions 工件（优先）

登录 GitHub 后打开上述 CI 页面，在 Artifacts 下载 **`downany-installer-win32-x64`** 并解压到 `$Work\ci-artifact`。也可以使用已有认证：

```powershell
$ArtifactRoot = Join-Path $Work 'ci-artifact'
gh run download 37946913482 --repo JackEngineer/downany `
  --name downany-installer-win32-x64 --dir $ArtifactRoot
if ($LASTEXITCODE -ne 0) { throw '工件下载失败；不要改用旧候选冒充本次包' }
$Packages = @(Get-ChildItem -LiteralPath $ArtifactRoot -Recurse -Filter 'Downany-0.3.1-win-x64.exe')
$Apps = @(Get-ChildItem -LiteralPath $ArtifactRoot -Recurse -Filter 'Downany.exe' |
  Where-Object { $_.FullName -match '[\\/]win-unpacked[\\/]' })
if ($Packages.Count -ne 1 -or $Apps.Count -ne 1) { throw '包结构不符合预期，请检查工件' }
$Candidate = $Packages[0].FullName
$UnpackedExe = $Apps[0].FullName
Get-FileHash -Algorithm SHA256 -LiteralPath $Candidate
(Get-Item -LiteralPath $Candidate).Length
```

- [ ] 确认 CI 页的 commit 是 `e3e860b…`，不是同名旧构建。Actions 工件会过期；若无法获取，使用 B。
- [ ] 工件包含 `v0.3.1-candidate-artifacts.json`，其 `installers.windows-x64.sha256`、`bytes` 应与实际 NSIS 比较；可用 `Get-ChildItem $ArtifactRoot -Recurse -Filter v0.3.1-candidate-artifacts.json` 定位。**源码目录中原有清单可能记录旧包，不可直接拿它认定当前包。** 不匹配就停止。清单整体/扩展验收辅助器仍有旧扩展 0.8.3 的硬编码，本次只核对 Windows 安装包条目；0.9.2 插件以 Release 哈希单独核验，不使用旧清单替代。
- [ ] 将实际 NSIS SHA-256/字节数、运行号记入结果表。后续所有结果只对应这个包；换包后另起记录。

### B. 工件过期/下载受阻时，在 Windows 本地构建

此路线构建与标签 CI 一致的 **cloud-only 候选**，不要求 Telegram 应用凭据，不证明 Telegram 本地 2 GB 能力。无需 Visual Studio/CMake 原生 Telegram 工具链。构建脚本会重建仓库内 `.build\sidecar`、`desktop\resources\sidecar` 和 `desktop\release`，所以只能在上面的新克隆执行。

```powershell
py -3.11 -m venv venv
& .\venv\Scripts\python.exe -m pip install --upgrade pip
& .\venv\Scripts\python.exe -m pip install -r requirements-dev.txt
if ($LASTEXITCODE -ne 0) { throw 'Python 依赖安装失败' }
$env:DOWNANY_PYTHON = Join-Path $Repo 'venv\Scripts\python.exe'
$env:BUILD_TELEGRAM_NATIVE = '0'
$env:ALLOW_CLOUD_ONLY_PACKAGE = '1'
$env:FETCH_BINS = '1'
$env:BUILD_SIDECAR = '1'
& .\scripts\build_windows_nsis.ps1
if ($LASTEXITCODE -ne 0) { throw 'Windows 安装包构建失败' }
$Candidate = Join-Path $Repo 'desktop\release\Downany-0.3.1-win-x64.exe'
$UnpackedExe = Join-Path $Repo 'desktop\release\win-unpacked\Downany.exe'
Get-FileHash -Algorithm SHA256 -LiteralPath $Candidate
(Get-Item -LiteralPath $Candidate).Length
```

脚本会拉取已锁定的 Windows yt-dlp、同一归档的 FFmpeg/FFprobe，安装 `packaging/requirements-sidecar.txt`（yt-dlp 固定 `2026.8.19`）、构建 PyInstaller **onedir** Sidecar，再执行 `npm.cmd ci`、生产构建和 `dist:win`。本地 NSIS 哈希可能与 CI 不同，必须记录为独立候选，不能复制 CI 哈希。PowerShell 策略若拒绝脚本，记录受阻并交回处理；本清单不要求更改系统执行策略或解除安全封锁。

### 两条路线共同的包内检查

```powershell
$Resources = Join-Path (Split-Path -Parent $UnpackedExe) 'resources'
$MediaBin = Join-Path $Resources 'bin'
node scripts/test_packaged_media_tools.mjs "--bin-dir=$MediaBin"
if ($LASTEXITCODE -ne 0) { throw '包内 FFmpeg/FFprobe 检查失败' }
node scripts/test_packaged_sidecar.mjs `
  "--executable=$Resources\sidecar\DownanySidecar\DownanySidecar.exe" `
  "--data-dir=$Work\sidecar-smoke"
if ($LASTEXITCODE -ne 0) { throw '包内 Sidecar 检查失败' }
node scripts/test_packaged_electron.mjs "--executable=$UnpackedExe"
if ($LASTEXITCODE -ne 0) { throw '包内 Electron 检查失败' }
```

- [ ] 三项成功。若系统安全软件拦截，停止，记录警告类别/检测名称；不要关闭 Defender、加排除项、绕过 SmartScreen 或把告警先认定为误报。

## 3. Windows 源码回归及已知失败复核（必需）

A 路线也需要在新克隆创建 `venv`、安装 `requirements-dev.txt`。不要更换系统 Python 或全局 pip：

```powershell
# A 路线尚未建虚拟环境时才执行这两行：
py -3.11 -m venv venv
& .\venv\Scripts\python.exe -m pip install -r requirements-dev.txt
$env:DOWNANY_BIN_DIR = $MediaBin
$env:DOWNANY_REQUIRE_MEDIA_INTEGRATION = '1'
& .\venv\Scripts\python.exe -m pytest tests/core tests/data tests/sidecar tests/cli -q
# 记下退出码和汇总，再执行专项复核：
& .\venv\Scripts\python.exe -m pytest tests/core/test_ytdlp_runtime.py -q
Push-Location desktop
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败' }
npm.cmd run build
$BuildExit = $LASTEXITCODE
npm.cmd test
$TestExit = $LASTEXITCODE
Pop-Location
"desktop build=$BuildExit tests=$TestExit"
```

- [ ] 记录通过、失败、跳过数及失败的测试 ID；未经调查不把跳过计为通过。媒体集成模式找不到包内工具时应受阻而非静默省略。
- [ ] 已知引擎校验失败是否复现？填“复现/未复现/受阻”，附脱敏摘要。复现就交回修复，**不要改测试期待值使其变绿**。本次任务不要求你发布新版本。

## 4. 可选自动安装/升级门禁（只能在人工安装前、安全测试环境运行）

该工具会实际执行 NSIS 安装、覆盖升级、卸载，并使用自建本机媒体服务；不是只读检查。它会预检已有 Downany 安装、注册项、快捷方式、安装缓存和进程；存在或无法读取时拒绝。**预检失败后不要清理注册表、删除已有安装或绕过预检。** 用人工安全环境验收并记录受阻原因。

```powershell
$OldInstaller = Join-Path $Work 'Downany-0.3.0-win-x64.exe'
Invoke-WebRequest -Uri 'https://github.com/JackEngineer/downany/releases/download/v0.3.0/Downany-0.3.0-win-x64.exe' -OutFile $OldInstaller
$OldHash = (Get-FileHash -LiteralPath $OldInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
if ($OldHash -ne 'db2c3df75e9097573c3525c58e7a1c98ba276c29ad60faa22d6d7fef9adaa8cb') { throw '旧版校验失败' }
$PwRoot = Join-Path $Work 'playwright-runtime'
npm.cmd install --prefix $PwRoot --no-save playwright@1.55.0
if ($LASTEXITCODE -ne 0) { throw '自动门禁依赖安装失败' }
$PwModule = Join-Path $PwRoot 'node_modules\playwright'
node scripts/run_v031_windows_upgrade.mjs `
  "--source-artifact=$OldInstaller" "--candidate-artifact=$Candidate" `
  "--candidate-executable=$UnpackedExe" "--playwright-module=$PwModule" `
  "--results=$Work\windows-upgrade.json"
```

无需安装 Playwright Chromium，工具连接包内 Electron。预期新安装本地下载/解码、真实 0.3.0→0.3.1 设置与任务保留、暂停部分文件续传、已有成品不覆盖等通过。结果仍是自动工程验证；下文人工操作不得直接勾选。报告留在 `.build` 本地，发布前另行脱敏。

## 5. 人工首次安装、启动与隔离数据（必需）

- [ ] 在无日常 Downany 的测试环境，双击本次 NSIS。验证可选择安装目录、快捷方式和启动；从安装目录记录 `Downany.exe` 所在位置为 `$InstalledExe`（仅私下保存实际路径）。**不要使用 `win-unpacked` 代替安装包验收。**
- [ ] 安装器/首次启动若出现 SmartScreen、未知发布者、UAC 或 Defender 提示，记录类别与是否受阻；不要执行旧文档中的绕过/排除建议。无法安全继续时该项记受阻，等待签名或调查。
- [ ] 在隔离测试目录启动前设置测试数据与 Electron profile，避免读取已有任务。下面 `$InstalledExe` 必须改为你刚安装的真实可执行文件，不能原样运行占位符。

```powershell
$InstalledExe = '<刚安装的 Downany.exe 绝对路径>'
$TestRoot = Join-Path $Work 'manual-session'
$TestData = Join-Path $TestRoot 'data'
$TestProfile = Join-Path $TestRoot 'electron-profile'
$TestOutput = Join-Path $TestRoot '下载测试'
New-Item -ItemType Directory -Force -Path $TestData,$TestProfile,$TestOutput | Out-Null
# 仅在本轮新建空测试 data 中创建迁移标记，防止导入日常旧产品数据。
New-Item -ItemType File -Force -Path (Join-Path $TestData '.migration_v1_done'),(Join-Path $TestData '.migration_videodownloader_done') | Out-Null
Remove-Item Env:DOWNANY_BIN_DIR -ErrorAction SilentlyContinue
Remove-Item Env:DOWNANY_PYTHON -ErrorAction SilentlyContinue
$env:DOWNANY_DATA_DIR = $TestData
$env:DOWNANY_UPDATE_DISABLED = '1'
$env:DOWNANY_BRIDGE_PORT = '17888'
# 此路线需要安装器实际注册协议，因此不设置 SKIP_PROTOCOL_REGISTRATION。
Remove-Item Env:DOWNANY_SKIP_PROTOCOL_REGISTRATION -ErrorAction SilentlyContinue
& $InstalledExe "--user-data-dir=$TestProfile"
```

只运行一个 Downany 实例，退出后再切换版本；从这个 PowerShell 启动后续隔离测试，快捷方式不会自动继承这里的环境。首次安装时自动启动的普通实例应先正常退出。以上迁移标记表示**没有测试旧产品数据导入**，不能把它填为迁移通过。

- [ ] 设置下载位置为 `$TestOutput`，保持真实个人下载目录不变；应用能显示主界面，设置可保存。检查：

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:17888/health'
```

预期 `ok: true`、`sidecarReady: true`。若端口占用，用 `Get-NetTCPConnection -LocalPort 17888 -ErrorAction SilentlyContinue` 只查所属 PID；确认已有应用后正常退出，不盲目终止所有进程或改扩展端口。缺少 Sidecar/媒体工具先检查安装目录的 `resources` 与系统安全提示，不用开发 venv 掩盖包内缺失。

- [ ] 从“添加下载链接”添加有下载授权的视频，完成后由应用打开成品/所在文件夹，再播放整个文件。可先使用 Blender 开放影片 [Caminandes 3 官方视频](https://www.youtube.com/watch?v=SkVqJ1SGeL0) 做冒烟；确认页面许可仍适合你的使用。一次成功不代表网站矩阵通过。

## 6. 桌面核心操作（必需）

所有删除、取消、中断只作用于 `$TestRoot` 和本轮测试任务；不会删除日常数据库或下载成品。

| 勾选 | 操作 | 预期与证据 |
|---|---|---|
| [ ] | 添加 3 个独立授权素材，包含视频+音频；设置低并发便于观察 | 等待、下载中、完成状态可信，百分比不虚报，打开成品可完整播放 |
| [ ] | 下载中点“暂停”，退出并重新打开同一测试数据，再继续 | 暂停任务/已下载进度保留，可继续至完成；是否真正续传与重新下载分开记录 |
| [ ] | 取消一个测试任务，重试一个真实失败任务 | 状态正确；重试不自动改变画质、音频模式、输出目录或覆盖已有成品 |
| [ ] | 排序切换“最新优先”“最早优先”，在任务列表与历史查看并重启 | 顺序一致、偏好保留；不要把显示排序当作已经改变调度优先级 |
| [ ] | 只删除一个本轮测试任务；查看已完成历史 | 删除范围正确，其他任务/历史/文件不受影响；涉及删除成品只选测试文件 |
| [ ] | 将下载目录改到含中文、空格及多层子目录，逐步加深后下载/合并/MP3 | 正常范围成功，过长/不可写时明确失败而非“完成”；不修改系统长路径策略 |
| [ ] | 重复下载同标题素材，下载前后对原成品计算 SHA-256 | 原文件哈希不变，新任务得到独立输出或明确结果，不静默覆盖 |
| [ ] | 做 5 轮退出恢复：至少含正常退出、暂停后退出、仅测试进程的异常退出 | ID/顺序/设置/暂停/失败/取消状态保留；已有成品哈希不变，继续后可完整播放 |

异常退出仅在专用测试环境：从任务管理器按路径/PID确认本轮应用，再结束该测试实例；不要执行按名称批量 `taskkill`，不要关系统网络影响其他应用。异常退出属于故障试验，先备份测试 data，逐轮记录。中文长路径从可用路径逐步逼近限制，出现明确路径错误本身不是“下载成功”；不要无限加长或写入系统受保护目录。

成品质量辅助检查（`$MediaFile` 是本轮成品，路径仅在私下命令中使用）：

```powershell
$MediaFile = '<本轮成品绝对路径>'
Get-FileHash -Algorithm SHA256 -LiteralPath $MediaFile
& "$MediaBin\ffprobe.exe" -v error -show_streams -show_format -of json $MediaFile
& "$MediaBin\ffmpeg.exe" -v error -i $MediaFile -f null -
$LASTEXITCODE
```

预期视频有有效视频/音频流，纯 MP3 有音频流，时长>0，完整解码退出码 0。720p 上限检查真正的视频流；封面 `attached_pic` 不算主视频。播放开头几秒不是完整播放/解码通过。

## 7. Chrome 插件 0.9.2（必需，原生人工操作）

- [ ] 从 v0.3.1 Release 下载 `Downany-chrome-extension-0.9.2.zip`，SHA-256 应为 `5cbd8dd4fb8fa25f87d4696b6f53c145a2fe1f866190ba01b89d79bd776775e4`。解压到独立测试目录；Chrome `chrome://extensions` → 开发者模式 →“加载已解压的扩展程序”，选择含 `manifest.json` 的目录，确认版本 0.9.2。已有相同扩展先记录当前版本与目录，不重复加载混淆；切换目录后重新加载并确认。
- [ ] 先启动上述隔离桌面端，打开工具栏弹窗，连接成功。若 Chrome 向该扩展询问访问本地网络，可在明确认识该扩展的前提下允许；拒绝或企业策略阻挡则记录“本地网络访问受阻”，不要通过改 Chrome flags 绕过。
- [ ] 只在授权视频网页上播放后检查检测媒体：标题、列表、音视频类型、空状态合理；从一个网页导航到另一个网页，旧媒体不串到当前页。直播、DRM、付费无权内容不作为本轮样本。
- [ ] 选中多个不同媒体，点击实际按钮“下载检测媒体”；快速重复点击、关闭再打开弹窗。桌面任务数只增加预期数量，选择/发送回执保留，“最近发送”可见进度；没有凭空复制重复任务。
- [ ] 分别测试“输出 → 视频 / 原媒体”“音频（MP3）”；视频抽音频得到可播放 MP3，原音频不会无故二次转码。切换模式/重开弹窗偏好保留。页面解析入口的选项可见时再测，不把检测媒体与页面解析混为一条路径。
- [ ] “网页清晰度偏好 → 不超过 720p”后点“解析本页视频”，观察真实网页任务；主视频不超过 720p 或明确报格式不可用。该偏好不保证直链检测媒体重新选出其他清晰度。失败后重试必须保留原任务音视频/画质等选项；不得默默降级宣称成功。
- [ ] 正常退出测试桌面端，回到插件观察断线；尝试发送时系统 `downany://` 唤醒提示与恢复、弹窗“重连”都要记录。若自动唤醒没有继承隔离环境，立即正常退出，改从上述 PowerShell 启动再重连；不能借此污染日常数据。记录唤醒机制与隔离桥接恢复是两个不同结果。
- [ ] 新建一个本轮失败任务，确认插件失败提示没有泄露原始媒体 URL/凭据。抖音 `Fresh cookies (not necessarily logged in) are needed` 应提示无法取得详情/登录状态未知，不自动判定你未登录；可尝试“网页识别”或实际检测到媒体后下载。页面能播不保证详情接口能下载。

源码中按钮以 `browser-extension/popup.html` 为准；旧 README 的“下载选中”等历史字样不能替代 0.9.2 实际 UI。0.9.1 的历史原生结果不能计入本次。

## 8. 真实网站：匿名与本人登录对照（必需，分步骤记录）

先小范围验证 YouTube、Bilibili、抖音各一个本人有权下载的样本，然后补齐正式矩阵。开放影片用于冒烟；抖音优先自己的作品，其地址只留本地，不写公开结果。不要向他人索取账号/cookies，不导出浏览器数据库。

- [ ] 桌面设置“从浏览器导入 Cookie”留空时做匿名任务；记录最终错误码、完成与完整解码结果。
- [ ] 在你自己的 Chrome 登录有权访问的账号，同一个素材再对照；仅在你主动选择“从浏览器导入 Cookie”时使用该授权来源，或者在“网页识别”窗口由你本人登录并主动重试。插件检测媒体路线本身不读取 Chrome cookies，不能当作浏览器 Cookie 已导入的证明。
- [ ] 匿名能下载的样本仍是普通样本，不能作为“需登录”成功。登录门禁要求匿名最终错误明确认证限制，随后同样本授权下载完整解码；读取 Cookie 失败、验证码、403、Fresh cookies/详情为空等不明确失败，都不能证明需登录。
- [ ] 若出现 `cookie_unavailable`（无法读取所选来源），与 `need_login`、`site_response_unavailable` 分开记录。浏览器已登录不保证 Windows Cookie 解密或站点允许下载；不要强行解密/换个人资料目录，交回诊断。
- [ ] 抖音匿名已知可能失败；分别记录网页详情解析、实际媒体抓取以及内置登录重试。没有捕获有效媒体就记受阻/失败，不要求你反复登录。不要把自有作品的一次成功代表所有抖音场景。

### 正式 30 条矩阵（声明 Windows 网站可靠性前必须完成）

仓库 `docs/acceptance/v0.3.1-reliability-matrix.json` 固定 YouTube/Bilibili/抖音各 10 条：普通 5、登录 2、合集 2、非法/删除 1。所有素材要有下载授权，不同用例不能复用同一素材或同片不同转载。旧样本资格/合集可用性可能已变，必须重新核实；不够就填受阻。

自动运行器可选，但真实场景证据必需。它会创建隔离 Electron/数据目录，验证包身份并完整解码。使用第 4 节安装的 `$PwModule`；未安装时只安装该局部 `playwright@1.55.0` 依赖。关闭所有 Downany 测试实例、释放 17888，再执行，不能与人工插件测试同时跑。

```powershell
# 在本机赋值，不公开这些地址；下面只是写法，须换为真实授权素材。
$env:DOWNANY_YOUTUBE_01 = '<授权视频 URL>'
$Matrix = Join-Path $Repo 'docs\acceptance\v0.3.1-reliability-matrix.json'
$WebsiteResults = Join-Path $Work 'windows-websites.json'
node scripts/run_v031_reliability_matrix.mjs `
  "--executable=$UnpackedExe" "--candidate-artifact=$Candidate" `
  "--playwright-module=$PwModule" "--matrix=$Matrix" "--results=$WebsiteResults" `
  --target=windows-x64 --expected-version=0.3.1 --case=youtube-01
```

登录用例由矩阵运行器先做空凭据匿名实例；仅明确认证限制才自动创建第二个授权实例。本人确认允许使用 Chrome 登录状态后可增加 `--cookies-from-browser=chrome`，**只写浏览器名，不写 `chrome:Default`**。不要传 `--cookiefile`。每个用例地址环境变量名在矩阵的 `urlSource` 中；准备完全部 30 个地址后去掉 `--case` 运行，逐条失败可用 `--case=<ID>` 续跑。不要开启命令转录保存地址、cookies 或原始错误。

```powershell
node scripts/evaluate_v031_acceptance.mjs $Matrix $WebsiteResults
```

此评估器同时要求 Mac 和 Windows，单独 Windows 文件总体 `passed:false` 可能包含“缺少 Mac”原因；关注 `targets.windows-x64`，保留具体失败，不把总体输出人工改真。Windows 30 条全覆盖、合格样本与每个网站可下载场景至少 90% 门槛必须按真实结果评估；登录对照、合集资格或独立性未满足时不计合格成功。不能用本轮 3 次冒烟替代 30 条。

## 9. 0.3.0→0.3.1 人工升级（必需）

仅在专用测试环境进行。若第 5 节已安装候选，先备份并正常卸载**测试候选**，再做旧版基线；不要降级覆盖日常数据库。

- [ ] 取得官方 `Downany-0.3.0-win-x64.exe`，下载地址与 SHA-256 见第 4 节。确认哈希后安装旧版；安全提示受阻则记录，不绕过。
- [ ] 新建 `$Work\manual-upgrade` 独立 data/profile/output，按第 5 节同样设置环境和迁移标记，再启动旧版（始终确认运行路径/版本）。
- [ ] 设置下载目录、画质、并发；创建至少已完成、已暂停（有部分字节）、等待任务。私下备份测试 data（应用退出后复制）和成品，记录 ID/状态/顺序/设置摘要及成品哈希，不公开 URL。
- [ ] 完全退出旧版，用本次 0.3.1 NSIS **覆盖安装同一测试安装位置**，不先卸载旧版或清数据。用同一测试 data/profile 启动新版本。
- [ ] 原设置、ID、顺序、历史、暂停状态保留；暂停任务能继续完成。已完成文件哈希仍一致，重复下载不覆盖。播放/解码全部本轮成品。
- [ ] 首次安装七项人工门槛分别填写：`firstInstall`、`upgradeFrom030`、`settingsPreserved`、`queuePreserved`、`pauseResume`、`playback`、`noOverwrite`。自动门禁通过不能代填人工 `true`。

## 10. 卸载、重装与完成后的处理（必需）

- [ ] 先正常退出测试应用，备份测试数据和已完成文件，再通过 Windows“已安装的应用”卸载本轮测试 Downany。核对快捷方式/协议注册的结果，不手动清注册表；未清理就记录问题。
- [ ] 观察测试下载成品与备份是否仍在。用户数据是否保留以实际观察为准，不承诺卸载器必然保留所有内容。
- [ ] 重装同一候选，分别检查：同一测试 data 的恢复；另一个新空测试 data/profile 的首次启动。仅换自己创建的测试目录，不删除 `%LOCALAPPDATA%\Downany` 或真实下载目录。
- [ ] 恢复插件输出/清晰度偏好，关闭本轮测试网页与程序；只在确认全部属于本轮后处理 `$Work` 中生成物。先保留证据/备份，不为清理 git 状态而删原资料。
- [ ] 用一个新的 PowerShell 做日常工作，避免继续继承验收的 `DOWNANY_*` 环境。应用更新只查询正式 Latest；当前预发布不会自动替换稳定版，没提示 0.3.1 不是升级失败。

## 11. 如何交回结果与判定

**必需**：候选身份、Windows 回归及已知失败复核、人工安装七项、核心队列/排序/中文长路径/不覆盖、原生插件 0.9.2、真实网站及授权对照、系统提示、卸载重装。完成前均不宣称 Windows 整体通过。

**可选/另行验收**：第 4 节自动升级门禁、Edge、Windows ARM64、Telegram 原生本地模式、大文件/直播/DRM。不要创建 Telegram 应用凭据来完成本轮，不提交商店，不自行向现有 Mac Release 加 Windows 资产。五人试用已取消。

先复制下面表格到本地 `$Work` 的记录；对每项填 `通过/失败/受阻/未执行/不适用`。原因写固定类别和现象，不附个人地址/URL/cookie/token/数据库/下载记录/机器原始日志。截图裁去账号、网页地址、个人路径和其他应用信息；诊断导出仅留本地，审核脱敏后再分享，不直接提交 ZIP。

```text
源码提交：e3e860b5a0f0344bc9eae7ed53bd038e890ff552
包来源：Actions 37946913482 / 本地构建（二选一）
桌面/插件版本：0.3.1 / 0.9.2
Windows架构/版本：
Chrome版本：
NSIS字节数/SHA256：
插件SHA256：
测试是否隔离、是否备份：
执行日期：
Python通过/失败/跳过：
已知引擎校验失败：复现/未复现/受阻；测试ID：
桌面构建/测试结果：
人工七项：firstInstall=；upgradeFrom030=；settingsPreserved=；queuePreserved=；pauseResume=；playback=；noOverwrite=
核心操作：排序=；长路径=；同名不覆盖=；5轮恢复=
插件：连接=；断线/重连=；系统唤醒=；媒体展示=；批量去重=；视频=；MP3=；720p页面解析=；失败重试保留选项=
网站：youtube=；bilibili=；douyin=；授权配对=；正式30项已执行数=
卸载/重装：
系统警告：无/SmartScreen/UAC/Defender/企业策略/其他；是否受阻：
问题编号 | 用例ID | 状态 | 预期 | 实际现象(脱敏) | 固定错误码 | 候选SHA256 | 成品字节数/哈希 | 主视频分辨率/音频流 | 完整解码退出码 | 证据代号
WIN-001 | ...
```

可以另外复制仓库 `v0.3.1-manual-acceptance.template.json` 到 `$Work`，只填写真实 Windows 记录，`firstUseTrials` 保持空；未执行 Mac 项不要改真。`node scripts/evaluate_v031_manual_acceptance.mjs <本地记录绝对路径>` 同样是双平台判断，缺 Mac 时不表示应伪造 Mac 结果。模板里的 `manual` 只在确实人工执行后填真，候选 SHA 必须对应本轮实际 NSIS。

交回“结果表+脱敏问题摘要”即可。若某项失败，保留失败的候选身份和复现步骤；修复后需新候选重新验证相关项，不能改旧证据。最终 Windows 是否通过、是否另行公开安装包，由完整证据决定，当前文档不改变 v0.3.1 Mac 预发布状态。

## 实现依据

- 构建/包名/安装卸载：[build_windows_nsis.ps1](../scripts/build_windows_nsis.ps1)、[CI](../.github/workflows/ci.yml)、[electron-builder.yml](../desktop/electron-builder.yml)、[installer.nsh](../desktop/build/installer.nsh)。
- 隔离/端口/安装保护：[appDataDir.ts](../desktop/electron/appDataDir.ts)、[bridgeServer.ts](../desktop/electron/bridgeServer.ts)、[Windows升级门禁](../scripts/run_v031_windows_upgrade.mjs)、[NSIS预检](../scripts/windows_nsis_preflight.mjs)。
- 当前标签/界面：[插件 popup](../browser-extension/popup.html)、[中文文案](../desktop/renderer/locales/zh-CN.ts)、[排序控件](../desktop/renderer/components/shell/FilterBar.tsx)。
- 网站/人工规则：[矩阵](acceptance/v0.3.1-reliability-matrix.json)、[矩阵运行器](../scripts/run_v031_reliability_matrix.mjs)、[授权证据规则](../scripts/v031_login_evidence.mjs)、[人工模板](acceptance/v0.3.1-manual-acceptance.template.json)。
