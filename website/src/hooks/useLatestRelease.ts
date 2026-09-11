import { useEffect, useState } from "react";
import { PUBLIC_RELEASE_FALLBACK, type GithubRelease } from "../lib/releases";

export const LATEST_RELEASE_API =
  "https://api.github.com/repos/JackEngineer/downany/releases/latest";

export type LatestReleaseState =
  | { status: "loading"; release: null }
  | { status: "ready"; release: GithubRelease }
  | { status: "error"; release: null };

export function useLatestRelease(fetcher: typeof fetch = globalThis.fetch): LatestReleaseState {
  const [state, setState] = useState<LatestReleaseState>({ status: "loading", release: null });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    setState({ status: "loading", release: null });

    void fetcher(LATEST_RELEASE_API, {
      headers: { accept: "application/vnd.github+json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`GitHub Releases request failed with ${response.status}`);
        }

        return (await response.json()) as GithubRelease;
      })
      .then((release) => {
        if (active) {
          setState({ status: "ready", release });
        }
      })
      .catch(() => {
        if (active) {
          setState({ status: "ready", release: PUBLIC_RELEASE_FALLBACK });
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [fetcher]);

  return state;
}
