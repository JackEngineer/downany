import { ArrowSquareOut } from "@phosphor-icons/react";
import { siteContent, siteLinks } from "../content/siteContent";
import type { LatestReleaseState } from "../hooks/useLatestRelease";
import type { Platform } from "../lib/platform";
import { DownloadActions } from "./DownloadActions";

interface DownloadPanelProps {
  releaseState: LatestReleaseState;
  platform: Platform;
}

export function DownloadPanel({ releaseState, platform }: DownloadPanelProps) {
  const publicVersion = releaseState.status === "ready" ? releaseState.release.tag_name : null;

  return (
    <section className="download-panel section-shell" id="download">
      <div>
        <h2>{siteContent.download.title}</h2>
        <p>{siteContent.download.description}</p>
        {publicVersion ? (
          <p
            className="download-panel__version"
            data-release-source={releaseState.status === "ready" ? releaseState.source : undefined}
          >
            {releaseState.status === "ready" && releaseState.source === "live"
              ? "最新正式版"
              : "可下载版本"}{" "}
            {publicVersion}
          </p>
        ) : null}
      </div>
      <div className="download-panel__actions">
        <DownloadActions releaseState={releaseState} platform={platform} />
        <a className="text-link" href={siteLinks.releaseGuide} rel="noreferrer" target="_blank">
          {siteContent.download.installHelp}
          <ArrowSquareOut aria-hidden="true" size={16} weight="regular" />
        </a>
      </div>
    </section>
  );
}
