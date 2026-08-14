export type TelegramTargetType = "private" | "group" | "supergroup" | "channel";

export interface TelegramTarget {
  id: string;
  type: TelegramTargetType;
  title: string;
  username?: string;
  lastSeenAt?: string;
}

export interface TelegramConfig {
  revision: string;
  accountId: string | null;
  botUsername: string | null;
  targetChatId: string | null;
  targetChatType: TelegramTargetType | "";
  targetChatTitle: string | null;
  targetVerifiedAt: string | null;
  autoSendEnabled: boolean;
  enabledAt: string | null;
  discoveredTargets: TelegramTarget[];
  nextUpdateOffset: string | null;
  deliveryRecoveryHold: { accountId: string; intent: "replace_account" | "disconnect"; createdAt: string } | null;
}

export interface TelegramDeliverySummary {
  id: string;
  taskId: string;
  accountId: string;
  targetChatId: string;
  targetChatType: TelegramTargetType;
  targetChatTitle: string;
  sourceUrl: string;
  title: string;
  status: string;
  attemptCount: number;
  fallbackUsed: boolean;
  nextAttemptAt: string | null;
  lastErrorCode: string;
  lastErrorMessage: string;
  telegramMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}

export interface TelegramSegmentPart {
  index: number;
  fileName: string;
  fileSize: number;
  sha256: string;
  videoWidth?: number;
  videoHeight?: number;
  durationSeconds?: number;
}

export interface TelegramVideoMetadata {
  width: number;
  height: number;
  durationSeconds: number;
}

export interface TelegramSegmentManifest {
  sourceFileSize: number;
  sourceFileMtimeNs: string;
  segmentDir: string;
  parts: TelegramSegmentPart[];
}

export interface TelegramClaimedDelivery {
  id: string;
  taskId: string;
  accountId: string;
  targetChatId: string;
  targetChatType: TelegramTargetType;
  targetChatTitle: string;
  sourceUrl: string;
  title: string;
  filePath: string;
  fileSize: number;
  fileMtimeNs: string;
  mediaKind: "video" | "audio" | "document" | "oversize_notice";
  attemptCount: number;
  retrySequenceCount: number;
  fallbackUsed: boolean;
  segmentManifest: TelegramSegmentManifest | null;
  segmentNextIndex: number;
  segmentMessageIds: string[];
}

export interface TelegramClaim {
  delivery: TelegramClaimedDelivery;
  leaseId: string;
}

export interface TelegramUpdate {
  update_id: number | string;
  message?: {
    chat?: TelegramChat;
    text?: string;
  };
  channel_post?: { chat?: TelegramChat; text?: string };
}

export interface TelegramChat {
  id: number | string;
  type: TelegramTargetType;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramMessageResult {
  message_id: number;
  chat?: TelegramChat;
}
