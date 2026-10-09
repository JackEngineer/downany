import type { Session, WebContents } from "electron";

/** Remote pages may navigate within the web, never automatically launch native apps. */
export function isExtractWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function isExtractNavigationUrl(value: string): boolean {
  return isExtractWebUrl(value) || value === "about:blank";
}

export function installExtractSessionPolicy(ses: Session): void {
  // Preserve existing permission behavior except automatic native application launches.
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission !== "openExternal");
  });
  ses.setPermissionCheckHandler((_contents, permission) => permission !== "openExternal");
}

export function installExtractGuestPolicy(guest: WebContents): void {
  const guard = (event: { preventDefault(): void }, url: string) => {
    if (!isExtractNavigationUrl(url)) event.preventDefault();
  };
  guest.on("will-navigate", guard);
  guest.on("will-redirect", guard);
  guest.on("will-frame-navigate", (event) => guard(event, event.url));
  guest.setWindowOpenHandler(({ url }) => ({
    action: isExtractNavigationUrl(url) ? "allow" : "deny",
  }));
  // Approved web popups must receive the same policy, including later redirects.
  guest.on("did-create-window", (window) => installExtractGuestPolicy(window.webContents));
}
