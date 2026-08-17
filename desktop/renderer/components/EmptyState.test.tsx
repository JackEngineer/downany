import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "../store/appStore";
import { EmptyState } from "./EmptyState";

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ addFocusSignal: 0 });
});

describe("EmptyState", () => {
  it("offers one primary action that focuses link intake", () => {
    render(<EmptyState />);

    expect(screen.getAllByRole("button")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "粘贴视频链接" }));

    expect(useAppStore.getState().addFocusSignal).toBe(1);
    expect(document.querySelector('[data-icon="download"]')).toBeInTheDocument();
  });
});
