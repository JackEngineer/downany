import fs from "node:fs";
import process from "node:process";

import {
  evaluateReliabilityResults,
  validateReliabilityMatrix,
} from "./v031_acceptance_helpers.mjs";

const [matrixPath, resultsPath] = process.argv.slice(2);
if (!matrixPath) {
  console.error("用法：node scripts/evaluate_v031_acceptance.mjs <matrix.json> [results.json]");
  process.exitCode = 2;
} else {
  const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
  if (!resultsPath) {
    console.log(JSON.stringify(validateReliabilityMatrix(matrix), null, 2));
  } else {
    const results = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
    const report = evaluateReliabilityResults(matrix, results);
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  }
}
