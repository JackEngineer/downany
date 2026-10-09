import fs from "node:fs";
import process from "node:process";

import { evaluateManualAcceptance } from "./v031_manual_acceptance.mjs";

const args = process.argv.slice(2);
const versions = args.filter((arg) => arg.startsWith("--expected-version="));
const paths = args.filter((arg) => !arg.startsWith("--"));
if (!paths.length) {
  console.error("用法：node scripts/evaluate_v031_manual_acceptance.mjs <人工验收记录.json> [--expected-version=<major.minor.patch>]");
  process.exitCode = 2;
} else if (paths.length !== 1 || versions.length > 1
  || args.some((arg) => arg.startsWith("--") && !arg.startsWith("--expected-version="))) {
  console.error("人工验收参数包含未知选项、重复版本或多份记录。");
  process.exitCode = 2;
} else {
  try {
    const evidence = JSON.parse(fs.readFileSync(paths[0], "utf8"));
    const options = versions.length ? { expectedVersion: versions[0].slice("--expected-version=".length) } : {};
    const report = evaluateManualAcceptance(evidence, options);
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "人工验收无法完成。");
    process.exitCode = 2;
  }
}
