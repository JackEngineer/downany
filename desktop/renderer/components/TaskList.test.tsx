import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppSettings } from "../lib/types";
import { useAppStore } from "../store/appStore";
import { taskFixture } from "../test/taskFixture";
import { TaskList } from "./TaskList";

const settings: AppSettings = {
  download_dir: "D:/Downloads",
  concurrent_downloads: 2,
  speed_limit: 0,
  proxy_enabled: false,
  proxy_url: "",
  default_quality: "best",
  download_subtitles: false,
  theme_mode: "system",
};

afterEach(cleanup);

beforeEach(() => {
  (window as unknown as { api: Record<string, unknown> }).api = {
    openPath: () => Promise.resolve(),
    showTaskContextMenu: () => Promise.resolve(null),
  };
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

  it("hydrates one ordered playlist group and opens its restored final path", () => {
    const opened: string[] = [];
    window.api.openPath = async (path) => {
      opened.push(path);
    };
    useAppStore.getState().hydrateSnapshot({
      settings,
      tasks: [
        taskFixture({
          id: "group-third",
          title: "第三集",
          status: "paused",
          queue_order: 1,
          group_id: "group-one",
          group_title: "恢复后的合集",
          playlist_index: 3,
        }),
        taskFixture({
          id: "ordinary",
          title: "普通视频",
          status: "completed",
          progress: 100,
          queue_order: 2,
          file_path: "D:/Downloads/普通视频.mp4",
        }),
        taskFixture({
          id: "group-first",
          title: "第一集",
          status: "completed",
          progress: 100,
          queue_order: 3,
          file_path: "D:/Downloads/恢复后的合集/001 - 第一集.mp4",
          completion_note: "字幕已保存为独立文件",
          group_id: "group-one",
          group_title: "恢复后的合集",
          playlist_index: 1,
        }),
      ],
    });

    const { container } = render(<TaskList />);

    expect(container.querySelectorAll(".playlist-group")).toHaveLength(1);
    expect(
      Array.from(
        container.querySelectorAll(
          ".playlist-group-list .media-task-banner__title",
        ),
      ).map((element) => element.textContent),
    ).toEqual(["第一集", "第三集"]);
    expect(container.querySelector("#task-ordinary")?.closest(".playlist-group")).toBeNull();

    const completedRow = container.querySelector("#task-group-first");
    expect(completedRow).not.toBeNull();
    fireEvent.click(
      within(completedRow as HTMLElement).getByRole("button", { name: "打开" }),
    );
    expect(opened).toEqual([
      "D:/Downloads/恢复后的合集/001 - 第一集.mp4",
    ]);
  });
});
