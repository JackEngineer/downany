import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const tokenPath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../../design-system/tokens.css",
);

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
  "--material-task-glass-lift",
  "--material-task-glass-fallback",
  "--material-task-shade",
  "--material-task-progress-track",
  "--material-action-glass-highlight",
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
});
