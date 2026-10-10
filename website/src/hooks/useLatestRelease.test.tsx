import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_RELEASE_FALLBACK } from "../lib/releases";
import { LATEST_RELEASE_API, LATEST_RELEASE_TIMEOUT_MS, useLatestRelease } from "./useLatestRelease";

const releasePayload = {
  tag_name: "v0.3.3",
  html_url: "https://github.com/JackEngineer/downany/releases/tag/v0.3.3",
  assets: [
    {
      name: "Downany-0.3.3-mac.dmg",
      browser_download_url: "https://downloads.example/Downany-0.3.3-mac.dmg",
    },
  ],
};

const fallbackState = {
  status: "ready",
  release: PUBLIC_RELEASE_FALLBACK,
  source: "fallback",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("useLatestRelease", () => {
  it("starts loading and marks a validated successful response as live", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(releasePayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const { result } = renderHook(() => useLatestRelease(fetcher));

    expect(result.current).toEqual({ status: "loading", release: null });
    expect(fetcher).toHaveBeenCalledWith(LATEST_RELEASE_API, {
      headers: { accept: "application/vnd.github+json" },
      signal: expect.any(AbortSignal),
    });

    await waitFor(() => {
      expect(result.current).toEqual({ status: "ready", release: releasePayload, source: "live" });
    });
  });

  it.each([403, 429, 500])("uses verified fallback downloads after HTTP %i", async (status) => {
    const fetcher: typeof fetch = async () => new Response("unavailable", { status });

    const { result } = renderHook(() => useLatestRelease(fetcher));

    await waitFor(() => {
      expect(result.current).toEqual(fallbackState);
    });
  });

  it.each([
    ["malformed JSON", async () => new Response("not json", { status: 200 })],
    ["network failure", async () => Promise.reject(new TypeError("network unavailable"))],
    ["invalid root structure", async () => new Response(JSON.stringify(null), { status: 200 })],
    ["invalid tag", async () => new Response(JSON.stringify({ ...releasePayload, tag_name: 32 }), { status: 200 })],
    ["invalid release URL", async () => new Response(JSON.stringify({ ...releasePayload, html_url: null }), { status: 200 })],
    ["invalid assets collection", async () => new Response(JSON.stringify({ ...releasePayload, assets: {} }), { status: 200 })],
    ["invalid asset structure", async () => new Response(JSON.stringify({ ...releasePayload, assets: [{ name: "file.zip" }] }), { status: 200 })],
  ] as const)("uses the public fallback after %s", async (_caseName, request) => {
    const fetcher = request as typeof fetch;
    const { result } = renderHook(() => useLatestRelease(fetcher));

    await waitFor(() => {
      expect(result.current).toEqual(fallbackState);
    });
  });

  it("falls back at eight seconds and ignores a later successful response", async () => {
    vi.useFakeTimers();
    let finishRequest!: (response: Response) => void;
    const requestSignal: { current?: AbortSignal | null } = {};
    const fetcher: typeof fetch = async (_input, init) => {
      requestSignal.current = init?.signal;
      return new Promise<Response>((resolve) => {
        finishRequest = resolve;
      });
    };
    const { result } = renderHook(() => useLatestRelease(fetcher));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LATEST_RELEASE_TIMEOUT_MS - 1);
    });
    expect(result.current.status).toBe("loading");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current).toEqual(fallbackState);
    expect(requestSignal.current?.aborted).toBe(true);

    await act(async () => {
      finishRequest(new Response(JSON.stringify(releasePayload), { status: 200 }));
    });
    expect(result.current).toEqual(fallbackState);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("includes stalled JSON parsing in the same eight-second timeout", async () => {
    vi.useFakeTimers();
    let finishRequest!: (response: Response) => void;
    const json = vi.fn(() => new Promise<unknown>(() => undefined));
    const fetcher: typeof fetch = async () => new Promise<Response>((resolve) => {
      finishRequest = resolve;
    });
    const { result } = renderHook(() => useLatestRelease(fetcher));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_000);
      finishRequest({ ok: true, json } as unknown as Response);
    });
    expect(result.current.status).toBe("loading");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LATEST_RELEASE_TIMEOUT_MS - 7_000);
    });

    expect(json).toHaveBeenCalledOnce();
    expect(result.current).toEqual(fallbackState);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timeout after a completed request", async () => {
    vi.useFakeTimers();
    const fetcher: typeof fetch = async () => new Response(JSON.stringify(releasePayload));
    const { result } = renderHook(() => useLatestRelease(fetcher));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current).toEqual({ status: "ready", release: releasePayload, source: "live" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts and clears the timer on unmount without accepting late release data", async () => {
    vi.useFakeTimers();
    let finishRequest!: (response: Response) => void;
    const requestSignal: { current?: AbortSignal | null } = {};
    const fetcher: typeof fetch = async (_input, init) => {
      requestSignal.current = init?.signal;
      return new Promise<Response>((resolve) => {
        finishRequest = resolve;
      });
    };

    const { result, unmount } = renderHook(() => useLatestRelease(fetcher));
    unmount();

    expect(requestSignal.current?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      finishRequest(new Response(JSON.stringify(releasePayload), { status: 200 }));
    });
    expect(result.current).toEqual({ status: "loading", release: null });
  });
});
