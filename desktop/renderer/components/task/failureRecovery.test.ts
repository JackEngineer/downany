import { describe, expect, it } from "vitest";

import { failureRecoveryFor } from "./failureRecovery";

describe("output failure recovery", () => {
  it.each([
    [
      "output_path_invalid",
      "下载位置或文件名不可用，请检查下载位置和命名设置",
      ["downloadSettings"],
      true,
      false,
    ],
    [
      "media_tools_missing",
      "媒体工具不完整，请重新安装 Downany",
      ["appDownload", "diagnostics"],
      false,
      false,
    ],
    [
      "output_verification_failed",
      "成品无法验证，请导出诊断后重试",
      ["diagnostics"],
      true,
      true,
    ],
  ] as const)(
    "maps %s to a safe recovery view",
    (code, detail, actions, retryable, requiresRetryConfirmation) => {
      expect(failureRecoveryFor(code)).toEqual({
        detail,
        actions,
        retryable,
        requiresRetryConfirmation,
      });
    },
  );

  it("requires retry confirmation only for failed output verification", () => {
    expect(failureRecoveryFor("network").requiresRetryConfirmation).toBe(false);
    expect(failureRecoveryFor("unexpected").requiresRetryConfirmation).toBe(false);
    expect(
      failureRecoveryFor("output_verification_failed")
        .requiresRetryConfirmation,
    ).toBe(true);
  });
});
