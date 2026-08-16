import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const tokenPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../design-system/tokens.css",
);
const rendererRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function cssFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return cssFiles(target);
    return entry.isFile() && entry.name.endsWith(".css") ? [target] : [];
  });
}

const requiredTokens = [
  "--gray-1000",
  "--gray-950",
  "--gray-900",
  "--blue-500",
  "--color-surface-window",
  "--color-surface-chrome",
  "--color-surface-raised",
  "--color-surface-control",
  "--color-text-primary",
  "--color-text-secondary",
  "--color-text-on-media",
  "--color-text-on-media-secondary",
  "--color-text-on-media-tertiary",
  "--color-stroke-subtle",
  "--color-stroke-strong",
  "--color-accent",
  "--color-accent-soft",
  "--color-success",
  "--color-warning",
  "--color-danger",
  "--color-focus-ring",
  "--space-0-5",
  "--space-1",
  "--space-2",
  "--space-3",
  "--space-4",
  "--space-5",
  "--space-6",
  "--space-8",
  "--space-10",
  "--radius-small",
  "--material-task-glass-width",
  "--material-task-glass-blur",
  "--material-task-glass-saturate",
  "--material-task-glass-tint",
  "--material-task-glass-tint-dark",
  "--material-task-glass-tint-medium",
  "--material-task-glass-tint-light",
  "--material-task-glass-tint-weak-dark",
  "--material-task-glass-tint-weak-medium",
  "--material-task-glass-tint-weak-light",
  "--material-task-glass-lift",
  "--material-task-glass-fallback",
  "--material-task-ambient-weak-blur",
  "--material-task-ambient-weak-brightness",
  "--material-task-ambient-weak-saturate",
  "--material-task-ambient-weak-scale",
  "--material-task-focus-width",
  "--material-task-focus-feather",
  "--material-task-shade",
  "--material-task-progress-track",
  "--material-action-glass-highlight",
  "--material-action-media-fill",
  "--material-action-media-fill-hover",
  "--material-action-media-fill-pressed",
  "--material-action-media-fill-opaque",
  "--material-action-media-stroke",
  "--material-action-media-stroke-focus",
  "--material-action-media-text",
  "--material-action-media-highlight",
  "--material-media-placeholder-start",
  "--material-media-placeholder-middle",
  "--material-media-placeholder-end",
  "--motion-fast",
  "--motion-normal",
  "--motion-slow",
  "--ease-standard",
  "--radius-control",
  "--radius-banner",
  "--radius-popover",
  "--radius-dialog",
  "--control-height-small",
  "--control-height",
] as const;

const aliasPairs = [
  ["--bg", "--color-surface-window"],
  ["--panel", "--color-surface-control"],
  ["--panel-solid", "--color-surface-raised"],
  ["--text", "--color-text-primary"],
  ["--muted", "--color-text-secondary"],
  ["--line", "--color-stroke-subtle"],
  ["--accent", "--color-accent"],
  ["--accent-soft", "--color-accent-soft"],
  ["--danger", "--color-danger"],
  ["--hover", "--color-surface-control-hover"],
  ["--success", "--color-success"],
  ["--warning", "--color-warning"],
  ["--focus-ring", "--color-focus-ring"],
] as const;

describe("design token contract", () => {
  it("has one canonical token source", () => {
    expect(existsSync(tokenPath)).toBe(true);
  });

  it("defines required semantic tokens, both themes and temporary aliases", () => {
    const css = readFileSync(tokenPath, "utf8");
    for (const token of requiredTokens) expect(css).toContain(`${token}:`);
    expect(css).toContain('html[data-theme="dark"]');
    expect(css).toContain('html[data-theme="light"]');
    for (const [alias, target] of aliasPairs) {
      expect(css).toContain(`${alias}: var(${target})`);
    }
  });

  it("defines every CSS custom property reference or provides an inline fallback", () => {
    const files = [tokenPath, ...cssFiles(rendererRoot)];
    const sources = files.map((file) => ({ file, css: readFileSync(file, "utf8") }));
    const definitions = new Set<string>();
    for (const { css } of sources) {
      for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:/gi)) {
        definitions.add(match[1]);
      }
    }

    const missing: string[] = [];
    for (const { file, css } of sources) {
      for (const match of css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(?=,|\))/gi)) {
        const token = match[1];
        const afterToken = css.slice((match.index ?? 0) + match[0].length).trimStart();
        const hasFallback = afterToken.startsWith(",");
        if (!definitions.has(token) && !hasFallback) {
          missing.push(`${path.relative(rendererRoot, file)}: ${token}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
