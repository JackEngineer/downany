import fs from "node:fs";
import process from "node:process";

import { evaluateManualAcceptance } from "./v031_manual_acceptance.mjs";

const [evidencePath] = process.argv.slice(2);
if (!evidencePath) {
  console.error("用法：node scripts/evaluate_v031_manual_acceptance.mjs <人工验收记录.json>");
  process.exitCode = 2;
} else {
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  const report = evaluateManualAcceptance(evidence);
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
