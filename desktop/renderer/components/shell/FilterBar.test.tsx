import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "../../store/appStore";
import { taskFixture } from "../../test/taskFixture";
import { FilterBar } from "./FilterBar";

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({
    filter: "all",
    tasks: [
      taskFixture({ id: "1", status: "downloading" }),
      taskFixture({ id: "2", status: "paused" }),
      taskFixture({ id: "3", status: "completed" }),
    ],
  });
});

describe("FilterBar", () => {
  it("shows counts and a single selected tab", () => {
    render(<FilterBar />);
    expect(screen.getByRole("tab", { name: "全部 3" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "进行中 2" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "已完成 1" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "下载记录" })).toBeInTheDocument();
  });

  it("changes the store filter", () => {
    render(<FilterBar />);
    fireEvent.click(screen.getByRole("tab", { name: "进行中 2" }));
    expect(useAppStore.getState().filter).toBe("active");
  });
});
