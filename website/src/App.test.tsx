import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App content contract", () => {
  it.each([
    ["下载 Apple Silicon Mac", "Downany-0.3.2-mac.dmg"],
    ["下载 Windows x64", "Downany-0.3.2-win-x64.exe"],
    ["下载 Chrome 扩展", "Downany-chrome-extension-0.9.2.zip"],
  ])("keeps %s available when GitHub rate limits releases", async (name, assetName) => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("rate limited", {
          status: 403,
        }),
    );

    render(<App />);

    await waitFor(() => {
      const downloadLinks = screen.getAllByRole("link", { name });
      expect(downloadLinks).toHaveLength(2);
      for (const link of downloadLinks) {
        expect(link).toHaveAttribute(
          "href",
          `https://github.com/JackEngineer/downany/releases/download/v0.3.2/${assetName}`,
        );
        expect(link).toHaveAttribute("data-download-status", "ready");
        expect(link).toHaveAttribute("data-release-source", "fallback");
      }
      expect(screen.getByText("可下载版本 v0.3.2")).toBeVisible();
    });
  });

  it("renders one direct product promise without unsupported marketing claims", () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("rate limited", {
          status: 403,
        }),
    );

    render(<App />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "把网页里的视频，稳稳收进本地。",
    );
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.queryByText(/支持所有网站|永久免费|零失败|行业领先|10,000\+/)).not.toBeInTheDocument();
    expect(screen.queryByText(/eyebrow|badge|AI 生成/)).not.toBeInTheDocument();
  });

  it("renders the complete single-page product journey with independent media assets", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            tag_name: "v0.1.0",
            html_url: "https://github.com/JackEngineer/downany/releases/tag/v0.1.0",
            assets: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    render(<App />);

    expect(screen.getByRole("heading", { name: "你只需要三步" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "复杂网页，也有办法" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "下载之外，流程也替你收好" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "下载 Downany" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "常见问题" })).toBeVisible();
    expect(
      screen.getByText("下载完成后发送到已绑定的聊天；云端单文件上限 50 MB，较大视频可分段发送。"),
    ).toBeVisible();
    expect(screen.queryByText("随下一版本提供。")).not.toBeInTheDocument();

    expect(screen.getByRole("img", { name: "Downany 主窗口：粘贴链接、网页识别和下载列表" })).toHaveAttribute(
      "src",
      "/assets/downany-app-preview.png",
    );
    expect(screen.getByRole("img", { name: "中式院落网页媒体画面" })).toHaveAttribute(
      "loading",
      "lazy",
    );
    expect(screen.getByRole("list", { name: "Downany 功能" }).children).toHaveLength(6);
    expect(screen.getByRole("link", { name: "了解网页识别" })).toHaveAttribute(
      "href",
      "https://github.com/JackEngineer/downany#功能",
    );
    expect(screen.getByRole("contentinfo")).toHaveTextContent("Downany · 百纳");

    await waitFor(() => {
      expect(screen.getByText("最新正式版 v0.1.0")).toBeVisible();
      for (const name of ["前往 Apple Silicon Mac 下载页", "前往 Windows x64 下载页", "前往 Chrome 扩展下载页"]) {
        for (const link of screen.getAllByRole("link", { name })) {
          expect(link).toHaveAttribute("href", "https://github.com/JackEngineer/downany/releases/tag/v0.1.0");
          expect(link).toHaveAttribute("data-download-status", "missing");
          expect(link).toHaveAttribute("data-release-source", "live");
        }
      }
    });
  });
});
