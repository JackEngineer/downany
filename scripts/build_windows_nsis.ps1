<#
.SYNOPSIS
  构建 Windows NSIS 安装包（Sidecar onedir + Electron dist:win）。

.DESCRIPTION
  编排步骤（与 scripts/build_macos_dmg.sh 对称）：
  1. fetch_release_binaries.ps1 — 拉取 yt-dlp.exe + ffmpeg.exe
  2. PyInstaller onedir Sidecar — 直接写入 desktop/resources/sidecar/DownanySidecar/
     （与 build_sidecar.sh 相同：--distpath 指向 resources/sidecar，产物为
     DownanySidecar/DownanySidecar.exe，无额外 copy 步骤）
  3. npm ci → npm run build → npm run dist:win

  环境变量（可选，默认均为 1）：
  - $env:FETCH_BINS = "0"     跳过二进制拉取
  - $env:BUILD_SIDECAR = "0"  跳过 Sidecar 构建
  - $env:ALLOW_CLOUD_ONLY_PACKAGE = "1"  仅显式允许云端开发包；正式包默认要求 Telegram Bot API/ProcessHost 原生资源

  失败时以 Write-Error 抛出并附带 exit code，便于 CI 日志定位。

.NOTES
  需在 Windows 上运行（Python venv + Node.js）。不在 macOS 上产出 NSIS；
  供 Windows runner / 开发者本地打包使用。
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

function Fail {
    param(
        [string]$Step,
        [int]$ExitCode = 1,
        [string]$Detail = ""
    )
    $msg = "[$Step] 失败 (exit $ExitCode)"
    if ($Detail) { $msg += ": $Detail" }
    Write-Error $msg
    exit $ExitCode
}

# 定位到仓库根目录
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
Write-Host "==> 仓库根: $Root"
. (Join-Path $Root "scripts\windows_release_helpers.ps1")

$FetchBins = if ($env:FETCH_BINS) { $env:FETCH_BINS } else { "1" }
$BuildSidecar = if ($env:BUILD_SIDECAR) { $env:BUILD_SIDECAR } else { "1" }
$BuildTelegramNative = if ($env:BUILD_TELEGRAM_NATIVE) { $env:BUILD_TELEGRAM_NATIVE } else { "1" }
$AllowCloudOnlyPackage = $env:ALLOW_CLOUD_ONLY_PACKAGE -eq "1"

$Desktop = Join-Path $Root "desktop"
$Out = Join-Path $Desktop "resources\sidecar"
$BuildDir = Join-Path $Root ".build\sidecar"
$Spec = Join-Path $Root "packaging\sidecar.spec"

if ($BuildTelegramNative -eq "1") {
    Write-Host "==> 构建 Telegram Bot API (Windows x64)"
    & (Join-Path $Root "scripts\build_telegram_bot_api_windows.ps1") -WorkspaceRoot $Root
    if ($LASTEXITCODE -ne 0) { Fail -Step "build_telegram_bot_api_windows.ps1" -ExitCode $LASTEXITCODE }
    Write-Host "==> 构建 ProcessHost (Windows x64)"
    & (Join-Path $Root "scripts\build_process_host_windows.ps1")
    if ($LASTEXITCODE -ne 0) { Fail -Step "build_process_host_windows.ps1" -ExitCode $LASTEXITCODE }
}

if ($FetchBins -eq "1") {
    Write-Host "==> 拉取发布二进制 (Windows，等价 TARGET_OS=windows)"
    & (Join-Path $Root "scripts\fetch_release_binaries.ps1")
    $fetchExitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
    if ($fetchExitCode -ne 0) {
        Fail -Step "fetch_release_binaries.ps1" -ExitCode $fetchExitCode
    }
}

if ($BuildSidecar -eq "1") {
    Write-Host "==> 构建 Sidecar (PyInstaller onedir)"

    $Python = if ($env:DOWNANY_PYTHON) { $env:DOWNANY_PYTHON } else { Join-Path $Root "venv\Scripts\python.exe" }
    if (-not (Test-Path -LiteralPath $Python)) {
        $PythonCmd = Get-Command python -ErrorAction SilentlyContinue
        if ($PythonCmd) {
            $Python = $PythonCmd.Source
        }
        else {
            Fail -Step "Sidecar" -Detail "未找到 Python（请激活 venv 或设置 DOWNANY_PYTHON）"
        }
    }

    Write-Host "    Python: $Python"

    Write-Host "==> 安装 packaging 依赖"
    & $Python -m pip install -q -r (Join-Path $Root "packaging\requirements-sidecar.txt")
    if ($LASTEXITCODE -ne 0) {
        Fail -Step "pip install requirements-sidecar.txt" -ExitCode $LASTEXITCODE
    }

    Write-Host "==> PyInstaller → $Out"
    if (Test-Path -LiteralPath $BuildDir) { Remove-Item -Recurse -Force $BuildDir }
    # 清掉旧 onefile 单文件，避免与 onedir 目录同名冲突（与 build_sidecar.sh 一致）
    if (Test-Path -LiteralPath $Out) { Remove-Item -Recurse -Force $Out }
    New-Item -ItemType Directory -Force -Path $BuildDir, $Out | Out-Null
    New-Item -ItemType File -Force -Path (Join-Path $Out ".gitkeep") | Out-Null

    & $Python -m PyInstaller `
        --noconfirm `
        --clean `
        --distpath $Out `
        --workpath (Join-Path $BuildDir "work") `
        $Spec
    if ($LASTEXITCODE -ne 0) {
        Fail -Step "PyInstaller" -ExitCode $LASTEXITCODE
    }

    # onedir: OUT/DownanySidecar/DownanySidecar.exe
    # onefile 兼容: OUT/DownanySidecar.exe
    $SidecarDir = Join-Path $Out "DownanySidecar"
    $Sidecar = Join-Path $SidecarDir "DownanySidecar.exe"
    if (-not (Test-Path -LiteralPath $Sidecar)) {
        $Sidecar = Join-Path $Out "DownanySidecar.exe"
    }
    if (-not (Test-Path -LiteralPath $Sidecar)) {
        Fail -Step "Sidecar" -Detail "未找到可执行文件（期望 onedir $SidecarDir\DownanySidecar.exe）"
    }

    Write-Host "==> 冒烟"
    Get-Item -LiteralPath $Sidecar | Format-List FullName, Length, LastWriteTime

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Sidecar
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $line = $p.StandardOutput.ReadLine()
    $sw.Stop()
    $preview = if ($line) { $line.Substring(0, [Math]::Min(80, $line.Length)) } else { "" }
    Write-Host ("hello_latency={0:F3}s {1}" -f $sw.Elapsed.TotalSeconds, $preview)
    if ($sw.Elapsed.TotalSeconds -gt 15.0) {
        Write-Warning "Sidecar hello 过慢，请检查是否仍为 onefile 或磁盘过慢"
    }
    if (-not $p.HasExited) {
        $p.Kill()
        $p.WaitForExit(5000) | Out-Null
    }
    Write-Host "OK: $Sidecar"
}

$SidecarBin = Join-Path $Desktop "resources\sidecar\DownanySidecar\DownanySidecar.exe"
if (-not (Test-Path -LiteralPath $SidecarBin)) {
    $SidecarBin = Join-Path $Desktop "resources\sidecar\DownanySidecar.exe"
}
if (-not (Test-Path -LiteralPath $SidecarBin)) {
    Fail -Step "前置检查" -Detail "缺少 Sidecar 二进制，请先构建 Sidecar 或设置 BUILD_SIDECAR=1"
}

$Ffmpeg = Join-Path $Desktop "resources\bin\ffmpeg.exe"
if (-not (Test-Path -LiteralPath $Ffmpeg)) {
    Fail -Step "前置检查" -Detail "缺少 ffmpeg.exe，请先运行 fetch_release_binaries.ps1"
}

if (-not $AllowCloudOnlyPackage) {
    $TelegramRoot = Join-Path $Desktop "resources\telegram-bot-api"
    $TelegramExecutable = Join-Path $TelegramRoot "telegram-bot-api.exe"
    $TelegramCredentials = Join-Path $TelegramRoot "app-credentials.json"
    $TelegramManifest = Join-Path $TelegramRoot "manifest.json"
    $ProcessHostExecutable = Join-Path $Desktop "resources\process-host\DownanyProcessHost.exe"
    $ProcessHostManifest = Join-Path $Desktop "resources\process-host\process-host-manifest.json"
    foreach ($required in @($TelegramExecutable, $TelegramCredentials, $TelegramManifest, $ProcessHostExecutable, $ProcessHostManifest)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            Fail -Step "前置检查" -Detail "缺少 Telegram 本地模式资源: $required；请先构建原生资源和生成 app-credentials.json。仅云端开发包可显式设置 ALLOW_CLOUD_ONLY_PACKAGE=1"
        }
    }
    try {
        $manifest = Get-Content -LiteralPath $TelegramManifest -Raw -Encoding utf8 | ConvertFrom-Json
        if ($manifest.platform -ne "win32-x64" -or $manifest.executable -ne "telegram-bot-api.exe" -or $manifest.sha256 -notmatch "^[0-9a-f]{64}$") {
            throw "manifest platform/executable/sha256 不符合 Windows x64 合同"
        }
        $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $TelegramExecutable).Hash.ToLowerInvariant()
        if ($actualHash -ne $manifest.sha256.ToLowerInvariant()) { throw "Telegram Bot API manifest SHA256 不匹配" }
        $credentials = Get-Content -LiteralPath $TelegramCredentials -Raw -Encoding utf8 | ConvertFrom-Json
        if ($credentials.schemaVersion -ne 1 -or $credentials.apiId -notmatch "^[1-9][0-9]*$" -or $credentials.apiHash -notmatch "^[0-9a-fA-F]{32}$") {
            throw "app-credentials.json schema/API 凭据无效"
        }
        $hostManifest = Get-Content -LiteralPath $ProcessHostManifest -Raw -Encoding utf8 | ConvertFrom-Json
        if ($hostManifest.schemaVersion -ne 1 -or $hostManifest.platform -ne "win32-x64" -or $hostManifest.executable -ne "DownanyProcessHost.exe" -or $hostManifest.sha256 -notmatch "^[0-9a-f]{64}$" -or [int64]$hostManifest.bytes -le 4096) {
            throw "ProcessHost manifest platform/executable/sha256/bytes 不符合 Windows x64 合同"
        }
        $hostHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ProcessHostExecutable).Hash.ToLowerInvariant()
        $hostBytes = (Get-Item -LiteralPath $ProcessHostExecutable).Length
        if ($hostHash -ne $hostManifest.sha256.ToLowerInvariant() -or $hostBytes -ne [int64]$hostManifest.bytes) {
            throw "ProcessHost manifest SHA256/bytes 不匹配"
        }
    } catch {
        Fail -Step "前置检查" -Detail "Telegram 本地模式资源校验失败: $($_.Exception.Message)"
    }
}

Write-Host "==> Electron 构建"
Set-Location $Desktop

if ([string]::IsNullOrWhiteSpace($env:NPM_CONFIG_CACHE)) {
    $env:NPM_CONFIG_CACHE = Join-Path $Root ".build\npm-cache"
}
New-Item -ItemType Directory -Force -Path $env:NPM_CONFIG_CACHE | Out-Null

if (Test-Path -LiteralPath "package-lock.json") {
    # PowerShell may resolve `npm` to npm.ps1 (or an execution-policy shim).
    # Use the Windows command entrypoint explicitly so the release gate behaves
    # the same way on a clean runner and on a developer machine.
    npm.cmd ci
    if ($LASTEXITCODE -ne 0) { Fail -Step "npm ci" -ExitCode $LASTEXITCODE }
}
else {
    npm.cmd install
    if ($LASTEXITCODE -ne 0) { Fail -Step "npm install" -ExitCode $LASTEXITCODE }
}

npm.cmd run build
if ($LASTEXITCODE -ne 0) { Fail -Step "npm run build" -ExitCode $LASTEXITCODE }

$ReleaseDir = Join-Path $Desktop "release"
if (Test-Path -LiteralPath $ReleaseDir) { Remove-Item -Recurse -Force $ReleaseDir }

$ElectronBuildArgs = try {
    Get-DownanyElectronBuildArguments -DesktopPath $Desktop
}
catch {
    Fail -Step "Electron runtime" -Detail $_.Exception.Message
}
Write-Host "==> Electron runtime: node_modules\electron\dist"
npm.cmd @ElectronBuildArgs
if ($LASTEXITCODE -ne 0) { Fail -Step "npm run dist:win" -ExitCode $LASTEXITCODE }

Write-Host "==> 产物目录: $ReleaseDir"
Get-ChildItem $ReleaseDir
