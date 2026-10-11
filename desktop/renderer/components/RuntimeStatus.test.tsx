import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, it, expect, vi } from "vitest";
import { RuntimeStatus } from "./RuntimeStatus";
import { useAppStore } from "../store/appStore";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("shows the process version and actionable mismatch without claiming a source package is installed", async () => {
  Object.defineProperty(window,"api",{configurable:true,value:{getRuntimeInfo:async()=>({appVersion:"0.3.3",sidecarVersion:"0.3.2",connection:"connected",bridge:"unavailable",versionMismatch:true})}});
  useAppStore.setState({settings:{locale:"zh-CN"} as never});
  render(<RuntimeStatus />);
  await waitFor(()=>expect(screen.getByText(/当前桌面 0.3.3/)).toBeInTheDocument());
  expect(screen.getByText(/下载服务 0.3.2/)).toBeInTheDocument();
  expect(screen.getByText(/版本不同/)).toBeInTheDocument();
  expect(screen.getByText(/不可用/)).toBeInTheDocument();
});
