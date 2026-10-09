/** NSIS /D does not isolate the account's install identity or shell integration. */
import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const REGISTRY_IDS = ["hkcu", "hklm"].flatMap((hive) => ["32", "64"].flatMap((view) =>
  ["install", "uninstall", "protocol"].map((kind) => `registry.${hive}.${view}.${kind}`)));
const REQUIRED_IDS = new Set([...REGISTRY_IDS,
  "shortcut.desktop", "shortcut.commonDesktop", "shortcut.programs", "shortcut.commonPrograms",
  "directory.localPrograms", "directory.programFiles", "directory.programFilesX86", "cache.installer",
  "process.downany",
]);

// Only existence is read: no registry values, link targets, process command lines,
// file contents, or credentials. Missing is distinct from unreadable.
const PROBE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitProcess) { throw 'Unsupported probe host.' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DownanyRegistryProbe {
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
    static extern int RegOpenKeyExW(IntPtr hive, string subKey, uint options, uint access, out IntPtr key);
    [DllImport("advapi32.dll", ExactSpelling=true)]
    static extern int RegCloseKey(IntPtr key);
    public static int ReadCode(int hive, int view, string subKey) {
        if ((hive != 1 && hive != 2) || (view != 32 && view != 64)) return -1;
        // Windows predefined HKEYs are sign-extended LONG values on 64-bit.
        IntPtr root = new IntPtr(hive == 1 ? unchecked((int)0x80000001) : unchecked((int)0x80000002));
        IntPtr key = IntPtr.Zero;
        uint access = 0x20019u | (view == 32 ? 0x200u : 0x100u); // KEY_READ plus explicit WOW64 view
        int code = RegOpenKeyExW(root, subKey, 0u, access, out key);
        if (code != 0) return code;
        if (key == IntPtr.Zero) return -1;
        // A close failure is never evidence that the key was absent.
        return RegCloseKey(key) == 0 ? 0 : -1;
    }
}
'@
$checks = New-Object 'System.Collections.Generic.List[object]'
$hives = @(@{ id = 'hkcu'; value = 1 }, @{ id = 'hklm'; value = 2 })
$views = @(32, 64)
# UUID.v5(appId, UUID.parse(electron-builder namespace)); stable across versions.
$keys = @(
    @{ id = 'install'; path = 'Software\1c5b01c0-7b3b-5df5-9608-c39d71f5f2c0' },
    @{ id = 'uninstall'; path = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\1c5b01c0-7b3b-5df5-9608-c39d71f5f2c0' },
    @{ id = 'protocol'; path = 'Software\Classes\downany' }
)
foreach ($hive in $hives) {
    foreach ($view in $views) {
        foreach ($entry in $keys) {
            $code = -1
            try { $code = [DownanyRegistryProbe]::ReadCode($hive.value, $view, $entry.path) }
            catch { $code = -1 }
            $checks.Add(@{ id = ('registry.' + $hive.id + '.' + $view + '.' + $entry.id); win32Code = $code })
        }
    }
}
function Add-PathCheck([string]$Id, [string]$Folder, [string]$Relative) {
    $state = 'error'
    try {
        $base = [Environment]::GetFolderPath([Environment+SpecialFolder]$Folder)
        if ([string]::IsNullOrWhiteSpace($base) -or -not [IO.Path]::IsPathRooted($base)) { throw 'Known folder unavailable.' }
        $null = [IO.File]::GetAttributes((Join-Path $base $Relative))
        $state = 'present'
    } catch {
        $cause = $_.Exception.GetBaseException()
        if ($cause -is [IO.FileNotFoundException] -or $cause -is [IO.DirectoryNotFoundException]) { $state = 'absent' }
    }
    $checks.Add(@{ id = $Id; state = $state })
}
Add-PathCheck 'shortcut.desktop' 'DesktopDirectory' 'Downany.lnk'
Add-PathCheck 'shortcut.commonDesktop' 'CommonDesktopDirectory' 'Downany.lnk'
Add-PathCheck 'shortcut.programs' 'Programs' 'Downany.lnk'
Add-PathCheck 'shortcut.commonPrograms' 'CommonPrograms' 'Downany.lnk'
Add-PathCheck 'directory.localPrograms' 'LocalApplicationData' 'Programs\Downany'
Add-PathCheck 'directory.programFiles' 'ProgramFiles' 'Downany'
Add-PathCheck 'directory.programFilesX86' 'ProgramFilesX86' 'Downany'
Add-PathCheck 'cache.installer' 'LocalApplicationData' 'downany-desktop-updater\installer.exe'
$state = 'error'
try {
    $processes = @(Get-CimInstance -ClassName Win32_Process -Property Name -Filter "Name='Downany.exe' OR Name='DownanySidecar.exe' OR Name='Uninstall Downany.exe' OR Name LIKE 'Downany-%.exe'" -ErrorAction Stop)
    $state = if ($processes.Count -eq 0) { 'absent' } else { 'present' }
} catch { $state = 'error' }
$checks.Add(@{ id = 'process.downany'; state = $state })
@{ schemaVersion = 1; platform = 'win32'; arch = 'x64'; checks = @($checks.ToArray()) } | ConvertTo-Json -Depth 5 -Compress
`;

function hasKeys(value, keys) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validReport(report) {
  if (!hasKeys(report, ["schemaVersion", "platform", "arch", "checks"]) ||
      report.schemaVersion !== 1 || report.platform !== "win32" || report.arch !== "x64" ||
      !Array.isArray(report.checks) || report.checks.length !== REQUIRED_IDS.size) return false;
  const seen = new Set();
  for (const check of report.checks) {
    if (!hasKeys(check, ["id", "state"]) || !REQUIRED_IDS.has(check.id) || seen.has(check.id) ||
        !["absent", "present", "error"].includes(check.state)) return false;
    seen.add(check.id);
  }
  return seen.size === REQUIRED_IDS.size;
}

function normalizeProbeReport(report) {
  if (!hasKeys(report, ["schemaVersion", "platform", "arch", "checks"]) || !Array.isArray(report.checks)) return null;
  const checks = report.checks.map((check) => {
    if (!REGISTRY_IDS.includes(check?.id)) return check;
    if (!hasKeys(check, ["id", "win32Code"]) || !Number.isInteger(check.win32Code) ||
        check.win32Code < -2147483648 || check.win32Code > 2147483647) return null;
    const state = check.win32Code === 0 ? "present" : [2, 3].includes(check.win32Code) ? "absent" : "error";
    return { id: check.id, state };
  });
  return { ...report, checks };
}

export function assertWindowsNsisPreflight(report) {
  if (!validReport(report)) throw new Error("Windows installer preflight blocked: invalid or incomplete report");
  const blocked = report.checks.filter((check) => check.state !== "absent");
  if (blocked.length) {
    throw new Error(`Windows installer preflight blocked: ${blocked.map((check) => check.id).join(", ")}`);
  }
  return report;
}

/** 卸载后允许 electron-builder 保留安装器缓存；其余安装状态必须已消失。 */
export function evaluateWindowsNsisUninstall(report) {
  if (!validReport(report)) throw new Error("Windows uninstall verification blocked: invalid or incomplete report");
  const blocked = report.checks.filter((check) => check.id === "cache.installer"
    ? check.state === "error" : check.state !== "absent");
  const cacheState = report.checks.find((check) => check.id === "cache.installer").state;
  return {
    uninstallVerified: blocked.length === 0,
    installerCache: cacheState === "present" ? "retained" : cacheState === "absent" ? "absent" : "unverified",
    checks: report.checks.map(({ id, state }) => ({ id, state })),
    blocked: blocked.map(({ id }) => id),
  };
}

export async function collectWindowsNsisPreflight({
  runPowerShell = runFile, platform = process.platform, arch = process.arch, systemRoot = process.env.SystemRoot,
  timeoutMs = 20_000,
} = {}) {
  try {
    if (platform !== "win32" || arch !== "x64" || typeof systemRoot !== "string" || !path.win32.isAbsolute(systemRoot)) {
      throw new Error("Unsupported probe host");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) throw new Error("Invalid probe bound");
    const executable = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const { stdout, stderr } = await runPowerShell(executable, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(PROBE, "utf16le").toString("base64"),
    ], { windowsHide: true, shell: false, timeout: timeoutMs, maxBuffer: 64 * 1024, encoding: "utf8" });
    if (typeof stdout !== "string" || typeof stderr !== "string" || stderr.trim()) throw new Error("Invalid probe output");
    const report = normalizeProbeReport(JSON.parse(stdout.trim()));
    if (!validReport(report)) throw new Error("Incomplete probe report");
    return report;
  } catch {
    // OS errors and PowerShell diagnostics can contain private paths or values.
    throw new Error("Windows installer preflight unavailable; installation refused");
  }
}
