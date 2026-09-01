import { AppleLogo, PuzzlePiece, WindowsLogo } from "@phosphor-icons/react";
import type { LatestReleaseState } from "../hooks/useLatestRelease";
import { orderPlatforms, type DownloadPlatform, type Platform } from "../lib/platform";
import { DEFAULT_RELEASES_URL, resolveReleaseAssets } from "../lib/releases";

interface DownloadActionsProps {
  releaseState: LatestReleaseState;
  platform: Platform;
  className?: string;
}

type DownloadTarget = DownloadPlatform | "extension";

interface DownloadAction {
  target: DownloadTarget;
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

  const platformActions: DownloadAction[] = orderPlatforms(platform).map(
    (downloadPlatform, index) => {
      if (downloadPlatform === "macos") {
        const ready = releaseState.status === "ready" && links.macos.status === "ready";
        return {
          target: downloadPlatform,
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
        target: downloadPlatform,
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
    },
  );

  const extensionReady =
    releaseState.status === "ready" && links.extension.status === "ready";
  const extensionLabel = extensionReady
    ? "下载 Chrome 扩展"
    : releaseState.status === "loading"
      ? "Chrome 扩展"
      : releaseState.status === "error"
        ? "查看 Chrome 扩展"
        : "Chrome 扩展准备中";

  return [
    ...platformActions,
    {
      target: "extension",
      label: extensionLabel,
      url: extensionReady ? links.extension.url : links.releasePage,
      tone: "secondary",
      status:
        releaseState.status === "error"
          ? "error"
          : extensionReady
            ? "ready"
            : releaseState.status === "ready"
              ? "missing"
              : "loading",
    },
  ];
}

export function DownloadActions({ releaseState, platform, className }: DownloadActionsProps) {
  return (
    <div className={["download-actions", className].filter(Boolean).join(" ")}>
      {resolveActions(releaseState, platform).map((action) => {
        const Icon =
          action.target === "macos"
            ? AppleLogo
            : action.target === "windows"
              ? WindowsLogo
              : PuzzlePiece;
        return (
          <a
            className={`button button--${action.tone}`}
            data-download-status={action.status}
            href={action.url}
            key={action.target}
          >
            <Icon aria-hidden="true" size={19} weight="regular" />
            <span>{action.label}</span>
          </a>
        );
      })}
    </div>
  );
}
