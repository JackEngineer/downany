import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App content contract", () => {
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

    expect(screen.getByRole("img", { name: "Downany 界面预览" })).toHaveAttribute(
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
      "https://github.com/JackEngineer/downany/tree/main/browser-extension",
    );
    expect(screen.getByRole("contentinfo")).toHaveTextContent("Downany · 百纳");
  });
});
