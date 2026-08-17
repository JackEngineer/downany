import { AppleLogo, WindowsLogo } from "@phosphor-icons/react";
import type { LatestReleaseState } from "../hooks/useLatestRelease";
import { orderPlatforms, type DownloadPlatform, type Platform } from "../lib/platform";
import { DEFAULT_RELEASES_URL, resolveReleaseAssets } from "../lib/releases";

interface DownloadActionsProps {
  releaseState: LatestReleaseState;
  platform: Platform;
  className?: string;
}

interface DownloadAction {
  platform: DownloadPlatform;
  label: string;
  url: string;
  tone: "primary" | "secondary";
  status: "loading" | "ready" | "missing" | "error";
}

function resolveActions(
  releaseState: LatestReleaseState,
  platform: Platform,
): DownloadAction[] {
  const links = resolveReleaseAssets(
    releaseState.status === "ready" ? releaseState.release : null,
    DEFAULT_RELEASES_URL,
  );

  return orderPlatforms(platform).map((downloadPlatform, index) => {
    if (downloadPlatform === "macos") {
      const ready = releaseState.status === "ready" && links.macos.status === "ready";
      return {
        platform: downloadPlatform,
        label: releaseState.status === "error" ? "前往 GitHub Releases" : "下载 macOS 版",
        url: ready ? links.macos.url : links.releasePage,
        tone: index === 0 ? "primary" : "secondary",
        status:
          releaseState.status === "error"
            ? "error"
            : ready
              ? "ready"
              : releaseState.status === "ready"
                ? "missing"
                : "loading",
      };
    }

    const ready = releaseState.status === "ready" && links.windows.status === "ready";
    const label = ready
      ? "下载 Windows 版"
      : releaseState.status === "loading"
        ? "Windows 版"
        : "Windows 版准备中";

    return {
      platform: downloadPlatform,
      label,
      url: ready ? links.windows.url : links.releasePage,
      tone: index === 0 ? "primary" : "secondary",
      status:
        releaseState.status === "error"
          ? "error"
          : ready
            ? "ready"
            : releaseState.status === "ready"
              ? "missing"
              : "loading",
    };
  });
}

export function DownloadActions({ releaseState, platform, className }: DownloadActionsProps) {
  return (
    <div className={["download-actions", className].filter(Boolean).join(" ")}>
      {resolveActions(releaseState, platform).map((action) => {
        const Icon = action.platform === "macos" ? AppleLogo : WindowsLogo;
        return (
          <a
            className={`button button--${action.tone}`}
            data-download-status={action.status}
            href={action.url}
            key={action.platform}
          >
            <Icon aria-hidden="true" size={19} weight="regular" />
            <span>{action.label}</span>
          </a>
        );
      })}
    </div>
  );
}
