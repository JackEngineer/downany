import { describe, expect, it, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Sidebar } from "./Sidebar";
import { useAppStore } from "../store/appStore";

describe("Sidebar", () => {
  beforeEach(() => {
    useAppStore.setState({
      route: "new",
      tasks: [],
      connection: "connected",
      settings: null,
      logDir: "",
      toasts: [],
    });
  });

  it("switches route on click", async () => {
    const user = userEvent.setup();
    render(<Sidebar compact={false} />);
    await user.click(screen.getByRole("button", { name: /下载队列/ }));
    expect(useAppStore.getState().route).toBe("queue");
  });
});
