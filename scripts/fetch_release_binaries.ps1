<#
.SYNOPSIS
  拉取发布用 yt-dlp.exe + ffmpeg.exe 到 desktop/resources/bin（Windows 原生 PowerShell 版）。

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

  ffmpeg.exe（BtbN/FFmpeg-Builds 静态构建，win64-gpl，选用已归档的日期化 tag
  而非浮动的 `latest`，保证长期可复现）：
    Release: https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-08-03-14-02
    资产:    ffmpeg-n7.1.5-12-g1fdbca85aa-win64-gpl-7.1.zip（ffmpeg 7.1.5，与 macOS 端
             scripts/install_ffmpeg.sh 默认的 7.1.1 同一大版本线）
    SHA256:  5559c3a40827c273d9eb1a783b67d43aaa364bc1e907d558fab6cd7dd24f2d63
             （核对自该 Release 附带的 checksums.sha256）
    可用环境变量 FFMPEG_WIN_URL / FFMPEG_WIN_SHA256 覆盖。
    zip 内层结构为 <asset-basename>\bin\ffmpeg.exe（含 ffprobe.exe 等），本脚本只
    抽取 ffmpeg.exe 落盘，保持产物精简。

.EXAMPLE
  .\scripts\fetch_release_binaries.ps1

.EXAMPLE
  $env:FFMPEG_WIN_SHA256 = "5559c3a40827c273d9eb1a783b67d43aaa364bc1e907d558fab6cd7dd24f2d63"
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

$FfmpegUrl = if ($env:FFMPEG_WIN_URL) { $env:FFMPEG_WIN_URL } else { "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-03-14-02/ffmpeg-n7.1.5-12-g1fdbca85aa-win64-gpl-7.1.zip" }
$FfmpegSha256 = $env:FFMPEG_WIN_SHA256

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

Write-Host "==> 下载 ffmpeg (Windows, BtbN static win64-gpl)"
Write-Host "    $FfmpegUrl"
$FfmpegZip = Join-Path $Dest "ffmpeg-win.zip"
Invoke-WebRequest -Uri $FfmpegUrl -OutFile $FfmpegZip -UseBasicParsing
$FfmpegActual = Get-FileSha256 -Path $FfmpegZip
Write-Host "ffmpeg zip SHA256: $FfmpegActual"
if ($FfmpegSha256 -and ($FfmpegActual -ne $FfmpegSha256.ToLowerInvariant())) {
    Remove-Item -Force $FfmpegZip
    throw "ffmpeg zip SHA256 校验失败：期望 $FfmpegSha256，实际 $FfmpegActual"
}

$ExtractDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $ExtractDir | Out-Null
Expand-Archive -Path $FfmpegZip -DestinationPath $ExtractDir -Force

# BtbN zip 内层结构为 <asset-basename>\bin\ffmpeg.exe，递归查找后只保留 ffmpeg.exe
$FfmpegExe = Get-ChildItem -Path $ExtractDir -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
if (-not $FfmpegExe) {
    Remove-Item -Recurse -Force $ExtractDir
    Remove-Item -Force $FfmpegZip
    throw "未在压缩包中找到 ffmpeg.exe"
}
Copy-Item -Force $FfmpegExe.FullName (Join-Path $Dest "ffmpeg.exe")

Remove-Item -Recurse -Force $ExtractDir
Remove-Item -Force $FfmpegZip

Write-Host "==> 完成: $Dest"
Get-ChildItem $Dest
