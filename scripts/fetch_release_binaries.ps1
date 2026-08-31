<#
.SYNOPSIS
  拉取发布用 yt-dlp.exe + ffmpeg.exe/ffprobe.exe 到 desktop/resources/bin（Windows 原生 PowerShell 版）。

.DESCRIPTION
  供没有 Git Bash / WSL 的 Windows 开发者使用，效果与在 Windows 上执行
  `TARGET_OS=windows ./scripts/fetch_release_binaries.sh` 等价，使用
  Invoke-WebRequest + Expand-Archive 原生实现，避免依赖 curl/unzip。
  版本锁定与 scripts/fetch_release_binaries.sh 保持同步，修改任一方时
  请同时更新另一方，避免两端产物版本漂移。

.PARAMETER Dest
  产物目标目录，默认 <repo>\desktop\resources\bin。

.NOTES
  yt-dlp.exe:
    默认 URL: https://github.com/yt-dlp/yt-dlp/releases/download/<YTDLP_VERSION>/yt-dlp.exe
    可用环境变量 YTDLP_VERSION / YTDLP_URL / YTDLP_SHA256 覆盖。

  ffmpeg.exe + ffprobe.exe（BtbN/FFmpeg-Builds 静态构建，win64-gpl）：
    默认读取 packaging/ffmpeg-windows/source.lock.json。该锁只接受 BtbN 每月最后一次
    构建（上游保留两年），不使用只保留 14 份的普通日构建或浮动的 `latest`。
    FFmpeg 7.1.5 与 macOS 端锁定的 7.1.1 保持同一大版本线；CI 会在下载前核对
    GitHub Release 资产与官方 SHA-256 digest。
    可用环境变量 FFMPEG_WIN_URL / FFMPEG_WIN_SHA256 覆盖。
    zip 内层结构为 <asset-basename>\bin\ffmpeg.exe + ffprobe.exe；本脚本要求两者
    恰好各一份且来自同一 bin 目录，再将这对工具一并落盘。

.EXAMPLE
  .\scripts\fetch_release_binaries.ps1

.EXAMPLE
  $env:FFMPEG_WIN_SHA256 = "c067a1ca58f4fc4449f4bab0890fbcd65cbb3e5f46e066cf9c768e06c0c1d4d9"
  .\scripts\fetch_release_binaries.ps1
#>

[CmdletBinding()]
param(
    [string]$Dest = ""
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Dest)) {
    $Dest = Join-Path $RepoRoot "desktop\resources\bin"
}
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

$YtdlpVersion = if ($env:YTDLP_VERSION) { $env:YTDLP_VERSION } else { "2026.02.04" }
$YtdlpUrl = if ($env:YTDLP_URL) { $env:YTDLP_URL } else { "https://github.com/yt-dlp/yt-dlp/releases/download/$YtdlpVersion/yt-dlp.exe" }
$YtdlpSha256 = $env:YTDLP_SHA256

$FfmpegLockPath = Join-Path $RepoRoot "packaging\ffmpeg-windows\source.lock.json"
$FfmpegLock = Get-Content -LiteralPath $FfmpegLockPath -Raw | ConvertFrom-Json
$FfmpegUrl = if ($env:FFMPEG_WIN_URL) { $env:FFMPEG_WIN_URL } else { [string]$FfmpegLock.url }
$FfmpegSha256 = if ($env:FFMPEG_WIN_SHA256) { $env:FFMPEG_WIN_SHA256 } else { [string]$FfmpegLock.sha256 }

function Get-FileSha256 {
    param([string]$Path)
    (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

Write-Host "==> 下载 yt-dlp $YtdlpVersion (Windows)"
$YtdlpTmp = Join-Path $Dest "yt-dlp.exe.download"
Invoke-WebRequest -Uri $YtdlpUrl -OutFile $YtdlpTmp -UseBasicParsing
$YtdlpActual = Get-FileSha256 -Path $YtdlpTmp
Write-Host "yt-dlp.exe SHA256: $YtdlpActual"
if ($YtdlpSha256 -and ($YtdlpActual -ne $YtdlpSha256.ToLowerInvariant())) {
    Remove-Item -Force $YtdlpTmp
    throw "yt-dlp.exe SHA256 校验失败：期望 $YtdlpSha256，实际 $YtdlpActual"
}
Move-Item -Force $YtdlpTmp (Join-Path $Dest "yt-dlp.exe")

Write-Host "==> 下载 ffmpeg + ffprobe (Windows, BtbN static win64-gpl)"
Write-Host "    $FfmpegUrl"
$FfmpegZip = Join-Path $Dest "ffmpeg-win.zip"
Invoke-WebRequest -Uri $FfmpegUrl -OutFile $FfmpegZip -UseBasicParsing
$FfmpegActual = Get-FileSha256 -Path $FfmpegZip
Write-Host "ffmpeg zip SHA256: $FfmpegActual"
if ($FfmpegSha256 -and ($FfmpegActual -ne $FfmpegSha256.ToLowerInvariant())) {
    Remove-Item -Force $FfmpegZip
    throw "ffmpeg zip SHA256 校验失败：期望 $FfmpegSha256，实际 $FfmpegActual"
}

$TempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$ExtractDir = [System.IO.Path]::GetFullPath(
    (Join-Path $TempRoot ([System.IO.Path]::GetRandomFileName()))
)
$TempPrefix = $TempRoot + [System.IO.Path]::DirectorySeparatorChar
if (-not $ExtractDir.StartsWith($TempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "临时解压目录不在系统临时目录内"
}
New-Item -ItemType Directory -Force -Path $ExtractDir | Out-Null
try {
    Expand-Archive -Path $FfmpegZip -DestinationPath $ExtractDir -Force

    # 同一锁定归档必须恰好提供一对来自同一 bin 目录的工具。
    $FfmpegMatches = @(Get-ChildItem -LiteralPath $ExtractDir -Recurse -File -Filter "ffmpeg.exe")
    $FfprobeMatches = @(Get-ChildItem -LiteralPath $ExtractDir -Recurse -File -Filter "ffprobe.exe")
    if ($FfmpegMatches.Count -ne 1) {
        throw "压缩包中的 ffmpeg.exe 数量应为 1，实际为 $($FfmpegMatches.Count)"
    }
    if ($FfprobeMatches.Count -ne 1) {
        throw "压缩包中的 ffprobe.exe 数量应为 1，实际为 $($FfprobeMatches.Count)"
    }
    $FfmpegExe = $FfmpegMatches[0]
    $FfprobeExe = $FfprobeMatches[0]
    if ($FfmpegExe.Directory.FullName -ne $FfprobeExe.Directory.FullName) {
        throw "ffmpeg.exe 与 ffprobe.exe 不在同一归档 bin 目录"
    }

    $InstalledFfmpeg = Join-Path $Dest "ffmpeg.exe"
    $InstalledFfprobe = Join-Path $Dest "ffprobe.exe"
    Copy-Item -Force -LiteralPath $FfmpegExe.FullName -Destination $InstalledFfmpeg
    Copy-Item -Force -LiteralPath $FfprobeExe.FullName -Destination $InstalledFfprobe

    $FfmpegVersionOutput = @(& $InstalledFfmpeg -version 2>&1)
    $FfmpegVersionExitCode = $LASTEXITCODE
    $FfmpegVersionOutput | Select-Object -First 1 | Write-Host
    if ($FfmpegVersionExitCode -ne 0) {
        throw "已安装的 ffmpeg.exe -version 检查失败"
    }
    $FfprobeVersionOutput = @(& $InstalledFfprobe -version 2>&1)
    $FfprobeVersionExitCode = $LASTEXITCODE
    $FfprobeVersionOutput | Select-Object -First 1 | Write-Host
    if ($FfprobeVersionExitCode -ne 0) {
        throw "已安装的 ffprobe.exe -version 检查失败"
    }
}
finally {
    if (Test-Path -LiteralPath $ExtractDir) {
        Remove-Item -LiteralPath $ExtractDir -Recurse -Force
    }
    if (Test-Path -LiteralPath $FfmpegZip) {
        Remove-Item -LiteralPath $FfmpegZip -Force
    }
}

Write-Host "==> 完成: $Dest"
Get-ChildItem $Dest
