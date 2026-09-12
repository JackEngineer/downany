"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "install.css"), "utf8");
assert.match(
  css,
  /\[hidden\]\s*\{[^}]*display:\s*none\s*!important\s*;?[^}]*\}/s,
  "连接成功后，hidden 下载入口必须覆盖组件的 display 样式",
);

console.log("install hidden-state test passed");
