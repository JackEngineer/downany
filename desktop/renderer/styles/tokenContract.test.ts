import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const tokenPath = path.resolve(process.cwd(), "..", "design-system", "tokens.css");

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
  "--color-accent",
  "--color-success",
  "--color-warning",
  "--color-danger",
  "--color-focus-ring",
  "--material-task-glass-width",
  "--material-task-glass-blur",
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
  "--radius-control",
  "--radius-banner",
  "--control-height",
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
    expect(css).toContain("--bg: var(--color-surface-window)");
    expect(css).toContain("--panel: var(--color-surface-control)");
    expect(css).toContain("--text: var(--color-text-primary)");
  });
});
