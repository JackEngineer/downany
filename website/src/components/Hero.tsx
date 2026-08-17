import type { LatestReleaseState } from "../hooks/useLatestRelease";
import type { Platform } from "../lib/platform";
import { siteContent } from "../content/siteContent";
import { DownloadActions } from "./DownloadActions";
import { ProductPreview } from "./ProductPreview";

interface HeroProps {
  releaseState: LatestReleaseState;
  platform: Platform;
}

export function Hero({ releaseState, platform }: HeroProps) {
  return (
    <section className="hero section-shell" id="top">
      <div className="hero__copy">
        <h1>{siteContent.hero.title}</h1>
        <p>{siteContent.hero.description}</p>
        <DownloadActions releaseState={releaseState} platform={platform} />
      </div>
      <ProductPreview />
    </section>
  );
}
