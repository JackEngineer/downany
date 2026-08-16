import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "../store/appStore";
import { taskFixture } from "../test/taskFixture";
import { TaskList } from "./TaskList";

afterEach(cleanup);

beforeEach(() => {
  useAppStore.setState({
    tasks: [],
    filter: "all",
    searchQuery: "",
    searchMode: "filter",
  });
});

describe("TaskList media density", () => {
  it("renders the empty state when there are no tasks", () => {
    render(<TaskList />);

    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "粘贴视频链接" }),
    ).toBeInTheDocument();
    expect(screen.getByText("添加第一个下载任务")).toBeInTheDocument();
  });

  it("renders standalone tasks as normal media banners", () => {
    useAppStore.setState({
      tasks: [taskFixture({ id: "solo", group_id: undefined })],
    });

    const { container } = render(<TaskList />);

    expect(container.querySelector("#task-solo")).toHaveClass(
      "media-task-banner--normal",
    );
  });

  it("renders playlist children as compact media banners", () => {
    useAppStore.setState({
      tasks: [
        taskFixture({ id: "grouped", group_id: "g1", group_title: "合集" }),
      ],
    });

    const { container } = render(<TaskList />);

    expect(container.querySelector("#task-grouped")).toHaveClass(
      "media-task-banner--compact",
    );
  });
});
