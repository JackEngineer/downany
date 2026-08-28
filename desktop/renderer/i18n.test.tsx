import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as localeApi from "./i18n";
import { en } from "./locales/en";
import { zhCN, type MessageKey } from "./locales/zh-CN";
import { taskActionToast } from "./lib/taskActionReport";
import { buildTaskContextTemplate } from "./components/task/TaskActionsMenu";
import { failureRecoveryFor } from "./components/task/failureRecovery";
import { presentTask } from "./components/task/taskPresentation";
import { taskFixture } from "./test/taskFixture";

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); localeApi.setLocale("zh-CN"); localStorage.clear(); });

function Probe() {
  const locale = localeApi.useLocale();
  return <span>{localeApi.t("settings.language", locale)}</span>;
}

describe("shared locale subscription", () => {
  it("keeps every catalog key and interpolation placeholder in parity", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
    const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(zhCN) as MessageKey[]) {
      expect(en[key].trim(), key).not.toBe("");
      expect(placeholders(en[key]), key).toEqual(placeholders(zhCN[key]));
    }
  });

  it("updates mounted views on same-window and other-window language changes", () => {
    render(<Probe />);
    expect(screen.getByText("界面语言")).toBeInTheDocument();
    act(() => localeApi.setLocale("en"));
    expect(screen.getByText("Language")).toBeInTheDocument();
    act(() => {
      localStorage.setItem("downany.locale", "zh-CN");
      window.dispatchEvent(new StorageEvent("storage", { key: "downany.locale" }));
    });
    expect(screen.getByText("界面语言")).toBeInTheDocument();
  });

  it("shares exactly one pair of window listeners for many components and releases them", () => {
    expect(typeof localeApi.useLocale).toBe("function");
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const view = render(<>{Array.from({ length: 1000 }, (_, index) => <Probe key={index} />)}</>);
    expect(add.mock.calls.filter(([event]) => event === "storage")).toHaveLength(1);
    expect(add.mock.calls.filter(([event]) => event === "downany:locale")).toHaveLength(1);
    view.unmount();
    expect(remove.mock.calls.filter(([event]) => event === "storage")).toHaveLength(1);
    expect(remove.mock.calls.filter(([event]) => event === "downany:locale")).toHaveLength(1);
  });

  it("ignores unrelated storage events but handles a cleared language preference", () => {
    localeApi.setLocale("en");
    render(<Probe />);
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
    });
    expect(screen.getByText("Language")).toBeInTheDocument();
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: null })));
    expect(screen.getByText("界面语言")).toBeInTheDocument();
  });

  it("continues changing language when persistent storage rejects writes", () => {
    localStorage.setItem("downany.locale", "zh-CN");
    render(<Probe />);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    expect(() => act(() => localeApi.setLocale("en"))).not.toThrow();
    expect(screen.getByText("Language")).toBeInTheDocument();
    expect(localeApi.getLocale()).toBe("en");
  });

  it("interpolates product text without translating the task title", () => {
    expect(localeApi.t("queue.moveUpLabel", "en", { title: "我的视频" })).toBe("Move 我的视频 up");
    expect(localeApi.t("unknown.test.key", "en")).toBe("unknown.test.key");
  });
});

describe("task presentation language", () => {
  it.each([
    ["pending", "Queued", ""], ["downloading", "Downloading", "Pause"],
    ["paused", "Paused", "Resume"], ["completed", "Completed", "Open"],
    ["failed", "Download failed", "Retry"], ["cancelled", "Cancelled", "Download again"],
  ])("translates %s without changing its action or lifecycle", (status, label, primaryLabel) => {
    const task = taskFixture({ status, file_path: "C:\\test.mp4" });
    const translated = presentTask(task, new Date(), "en");
    const chinese = presentTask(task, new Date(), "zh-CN");
    expect(translated).toMatchObject({ status, label, primaryLabel, primaryAction: chinese.primaryAction });
  });

  it("keeps failure recovery actions and retry safety while translating explanations", () => {
    expect(failureRecoveryFor("network", "en")).toMatchObject({
      detail: "Connection failed. Check your network or proxy, then retry.",
      retryable: true, actions: ["network"],
    });
    expect(failureRecoveryFor("output_verification_failed", "en").requiresRetryConfirmation).toBe(true);
    expect(failureRecoveryFor("media_tools_missing", "en").retryable).toBe(false);
  });

  it("translates applied, deferred and skipped counts truthfully", () => {
    const entry = { taskId: "one", status: "paused" };
    expect(taskActionToast({ action: "pause", applied: [entry], deferred: [entry], skipped: [entry] }, "en")).toEqual({
      kind: "info", title: "Paused: 1; 1 waiting for the current download to stop; 1 unchanged",
    });
    expect(taskActionToast({ action: "resume", applied: [], deferred: [], skipped: [entry] }, "en")).toEqual({
      kind: "info", title: "No tasks to resume",
    });
  });

  it("translates the task menu while retaining group priority semantics", () => {
    const items = buildTaskContextTemplate(taskFixture({ group_id: "group", status: "paused" }), "en");
    expect(items.find(({ id }) => id === "priority-high")?.label).toBe("Make playlist high priority");
    expect(items.find(({ id }) => id === "resume")?.label).toBe("Resume");
  });
});
