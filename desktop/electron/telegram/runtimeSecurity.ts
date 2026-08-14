import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import type { TelegramPathSecurityDeps } from "./paths";

const execFileAsync = promisify(execFile);
const WINDOWS_SID = /^S-1-[0-9-]+$/;

async function windowsSid(): Promise<string> {
  const result = await execFileAsync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { windowsHide: true, maxBuffer: 16 * 1024 });
  const match = result.stdout.match(/S-1-[0-9-]+/);
  if (!match || !WINDOWS_SID.test(match[0])) throw new Error("无法确定当前 Windows 用户 SID");
  return match[0];
}

async function runWindowsAcl(pathValue: string, args: string[]): Promise<void> {
  await execFileAsync("icacls.exe", [pathValue, ...args], { windowsHide: true, maxBuffer: 64 * 1024 });
}

async function inspectWindowsAcl(pathValue: string): Promise<{ inheritanceDisabled: boolean; allowSids: string[]; fullControlSids: string[] }> {
  const script = [
    "$acl=Get-Acl -LiteralPath $args[0]",
    "$rules=@($acl.Access | ForEach-Object { try { $sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $sid=$_.IdentityReference.Value }; [pscustomobject]@{sid=$sid; inherited=[bool]$_.IsInherited; type=$_.AccessControlType.ToString(); rights=$_.FileSystemRights.ToString()} })",
    "[pscustomobject]@{protected=[bool]$acl.AreAccessRulesProtected;rules=$rules} | ConvertTo-Json -Compress -Depth 6",
  ].join(";");
  const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, pathValue], { windowsHide: true, maxBuffer: 256 * 1024 });
  const parsed = JSON.parse(result.stdout) as { protected?: boolean; rules?: Array<{ sid?: string; inherited?: boolean; type?: string; rights?: string }> | { sid?: string; inherited?: boolean; type?: string; rights?: string } };
  const rules = Array.isArray(parsed.rules) ? parsed.rules : parsed.rules ? [parsed.rules] : [];
  const allow = rules.filter((rule) => rule.type === "Allow");
  return {
    inheritanceDisabled: parsed.protected === true && rules.every((rule) => rule.inherited !== true),
    allowSids: allow.map((rule) => String(rule.sid || "")),
    fullControlSids: allow.filter((rule) => /FullControl/i.test(String(rule.rights || ""))).map((rule) => String(rule.sid || "")),
  };
}

export async function createNodeTelegramPathSecurity(platform: "darwin" | "win32"): Promise<TelegramPathSecurityDeps> {
  const currentUserSid = platform === "win32" ? await windowsSid() : null;
  return {
    platform,
    currentUserSid,
    async inspectPath(value: string) {
      try {
        const stat = await fs.lstat(value);
        return {
          exists: true,
          kind: stat.isDirectory() ? "directory" as const : stat.isFile() ? "file" as const : "other" as const,
          isLinkOrReparsePoint: stat.isSymbolicLink(),
          posixMode: platform === "darwin" ? stat.mode & 0o777 : null,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          return { exists: false, kind: "other" as const, isLinkOrReparsePoint: false, posixMode: null };
        }
        throw error;
      }
    },
    async createDirectory(value: string, mode: 0o700) {
      await fs.mkdir(value, { recursive: true, mode });
      if (platform === "darwin") await fs.chmod(value, mode);
    },
    async createFile(value: string, mode: 0o600) {
      await fs.mkdir(path.dirname(value), { recursive: true, mode: 0o700 });
      const handle = await fs.open(value, "wx", mode);
      await handle.close();
      if (platform === "darwin") await fs.chmod(value, mode);
    },
    async chmod(value: string, mode: 0o700 | 0o600) {
      await fs.chmod(value, mode);
    },
    async applyWindowsAcl(value: string, kind: "directory" | "file", sid: string) {
      if (platform !== "win32" || !WINDOWS_SID.test(sid)) throw new Error("Windows ACL 参数无效");
      const system = kind === "directory" ? "S-1-5-18:(OI)(CI)F" : "S-1-5-18:F";
      const user = kind === "directory" ? `${sid}:(OI)(CI)F` : `${sid}:F`;
      await runWindowsAcl(value, ["/inheritance:r", "/grant:r", user, system]);
    },
    async inspectWindowsAcl(value: string) {
      if (platform !== "win32") return { inheritanceDisabled: true, allowSids: [], fullControlSids: [] };
      return inspectWindowsAcl(value);
    },
  };
}
