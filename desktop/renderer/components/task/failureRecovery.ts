export type FailureRecoveryAction =
  | "login"
  | "network"
  | "updateTool"
  | "recognize"
  | "downloadSettings"
  | "appDownload"
  | "diagnostics";

export interface FailureRecoveryView {
  readonly detail: string;
  readonly retryable: boolean;
  readonly requiresRetryConfirmation: boolean;
  readonly actions: readonly FailureRecoveryAction[];
}

const UNKNOWN_FAILURE: FailureRecoveryView = {
  detail: "下载未完成，请重试或改用网页识别",
  retryable: true,
  requiresRetryConfirmation: false,
  actions: ["recognize"],
};

const FAILURE_VIEWS = {
  need_login: {
    detail: "需要登录后才能下载，请选择浏览器登录状态后重试",
    retryable: true,
    requiresRetryConfirmation: false,
    actions: ["login", "recognize"],
  },
  private: {
    detail: "此内容为私密内容，请登录有访问权限的账号后重试",
    retryable: true,
    requiresRetryConfirmation: false,
    actions: ["login", "recognize"],
  },
  geo_blocked: {
    detail: "此内容在当前地区不可用，请检查网络设置后重试",
    retryable: true,
    requiresRetryConfirmation: false,
    actions: ["network"],
  },
  network: {
    detail: "网络连接失败，请检查网络或代理后重试",
    retryable: true,
    requiresRetryConfirmation: false,
    actions: ["network"],
  },
  ytdlp_outdated: {
    detail: "下载工具需要更新，更新后即可重试",
    retryable: true,
    requiresRetryConfirmation: false,
    actions: ["updateTool"],
  },
  need_po_token: {
    detail: "页面需要额外验证，请改用网页识别",
    retryable: true,
    requiresRetryConfirmation: false,
    actions: ["recognize"],
  },
  unsupported: {
    detail: "暂不支持直接下载此页面，请改用网页识别",
    retryable: true,
    requiresRetryConfirmation: false,
    actions: ["recognize"],
  },
  removed: {
    detail: "此内容已被删除或不可用",
    retryable: false,
    requiresRetryConfirmation: false,
    actions: [],
  },
  output_path_invalid: {
    detail: "下载位置或文件名不可用，请检查下载位置和命名设置",
    retryable: true,
    requiresRetryConfirmation: false,
    actions: ["downloadSettings"],
  },
  media_tools_missing: {
    detail: "媒体工具不完整，请重新安装 Downany",
    retryable: false,
    requiresRetryConfirmation: false,
    actions: ["appDownload", "diagnostics"],
  },
  output_verification_failed: {
    detail: "成品无法验证，请导出诊断后重试",
    retryable: true,
    requiresRetryConfirmation: true,
    actions: ["diagnostics"],
  },
} as const satisfies Record<string, FailureRecoveryView>;

export function failureRecoveryFor(
  errorCode: string | null | undefined,
): FailureRecoveryView {
  return (
    FAILURE_VIEWS[errorCode as keyof typeof FAILURE_VIEWS] ?? UNKNOWN_FAILURE
  );
}
