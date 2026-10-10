import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { LatestReleaseState } from "../hooks/useLatestRelease";
import { PUBLIC_RELEASE_FALLBACK } from "../lib/releases";
import { DownloadPanel } from "./DownloadPanel";
import { Faq } from "./Faq";
import { Hero } from "./Hero";
import { SiteHeader } from "./SiteHeader";

const readyWithoutWindows: LatestReleaseState = {
  status: "ready",
  source: "live",
  release: {
    tag_name: "v0.2.1",
    html_url: "https://github.com/JackEngineer/downany/releases/tag/v0.2.1",
    assets: [
      {
        name: "Downany-0.2.1-mac.dmg",
        browser_download_url: "https://downloads.example/Downany-0.2.1-mac.dmg",
      },
    ],
  },
};

const readyRelease: LatestReleaseState = {
  status: "ready",
  source: "live",
  release: {
    tag_name: "v0.3.2",
    html_url: "https://github.com/JackEngineer/downany/releases/tag/v0.3.2",
    assets: [
      {
        name: "Downany-0.3.2-mac.dmg",
        browser_download_url: "https://downloads.example/Downany-0.3.2-mac.dmg",
      },
      {
        name: "Downany-0.3.2-win-x64.exe",
        browser_download_url: "https://downloads.example/Downany-0.3.2-win-x64.exe",
      },
      {
        name: "Downany-chrome-extension-0.9.2.zip",
        browser_download_url:
          "https://downloads.example/Downany-chrome-extension-0.9.2.zip",
      },
    ],
  },
};

describe("download actions", () => {
  it("links the available macOS build and labels a missing Windows build honestly", () => {
    render(<Hero releaseState={readyWithoutWindows} platform="macos" />);

    expect(screen.getByRole("link", { name: "下载 Apple Silicon Mac" })).toHaveAttribute(
      "href",
      "https://downloads.example/Downany-0.2.1-mac.dmg",
    );
    const windowsLink = screen.getByRole("link", { name: "前往 Windows x64 下载页" });
    expect(windowsLink).toHaveAttribute("href", readyWithoutWindows.release.html_url);
    expect(windowsLink).toHaveAttribute("data-download-status", "missing");
    expect(windowsLink).toHaveAttribute("data-release-source", "live");
  });

  it("links the public Chrome extension archive directly", () => {
    render(<Hero releaseState={readyRelease} platform="macos" />);

    const extensionLink = screen.getByRole("link", { name: "下载 Chrome 扩展" });
    expect(extensionLink).toHaveAttribute(
      "href",
      "https://downloads.example/Downany-chrome-extension-0.9.2.zip",
    );
    expect(extensionLink).toHaveAttribute("data-download-status", "ready");
  });

  it("labels the Chrome extension honestly when the archive is unavailable", () => {
    render(<Hero releaseState={readyWithoutWindows} platform="macos" />);

    const extensionLink = screen.getByRole("link", { name: "前往 Chrome 扩展下载页" });
    expect(extensionLink).toHaveAttribute("href", readyWithoutWindows.release.html_url);
    expect(extensionLink).toHaveAttribute("data-download-status", "missing");
  });

  it("shows the exact public release version beside the download actions", () => {
    render(<DownloadPanel releaseState={readyWithoutWindows} platform="macos" />);

    expect(screen.getByText("最新正式版 v0.2.1")).toBeVisible();
  });

  it("offers honestly labelled download pages while release data is loading", () => {
    render(<Hero releaseState={{ status: "loading", release: null }} platform="macos" />);

    for (const name of ["前往 Apple Silicon Mac 下载页", "前往 Windows x64 下载页", "前往 Chrome 扩展下载页"]) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("data-download-status", "loading");
      expect(screen.getByRole("link", { name })).toHaveAttribute("href", "https://github.com/JackEngineer/downany/releases");
    }
  });

  it("provides a manual Releases path when the API request fails", () => {
    render(<DownloadPanel releaseState={{ status: "error", release: null }} platform="macos" />);

    expect(screen.getByRole("link", { name: "前往 Apple Silicon Mac 下载页" })).toHaveAttribute(
      "href",
      "https://github.com/JackEngineer/downany/releases",
    );
  });

  it("distinguishes verified fallback availability from a live latest release", () => {
    render(<DownloadPanel releaseState={{ status: "ready", release: PUBLIC_RELEASE_FALLBACK, source: "fallback" }} platform="windows" />);

    expect(screen.getByText("可下载版本 v0.3.2")).toHaveAttribute("data-release-source", "fallback");
    expect(screen.queryByText(/最新正式版/)).not.toBeInTheDocument();
    for (const name of ["下载 Apple Silicon Mac", "下载 Windows x64", "下载 Chrome 扩展"]) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("data-release-source", "fallback");
      expect(screen.getByRole("link", { name })).toHaveAttribute("data-download-status", "ready");
    }
  });

  it.each([
    ["macos", ["下载 Apple Silicon Mac", "下载 Windows x64", "下载 Chrome 扩展"]],
    ["windows", ["下载 Windows x64", "下载 Apple Silicon Mac", "下载 Chrome 扩展"]],
    ["other", ["下载 Apple Silicon Mac", "下载 Windows x64", "下载 Chrome 扩展"]],
  ] as const)("prioritizes the correct desktop download for %s", (platform, names) => {
    render(<DownloadPanel releaseState={readyRelease} platform={platform} />);

    const links = screen.getAllByRole("link").filter((link) => link.hasAttribute("data-download-status"));
    expect(links.map((link) => link.textContent)).toEqual(names);
    expect(links[0]).toHaveClass("button--primary");
    expect(links[1]).toHaveClass("button--secondary");
    expect(links[2]).toHaveClass("button--secondary");
  });

  it("links installation help to the user installation chapter", () => {
    render(<DownloadPanel releaseState={readyRelease} platform="macos" />);

    expect(screen.getByRole("link", { name: "查看安装说明" })).toHaveAttribute(
      "href",
      "https://github.com/JackEngineer/downany#安装与首次使用",
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
    expect(screen.getByText(/支持识别 YouTube、Bilibili、抖音/)).toBeVisible();

    await user.click(second);
    expect(first).toHaveAttribute("aria-expanded", "false");
    expect(second).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByText(/支持识别 YouTube、Bilibili、抖音/)).not.toBeInTheDocument();
    expect(screen.getByText(/Downloads\/Downany/)).toBeVisible();

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
