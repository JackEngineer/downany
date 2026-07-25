/** 与 Python src/sidecar/protocol.py 对齐的常量与类型。 */
export const PROTOCOL_VERSION = 1;

export const Methods = [
  "app.getSnapshot",
  "app.ping",
  "app.shutdown",
  "app.runMigration",
  "download.parseUrls",
  "download.cancelParse",
  "download.createTasks",
  "download.pause",
  "download.pauseAll",
  "download.resume",
  "download.resumeAll",
  "download.cancel",
  "download.retry",
  "download.remove",
  "download.clearFinished",
  "history.list",
  "history.delete",
  "history.clear",
  "settings.get",
  "settings.update",
  "updater.checkYtDlp",
  "updater.updateYtDlp",
] as const;

export type Method = (typeof Methods)[number];

export type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "failed";

export interface ProtocolErrorBody {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export interface ProtocolEvent {
  event: string;
  payload: Record<string, unknown>;
}
