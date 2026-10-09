import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionVersion = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "browser-extension", "manifest.json"), "utf8")).version;
const buildScript = path.join(repositoryRoot, "scripts", "build_chrome_extension_zip.sh");

test("builds a versioned extension ZIP without tests or hidden files", (t) => {
  const tools = spawnSync("bash", ["-c",
    'for tool in zip unzip shasum; do if ! command -v "$tool" >/dev/null 2>&1; then printf "%s\n" "$tool"; fi; done'], {
    encoding: "utf8", timeout: 10000, windowsHide: true,
  });
  if (tools.error?.code === "ENOENT") {
    t.skip("扩展 ZIP shell 测试缺少 bash；工具齐全的平台仍验证真实打包字节。");
    return;
  }
  assert.equal(tools.status, 0, `${tools.stdout}\n${tools.stderr}`);
  const missingTools = tools.stdout.trim().split(/\r?\n/).filter(Boolean);
  const unzip = spawnSync("unzip", ["-v"], {
    encoding: "utf8", timeout: 10000, windowsHide: true,
  });
  if (unzip.error?.code === "ENOENT" && !missingTools.includes("unzip")) missingTools.push("unzip");
  if (missingTools.length) {
    t.skip(`扩展 ZIP shell 测试缺少 ${missingTools.join("、")}；工具齐全的平台仍验证真实打包字节。`);
    return;
  }
  assert.equal(unzip.status, 0, `${unzip.stdout}\n${unzip.stderr}`);

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "downany-extension-package-"));
  try {
    const relativeOutputDir = path.relative(repositoryRoot, outputDir);
    const build = spawnSync("bash", [buildScript, relativeOutputDir], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

    const artifact = path.join(outputDir, `Downany-chrome-extension-${extensionVersion}.zip`);
    assert.equal(fs.statSync(artifact).size > 0, true);
    const listing = spawnSync("unzip", ["-Z1", artifact], { encoding: "utf8" });
    assert.equal(listing.status, 0, listing.stderr);
    const entries = listing.stdout.trim().split("\n");
    assert.equal(entries.includes("manifest.json"), true);
    assert.equal(entries.some((entry) => entry.endsWith(".test.js")), false);
    assert.equal(entries.some((entry) => entry.split("/").some((part) => part.startsWith("."))), false);

    const manifest = spawnSync("unzip", ["-p", artifact, "manifest.json"], { encoding: "utf8" });
    assert.equal(manifest.status, 0, manifest.stderr);
    assert.equal(JSON.parse(manifest.stdout).version, extensionVersion);

    const secondOutputDir = fs.mkdtempSync(path.join(outputDir, "repeat-"));
    const repeat = spawnSync("bash", [buildScript, secondOutputDir], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    assert.equal(repeat.status, 0, `${repeat.stdout}\n${repeat.stderr}`);
    assert.deepEqual(
      fs.readFileSync(path.join(secondOutputDir, `Downany-chrome-extension-${extensionVersion}.zip`)),
      fs.readFileSync(artifact),
    );
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
