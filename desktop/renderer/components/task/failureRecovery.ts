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

const UNKNOWN_FAILURE: Omit<FailureRecoveryView, "detail"> = {
  retryable: true,
  requiresRetryConfirmation: false,
  actions: ["recognize"],
};

const FAILURE_VIEWS = {
  need_login: {
    retryable: true,
    requiresRetryConfirmation: false,
    actions: ["login", "recognize"],
  },
  private: {
    retryable: true,
    requiresRetryConfirmation: false,
    actions: ["login", "recognize"],
  },
  geo_blocked: {
    retryable: true,
    requiresRetryConfirmation: false,
    actions: ["network"],
  },
  network: {
    retryable: true,
    requiresRetryConfirmation: false,
    actions: ["network"],
  },
  ytdlp_outdated: {
    retryable: true,
    requiresRetryConfirmation: false,
    actions: ["updateTool"],
  },
  need_po_token: {
    retryable: true,
    requiresRetryConfirmation: false,
    actions: ["recognize"],
  },
  unsupported: {
    retryable: true,
    requiresRetryConfirmation: false,
    actions: ["recognize"],
  },
  removed: {
    retryable: false,
    requiresRetryConfirmation: false,
    actions: [],
  },
  output_path_invalid: {
    retryable: true,
    requiresRetryConfirmation: false,
    actions: ["downloadSettings"],
  },
  media_tools_missing: {
    retryable: false,
    requiresRetryConfirmation: false,
    actions: ["appDownload", "diagnostics"],
  },
  output_verification_failed: {
    retryable: true,
    requiresRetryConfirmation: true,
    actions: ["diagnostics"],
  },
} as const satisfies Record<string, Omit<FailureRecoveryView, "detail">>;

export function failureRecoveryFor(
  errorCode: string | null | undefined,
  locale: Locale = getLocale(),
): FailureRecoveryView {
  const known = Object.prototype.hasOwnProperty.call(FAILURE_VIEWS, errorCode ?? "");
  const view = known ? FAILURE_VIEWS[errorCode as keyof typeof FAILURE_VIEWS] : UNKNOWN_FAILURE;
  return { ...view, detail: t(`failure.${known ? errorCode : "unknown"}`, locale) };
}
import { getLocale, t, type Locale } from "../../i18n";
