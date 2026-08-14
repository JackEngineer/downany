#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function value(name) {
  const result = String(process.env[name] || "").trim();
  if (!result) throw new Error(`missing ${name}`);
  return result;
}

const apiId = value("DOWNANY_TELEGRAM_API_ID");
const apiHash = value("DOWNANY_TELEGRAM_API_HASH");
if (!/^[1-9][0-9]*$/.test(apiId)) throw new Error("invalid api id");
if (!/^[0-9A-Fa-f]{32}$/.test(apiHash)) throw new Error("invalid api hash");

const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const output = outputArg ? outputArg.slice("--output=".length) : "desktop/resources/telegram-bot-api/app-credentials.json";
if (!path.isAbsolute(output)) throw new Error("output must be absolute");
const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, apiId, apiHash })}\n`, "utf8");
fs.mkdirSync(path.dirname(output), { recursive: true });
const temporary = `${output}.${process.pid}.tmp`;
try {
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, output);
} finally {
  try { fs.unlinkSync(temporary); } catch { /* already renamed */ }
}
process.stdout.write(`${output}\ncreated\n`);
