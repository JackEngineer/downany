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

$FetchBins = if ($env:FETCH_BINS) { $env:FETCH_BINS } else { "1" }
$BuildSidecar = if ($env:BUILD_SIDECAR) { $env:BUILD_SIDECAR } else { "1" }

$Desktop = Join-Path $Root "desktop"
$Out = Join-Path $Desktop "resources\sidecar"
$BuildDir = Join-Path $Root ".build\sidecar"
$Spec = Join-Path $Root "packaging\sidecar.spec"

if ($FetchBins -eq "1") {
    Write-Host "==> 拉取发布二进制 (Windows，等价 TARGET_OS=windows)"
    & (Join-Path $Root "scripts\fetch_release_binaries.ps1")
    if ($LASTEXITCODE -ne 0) {
        Fail -Step "fetch_release_binaries.ps1" -ExitCode $LASTEXITCODE
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

Write-Host "==> Electron 构建"
Set-Location $Desktop

if (Test-Path -LiteralPath "package-lock.json") {
    npm ci
    if ($LASTEXITCODE -ne 0) { Fail -Step "npm ci" -ExitCode $LASTEXITCODE }
}
else {
    npm install
    if ($LASTEXITCODE -ne 0) { Fail -Step "npm install" -ExitCode $LASTEXITCODE }
}

npm run build
if ($LASTEXITCODE -ne 0) { Fail -Step "npm run build" -ExitCode $LASTEXITCODE }

$ReleaseDir = Join-Path $Desktop "release"
if (Test-Path -LiteralPath $ReleaseDir) { Remove-Item -Recurse -Force $ReleaseDir }

npm run dist:win
if ($LASTEXITCODE -ne 0) { Fail -Step "npm run dist:win" -ExitCode $LASTEXITCODE }

Write-Host "==> 产物目录: $ReleaseDir"
Get-ChildItem $ReleaseDir
