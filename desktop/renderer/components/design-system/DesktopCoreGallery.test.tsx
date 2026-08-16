import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DesktopCoreGallery,
  installGalleryApiMock,
} from "./DesktopCoreGallery";

afterEach(cleanup);
beforeEach(installGalleryApiMock);

describe("DesktopCoreGallery", () => {
  it("renders all canonical task states", () => {
    const { container } = render(<DesktopCoreGallery />);

    for (const label of [
      "等待中",
      "下载中",
      "已暂停",
      "已完成",
      "下载失败",
      "已取消",
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }

    expect(container.querySelectorAll(".media-task-banner")).toHaveLength(6);

    for (const tone of ["dark", "medium", "light"]) {
      expect(
        container.querySelector(`[data-artwork-tone="${tone}"]`),
      ).not.toBeNull();
    }

    expect(
      screen.getByRole("region", { name: "紧凑密度（无毛玻璃降级）" }),
    ).toBeInTheDocument();
    expect(
      container.querySelector(".media-task-banner__artwork-placeholder"),
    ).not.toBeNull();
  });

  it("provides deterministic theme and transparency controls", () => {
    render(<DesktopCoreGallery />);

    fireEvent.click(screen.getByRole("button", { name: "浅色" }));
    expect(document.documentElement.dataset.theme).toBe("light");

    fireEvent.click(screen.getByRole("button", { name: "减少透明" }));
    expect(document.documentElement.dataset.reduceTransparency).toBe("true");
  });
});
