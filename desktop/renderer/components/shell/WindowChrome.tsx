interface WindowChromeProps {
  platform?: NodeJS.Platform;
}

export function WindowChrome({
  platform = window.api.platform,
}: WindowChromeProps) {
  if (platform !== "darwin") return null;

  return (
    <header className="window-chrome">
      <span className="window-chrome__title">Downany · 百纳</span>
    </header>
  );
}
