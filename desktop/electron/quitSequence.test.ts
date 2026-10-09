import { describe, expect, it, vi } from "vitest";
import { createQuitHandler } from "./quitSequence";

describe("application quit sequence", () => {
  it("blocks repeated quit requests until the same cleanup has completed", async () => {
    let finish!: () => void;
    const cleanup = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const events = [0, 1, 2].map(() => ({ preventDefault: vi.fn() }));
    const quit = vi.fn(() => handler(events[2]));
    const handler = createQuitHandler(cleanup, quit);
    handler(events[0]);
    handler(events[1]);
    expect(events[0].preventDefault).toHaveBeenCalledOnce();
    expect(events[1].preventDefault).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(events[2].preventDefault).not.toHaveBeenCalled();
  });

  it("reports cleanup failure without leaving an application that cannot quit", async () => {
    const failed = new Error("cleanup failure");
    const report = vi.fn();
    const quit = vi.fn();
    const handler = createQuitHandler(async () => { throw failed; }, quit, report);
    handler({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(report).toHaveBeenCalledWith(failed);
  });
});
