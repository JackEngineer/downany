import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WindowChrome } from "./WindowChrome";

afterEach(cleanup);

describe("WindowChrome", () => {
  it("renders only the product title on macOS", () => {
    render(<WindowChrome platform="darwin" />);
    expect(screen.getByText("Downany · 百纳")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("defers to the native title bar on Windows", () => {
    const { container } = render(<WindowChrome platform="win32" />);
    expect(container).toBeEmptyDOMElement();
  });
});
