import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLatestRelease } from "./useLatestRelease";

const releasePayload = {
  tag_name: "v0.2.0",
  html_url: "https://github.com/JackEngineer/downany/releases/tag/v0.2.0",
  assets: [
    {
      name: "Downany-0.2.0-mac.dmg",
      browser_download_url: "https://downloads.example/Downany-0.2.0-mac.dmg",
    },
  ],
};

const publicReleaseFallback = {
  tag_name: "v0.3.0",
  html_url: "https://github.com/JackEngineer/downany/releases/tag/v0.3.0",
  assets: [
    {
      name: "Downany-0.3.0-mac.dmg",
      browser_download_url:
        "https://github.com/JackEngineer/downany/releases/download/v0.3.0/Downany-0.3.0-mac.dmg",
    },
    {
      name: "Downany-0.3.0-win-x64.exe",
      browser_download_url:
        "https://github.com/JackEngineer/downany/releases/download/v0.3.0/Downany-0.3.0-win-x64.exe",
    },
    {
      name: "Downany-chrome-extension-0.8.2.zip",
      browser_download_url:
        "https://github.com/JackEngineer/downany/releases/download/v0.3.0/Downany-chrome-extension-0.8.2.zip",
    },
  ],
};

describe("useLatestRelease", () => {
  it("starts loading and exposes the parsed release after a successful response", async () => {
    const fetcher: typeof fetch = async () =>
      new Response(JSON.stringify(releasePayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const { result } = renderHook(() => useLatestRelease(fetcher));

    expect(result.current).toEqual({ status: "loading", release: null });

    await waitFor(() => {
      expect(result.current).toEqual({ status: "ready", release: releasePayload });
    });
  });

  it("uses the public fallback after a rate-limited response", async () => {
    const fetcher: typeof fetch = async () => new Response("rate limited", { status: 403 });

    const { result } = renderHook(() => useLatestRelease(fetcher));

    await waitFor(() => {
      expect(result.current).toEqual({ status: "ready", release: publicReleaseFallback });
    });
  });

  it.each([
    ["malformed JSON", async () => new Response("not json", { status: 200 })],
    ["network failure", async () => Promise.reject(new TypeError("network unavailable"))],
  ] as const)("uses the public fallback after %s", async (_caseName, request) => {
    const fetcher = request as typeof fetch;
    const { result } = renderHook(() => useLatestRelease(fetcher));

    await waitFor(() => {
      expect(result.current).toEqual({ status: "ready", release: publicReleaseFallback });
    });
  });

  it("aborts the in-flight request when the consumer unmounts", () => {
    const requestSignal: { current?: AbortSignal } = {};
    const fetcher: typeof fetch = async (_input, init) => {
      requestSignal.current = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    };

    const { unmount } = renderHook(() => useLatestRelease(fetcher));
    unmount();

    expect(requestSignal.current?.aborted).toBe(true);
  });
});
