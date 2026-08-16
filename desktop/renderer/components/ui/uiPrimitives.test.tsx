import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Button, IconButton } from "./Button";
import { FilterTab } from "./FilterTab";
import { TextField } from "./TextField";

afterEach(cleanup);

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

  it("exposes a selected filter tab and its count", () => {
    render(
      <FilterTab selected label="进行中" count={2} onSelect={() => undefined} />,
    );
    expect(screen.getByRole("tab", { name: "进行中 2" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("supports keyboard activation for filter tabs", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(<FilterTab selected={false} label="全部" onSelect={onSelect} />);
    await user.tab();
    const tab = screen.getByRole("tab", { name: "全部" });
    expect(tab).toHaveFocus();

    await user.keyboard("[Space]");
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("renders a labelled field with a leading icon", () => {
    render(<TextField aria-label="视频链接" leadingIcon="link" />);
    expect(screen.getByRole("textbox", { name: "视频链接" })).toBeInTheDocument();
    expect(document.querySelector('[data-icon="link"]')).toBeInTheDocument();
  });

  it("defines visible focus rules for interactive primitives", () => {
    const testFilePath = fileURLToPath(import.meta.url);
    const cssPath = resolve(dirname(testFilePath), "../../styles/ui.css");
    const css = readFileSync(cssPath, "utf8");

    expect(css).toContain(".ui-button:focus-visible");
    expect(css).toContain(".ui-icon-button:focus-visible");
    expect(css).toContain(".ui-filter-tab:focus-visible");
    expect(css).toContain("box-shadow: 0 0 0 2px var(--color-focus-ring);");
  });
});
