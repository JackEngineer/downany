import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { LatestReleaseState } from "../hooks/useLatestRelease";
import { DownloadPanel } from "./DownloadPanel";
import { Faq } from "./Faq";
import { Hero } from "./Hero";
import { SiteHeader } from "./SiteHeader";

const readyWithoutWindows: LatestReleaseState = {
  status: "ready",
  release: {
    tag_name: "v0.1.0",
    html_url: "https://github.com/JackEngineer/downany/releases/tag/v0.1.0",
    assets: [
      {
        name: "Downany-0.1.0-mac.dmg",
        browser_download_url: "https://downloads.example/Downany-0.1.0-mac.dmg",
      },
    ],
  },
};

describe("download actions", () => {
  it("links the available macOS build and labels a missing Windows build honestly", () => {
    render(<Hero releaseState={readyWithoutWindows} platform="macos" />);

    expect(screen.getByRole("link", { name: "下载 macOS 版" })).toHaveAttribute(
      "href",
      "https://downloads.example/Downany-0.1.0-mac.dmg",
    );
    const windowsLink = screen.getByRole("link", { name: /Windows 版准备中/ });
    expect(windowsLink).toHaveAttribute("href", readyWithoutWindows.release.html_url);
    expect(windowsLink).toHaveAttribute("data-download-status", "missing");
  });

  it("keeps stable button labels while release data is loading", () => {
    render(<Hero releaseState={{ status: "loading", release: null }} platform="macos" />);

    expect(screen.getByRole("link", { name: "下载 macOS 版" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Windows 版" })).toBeVisible();
  });

  it("provides a manual Releases path when the API request fails", () => {
    render(<DownloadPanel releaseState={{ status: "error", release: null }} platform="macos" />);

    expect(screen.getByRole("link", { name: "前往 GitHub Releases" })).toHaveAttribute(
      "href",
      "https://github.com/JackEngineer/downany/releases",
    );
  });
});

describe("Faq", () => {
  it("uses an accessible single-open accordion that can close the active item", async () => {
    const user = userEvent.setup();
    render(<Faq />);

    const first = screen.getByRole("button", { name: "Downany 支持哪些网站？" });
    const second = screen.getByRole("button", { name: "下载的视频存放在哪里？" });

    expect(first).toHaveAttribute("aria-expanded", "false");
    first.focus();
    await user.keyboard("{Enter}");
    expect(first).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/支持 YouTube、Bilibili、抖音/)).toBeVisible();

    await user.click(second);
    expect(first).toHaveAttribute("aria-expanded", "false");
    expect(second).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByText(/支持 YouTube、Bilibili、抖音/)).not.toBeInTheDocument();

    await user.click(second);
    expect(second).toHaveAttribute("aria-expanded", "false");
  });
});

describe("SiteHeader", () => {
  it("closes the mobile menu with Escape and returns focus to the menu button", async () => {
    const user = userEvent.setup();
    render(<SiteHeader />);

    const trigger = screen.getByRole("button", { name: "打开导航" });
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("navigation", { name: "移动端导航" })).toBeVisible();

    await user.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("closes the mobile menu after a navigation link is selected", async () => {
    const user = userEvent.setup();
    render(<SiteHeader />);

    const trigger = screen.getByRole("button", { name: "打开导航" });
    await user.click(trigger);
    const mobileNavigation = screen.getByRole("navigation", { name: "移动端导航" });
    await user.click(within(mobileNavigation).getByRole("link", { name: "功能" }));

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });
});
