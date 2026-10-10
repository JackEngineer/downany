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

  const targets: DownloadTarget[] = [...orderPlatforms(platform), "extension"];
  const labels: Record<DownloadTarget, string> = {
    macos: "Apple Silicon Mac",
    windows: "Windows x64",
    extension: "Chrome 扩展",
  };

  return targets.map<DownloadAction>((target, index) => {
    const ready = releaseState.status === "ready" && links[target].status === "ready";
    const pageLabel = target === "extension"
      ? "前往 Chrome 扩展下载页"
      : `前往 ${labels[target]} 下载页`;
    return {
      target,
      label: ready ? `下载 ${labels[target]}` : pageLabel,
      url: ready ? links[target].url : links.releasePage,
      tone: index === 0 ? "primary" : "secondary",
      status: releaseState.status === "ready" ? links[target].status : releaseState.status,
    };
  });
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
            data-release-source={releaseState.status === "ready" ? releaseState.source : undefined}
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
