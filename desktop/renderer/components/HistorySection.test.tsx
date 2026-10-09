import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAppStore } from "../store/appStore";
import { HistorySection } from "./HistorySection";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../lib/api", () => ({ request: mocks.request, openPath: vi.fn() }));
afterEach(cleanup);
beforeEach(() => {
  useAppStore.setState({ connection: "connected", searchMode: "filter", searchQuery: "", sortOrder: "newest" });
  window.api = { onEvent: vi.fn(() => () => undefined) } as unknown as typeof window.api;
  mocks.request.mockReset();
});

it("sends global server order, resets pagination, and keeps selection by ID", async () => {
  const a = { id: "a", title: "记录 A", status: "completed", platform: "youtube", url: "https://example.com/a" };
  const b = { ...a, id: "b", title: "记录 B" };
  mocks.request.mockImplementation(async (_method, payload) => ({ items: payload.sort_order === "newest" ? [b, a] : [a, b] }));
  const { container } = render(<HistorySection />);
  await screen.findByText("记录 A");
  const checkbox = () => within(screen.getByText("记录 A").closest("label")!).getByRole("checkbox");
  fireEvent.click(checkbox());
  expect(checkbox()).toBeChecked();
  act(() => useAppStore.getState().setSortOrder("oldest"));
  await waitFor(() => expect(mocks.request).toHaveBeenLastCalledWith("history.list", expect.objectContaining({ sort_order: "oldest", offset: 0 })));
  await waitFor(() => expect(container.querySelector(".history-list strong")?.textContent).toBe("记录 A"));
  expect(checkbox()).toBeChecked();
});

it("ignores a stale response from the previous sort", async () => {
  let resolveOld: (value: unknown) => void = () => undefined;
  mocks.request.mockImplementation(async (_method, payload) => payload.sort_order === "newest"
    ? new Promise(resolve => { resolveOld = resolve; })
    : { items: [{ id: "fresh", title: "正确顺序", platform: "youtube", status: "completed" }] });
  render(<HistorySection />);
  await waitFor(() => expect(mocks.request).toHaveBeenCalled());
  act(() => useAppStore.getState().setSortOrder("oldest"));
  await screen.findByText("正确顺序");
  await act(async () => resolveOld({ items: [{ id: "stale", title: "过期响应" }] }));
  expect(screen.queryByText("过期响应")).not.toBeInTheDocument();
  expect(screen.getByText("正确顺序")).toBeInTheDocument();
});
