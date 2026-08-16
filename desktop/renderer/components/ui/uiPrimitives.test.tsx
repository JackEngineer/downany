import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

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

  it("exposes a selected filter tab and its count", () => {
    render(
      <FilterTab selected label="进行中" count={2} onSelect={() => undefined} />,
    );
    expect(screen.getByRole("tab", { name: "进行中 2" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("renders a labelled field with a leading icon", () => {
    render(<TextField aria-label="视频链接" leadingIcon="link" />);
    expect(screen.getByRole("textbox", { name: "视频链接" })).toBeInTheDocument();
    expect(document.querySelector('[data-icon="link"]')).toBeInTheDocument();
  });
});
