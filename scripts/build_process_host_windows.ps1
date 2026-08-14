<#
.SYNOPSIS
  Build and verify DownanyProcessHost on Windows x64.

  This script never substitutes an uncontained node/python process and never
  leaves a placeholder resource when CMake or Visual Studio is unavailable.
#>
[CmdletBinding()]
param([switch]$VerifyExecutable)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Source = Join-Path $Root "native\process-host"
$Build = Join-Path $Root ".build\process-host-windows"
$Resource = Join-Path $Root "desktop\resources\process-host"
$Executable = Join-Path $Resource "DownanyProcessHost.exe"

function Fail([string]$Message) { throw "ProcessHost build failed: $Message" }
function Assert-Contained([string]$Path) {
  $rootFull = [IO.Path]::GetFullPath((Join-Path $Root '.build'))
  $pathFull = [IO.Path]::GetFullPath($Path)
  $separator = [IO.Path]::DirectorySeparatorChar
  $prefix = $rootFull.TrimEnd($separator) + $separator
  if (-not $pathFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { Fail "refusing path outside .build: $Path" }
  if ($pathFull -eq $rootFull) { Fail "refusing to clean the .build root" }
}
function Require-Command([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $cmd) { Fail "missing $Name.exe; cannot produce a fake ProcessHost resource" }
  return $cmd.Source
}

$Cmake = Require-Command "cmake"
if (-not (Test-Path -LiteralPath $Source -PathType Container)) { Fail "missing source directory $Source" }
$VsWhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $VsWhere -PathType Leaf)) { Fail "missing Visual Studio vswhere.exe" }
$Vs = & $VsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $Vs) { Fail "missing an x64 MSVC toolchain" }

if ($VerifyExecutable) {
  if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { Fail "missing $Executable" }
  $bytes = (Get-Item -LiteralPath $Executable).Length
  if ($bytes -le 4096) { Fail "ProcessHost file is too small; refusing a placeholder" }
  Write-Output (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash.ToLowerInvariant()
  exit 0
}

Assert-Contained $Build
if (Test-Path -LiteralPath $Build) { Remove-Item -LiteralPath $Build -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Build, $Resource | Out-Null

& $Cmake -S $Source -B $Build -A x64 -DCMAKE_BUILD_TYPE=Release -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded
if ($LASTEXITCODE -ne 0) { Fail "CMake configure returned non-zero" }
& $Cmake --build $Build --config Release --target DownanyProcessHost -- /m
if ($LASTEXITCODE -ne 0) { Fail "CMake build returned non-zero" }
$Built = Join-Path $Build "Release\DownanyProcessHost.exe"
if (-not (Test-Path -LiteralPath $Built -PathType Leaf)) { Fail "build output does not exist: $Built" }

$Temp = Join-Path $Resource (".DownanyProcessHost.$PID.tmp")
try {
  if (Test-Path -LiteralPath $Temp) { Remove-Item -LiteralPath $Temp -Force }
  Copy-Item -LiteralPath $Built -Destination $Temp
  Move-Item -LiteralPath $Temp -Destination $Executable -Force
  $hash = (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash.ToLowerInvariant()
  $manifest = [ordered]@{
    schemaVersion = 1
    platform = "win32-x64"
    sourceDisposition = "project_source"
    executable = "DownanyProcessHost.exe"
    sha256 = $hash
    bytes = (Get-Item -LiteralPath $Executable).Length
  } | ConvertTo-Json -Compress
  $manifestPath = Join-Path $Resource "process-host-manifest.json"
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $manifestText = $manifest + [Environment]::NewLine
  [IO.File]::WriteAllText($manifestPath, $manifestText, $utf8)
} finally {
  if (Test-Path -LiteralPath $Temp) { Remove-Item -LiteralPath $Temp -Force -ErrorAction SilentlyContinue }
}
Write-Output ('ProcessHost ready: {0} ({1})' -f $Executable, $hash)
