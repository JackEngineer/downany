import { useEffect, useState } from "react";
import { isGithubRelease, PUBLIC_RELEASE_FALLBACK, type GithubRelease } from "../lib/releases";

export const LATEST_RELEASE_API =
  "https://api.github.com/repos/JackEngineer/downany/releases/latest";
export const LATEST_RELEASE_TIMEOUT_MS = 8_000;

export type LatestReleaseState =
  | { status: "loading"; release: null }
  | { status: "ready"; release: GithubRelease; source: "live" | "fallback" }
  | { status: "error"; release: null };

export function useLatestRelease(fetcher: typeof fetch = globalThis.fetch): LatestReleaseState {
  const [state, setState] = useState<LatestReleaseState>({ status: "loading", release: null });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    setState({ status: "loading", release: null });

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error("GitHub Releases request timed out"));
      }, LATEST_RELEASE_TIMEOUT_MS);
    });

    const request = async (): Promise<GithubRelease> => {
      const response = await fetcher(LATEST_RELEASE_API, {
        headers: { accept: "application/vnd.github+json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`GitHub Releases request failed with ${response.status}`);
      }

      const release: unknown = await response.json();
      if (!isGithubRelease(release)) {
        throw new Error("GitHub Releases response has an invalid structure");
      }
      return release;
    };

    // Race the whole request, including JSON parsing, even if a fetcher ignores abort.
    void Promise.race([request(), timeout])
      .then((release) => {
        if (active) {
          setState({ status: "ready", release, source: "live" });
        }
      })
      .catch(() => {
        if (active) {
          setState({ status: "ready", release: PUBLIC_RELEASE_FALLBACK, source: "fallback" });
        }
      })
      .finally(() => {
        clearTimeout(timeoutId);
      });

    return () => {
      active = false;
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [fetcher]);

  return state;
}
