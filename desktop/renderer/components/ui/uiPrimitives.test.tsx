import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import "../../styles.css";
import { Button, IconButton } from "./Button";
import { FilterTab } from "./FilterTab";
import { TextField } from "./TextField";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const designTokens = readFileSync(
  resolve(testDirectory, "../../../../design-system/tokens.css"),
  "utf8",
);
const uiStyles = readFileSync(resolve(testDirectory, "../../styles/ui.css"), "utf8");
const appStyles = readFileSync(
  resolve(testDirectory, "../../styles.css"),
  "utf8",
).replace(/^@import .*;$/gm, "");

function installUiCascade(): void {
  const style = document.createElement("style");
  style.dataset.testStyles = "ui-primitives-cascade";
  style.textContent = `${designTokens}\n${uiStyles}\n${appStyles}`;
  document.head.append(style);
}

afterEach(() => {
  cleanup();
  document
    .querySelectorAll('[data-test-styles="ui-primitives-cascade"]')
    .forEach((style) => style.remove());
});

describe("UI primitives", () => {
  it("keeps a loading button named and disabled", () => {
    render(<Button loading>添加</Button>);
    const button = screen.getByRole("button", { name: "添加" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it("gives an icon-only button an accessible name", () => {
    render(<IconButton icon="settings" label="设置" />);
    expect(screen.getByRole("button", { name: "设置" })).toHaveAttribute(
      "title",
      "设置",
    );
  });

  it("supports keyboard activation for buttons", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();

    render(<Button onClick={onClick}>添加</Button>);
    await user.tab();
    const button = screen.getByRole("button", { name: "添加" });
    expect(button).toHaveFocus();

    await user.keyboard("[Enter]");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("exposes a pressed filter button and its count", () => {
    render(
      <FilterTab selected label="进行中" count={2} onSelect={() => undefined} />,
    );
    expect(screen.getByRole("button", { name: "进行中 2" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("supports keyboard activation for filter buttons", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(<FilterTab selected={false} label="全部" onSelect={onSelect} />);
    await user.tab();
    const button = screen.getByRole("button", { name: "全部" });
    expect(button).toHaveFocus();

    await user.keyboard("[Space]");
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("renders a labelled field with a leading icon", () => {
    render(<TextField aria-label="视频链接" leadingIcon="link" />);
    expect(screen.getByRole("textbox", { name: "视频链接" })).toBeInTheDocument();
    expect(document.querySelector('[data-icon="link"]')).toBeInTheDocument();
  });

  it("uses the TextField shell as the only visible input chrome", () => {
    installUiCascade();
    render(<TextField aria-label="视频链接" leadingIcon="link" />);
    const input = screen.getByRole("textbox", { name: "视频链接" });
    const shell = input.closest(".ui-text-field");
    input.focus();
    const computed = getComputedStyle(input);

    expect(document.querySelectorAll(".ui-text-field")).toHaveLength(1);
    expect(shell).not.toBeNull();
    expect(shell?.querySelectorAll("input")).toHaveLength(1);
    expect(computed.appearance).toBe("none");
    expect(computed.borderTopWidth).toBe("0px");
    expect(computed.boxShadow).toBe("none");
  });

  it("defines visible focus rules for interactive primitives", () => {
    expect(uiStyles).toContain(".ui-button:focus-visible");
    expect(uiStyles).toContain(".ui-icon-button:focus-visible");
    expect(uiStyles).toContain(".ui-filter-tab:focus-visible");
    expect(uiStyles).toContain("box-shadow: 0 0 0 2px var(--color-focus-ring);");
  });
});
