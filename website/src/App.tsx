import { useMemo } from "react";
import { CapabilityList } from "./components/CapabilityList";
import { DownloadPanel } from "./components/DownloadPanel";
import { Faq } from "./components/Faq";
import { Hero } from "./components/Hero";
import { RecognitionSpotlight } from "./components/RecognitionSpotlight";
import { SiteFooter } from "./components/SiteFooter";
import { SiteHeader } from "./components/SiteHeader";
import { Workflow } from "./components/Workflow";
import { useLatestRelease } from "./hooks/useLatestRelease";
import { detectPlatform } from "./lib/platform";

interface NavigatorWithUserAgentData extends Navigator {
  userAgentData?: { platform?: string };
}

export function App() {
  const releaseState = useLatestRelease();
  const platform = useMemo(() => {
    const currentNavigator = navigator as NavigatorWithUserAgentData;
    return detectPlatform({
      userAgentDataPlatform: currentNavigator.userAgentData?.platform,
      userAgent: currentNavigator.userAgent,
    });
  }, []);

  return (
    <>
      <SiteHeader />
      <main>
        <Hero platform={platform} releaseState={releaseState} />
        <Workflow />
        <RecognitionSpotlight />
        <CapabilityList />
        <DownloadPanel platform={platform} releaseState={releaseState} />
        <Faq />
      </main>
      <SiteFooter />
    </>
  );
}
