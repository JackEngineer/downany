import { TelegramClient } from "./client";
import { TelegramCredentialVault } from "./credentialVault";
import * as path from "node:path";
import {
  telegramChatIdSchema,
  telegramRetrySchema,
  telegramTokenSchema,
} from "./ipcSchemas";
import { TelegramDeliveryWorker } from "./deliveryWorker";
import type { TelegramVideoSegmenter } from "./videoSegmenter";
import type { TelegramBotApiSupervisor } from "./supervisor";
import type {
  TelegramChat,
  TelegramConfig,
  TelegramDeliverySummary,
  TelegramTarget,
  TelegramUpdate,
  TelegramUser,
} from "./types";

type SidecarRequest = (method: string, payload?: Record<string, unknown>) => Promise<unknown>;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function accountId(user: TelegramUser): string {
  return String(user.id);
}

function chatFromUpdate(update: TelegramUpdate): TelegramChat | null {
  return update.message?.chat || update.channel_post?.chat || null;
}

export class TelegramController {
  private readonly vault: TelegramCredentialVault;
  private client: TelegramClient | null = null;
  private config: TelegramConfig | null = null;
  private worker: TelegramDeliveryWorker;
  private started = false;
  private supervisor?: TelegramBotApiSupervisor;
  private readonly supervisorReady: Promise<void>;
  // Only an explicit development/test injection may replace the official
  // cloud endpoint. Packaged builds never inherit an ambient redirect.
  private readonly developmentApiBase?: string;
  private readonly videoSegmenter?: TelegramVideoSegmenter;
  // Renderer actions can arrive concurrently while a token or target is being
  // verified. Serialize all state-changing Telegram operations so an older
  // snapshot cannot be committed after a newer action has returned.
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly request: SidecarRequest,
    dataDir: string,
    private readonly onError: (error: Error) => void = () => undefined,
    supervisor?: TelegramBotApiSupervisor,
    supervisorReady: Promise<void> = Promise.resolve(),
    vault?: TelegramCredentialVault,
    developmentApiBase?: string,
    videoSegmenter?: TelegramVideoSegmenter,
  ) {
    this.supervisor = supervisor;
    this.supervisorReady = supervisorReady;
    this.developmentApiBase = developmentApiBase;
    this.videoSegmenter = videoSegmenter;
    this.vault = vault || new TelegramCredentialVault(path.join(dataDir, "telegram", "bot-token.v1"));
    this.worker = new TelegramDeliveryWorker(
      request,
      () => this.client,
      () => this.config?.accountId || null,
      onError,
      videoSegmenter,
    );
  }

  attachSupervisor(supervisor?: TelegramBotApiSupervisor): void {
    if (this.started) throw new Error("Telegram Controller 已启动，不能替换本地 Supervisor");
    this.supervisor = supervisor;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.supervisorReady;
    this.started = true;
    if (this.supervisor) await this.supervisor.start();
    await this.reload();
    await this.cleanupConfirmedSegments();
    if (this.config?.autoSendEnabled && this.client && this.config.accountId) this.worker.start();
  }

  private async cleanupConfirmedSegments(): Promise<void> {
    if (!this.videoSegmenter) return;
    const limit = 100;
    let offset = 0;
    while (true) {
      const page = (await this.request("telegram.listDeliveries", {
        offset,
        limit,
        status: "sent",
      })) as { items?: Array<{ id?: unknown }>; total?: unknown };
      const items = Array.isArray(page.items) ? page.items : [];
      for (const item of items) {
        const deliveryId = typeof item.id === "string" ? item.id : "";
        if (!deliveryId) continue;
        await this.videoSegmenter.cleanupDelivery(deliveryId).catch((error) => {
          this.onError(asError(error));
        });
      }
      offset += items.length;
      const total = Number(page.total);
      if (items.length === 0 || !Number.isSafeInteger(total) || offset >= total) return;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.supervisorReady;
    await this.worker.stop();
    if (this.supervisor) await this.supervisor.stop();
    this.client = null;
    this.started = false;
  }

  async getConfig(): Promise<TelegramConfig> {
    await this.reload();
    return this.config!;
  }

  async bind(token: string): Promise<TelegramConfig> {
    return this.enqueueMutation(async () => {
      const parsed = telegramTokenSchema.parse(token.trim());
      const previousAccountId = this.config?.accountId || null;
      const client = await this.createClient(parsed);
      const user = await client.getMe();
      await client.deleteWebhook();
      if (this.supervisor) {
        const cloud = new TelegramClient({ token: parsed, apiBase: "https://api.telegram.org" });
        const cloudUser = await cloud.getMe();
        await cloud.deleteWebhook();
        await cloud.logOut();
        const localUser = await client.getMe();
        if (String(localUser.id) !== String(cloudUser.id)) throw new Error("本地 Telegram 服务验证的 Bot 与云端不一致");
      }
      const id = accountId(user);
      // Validation is complete; stop the old account before changing the
      // vault/configuration so no old worker claim races with the replacement.
      await this.worker.stop();
      await this.vault.save(parsed);
      const updated = (await this.request("telegram.configure", {
        accountId: id,
        botUsername: user.username || "",
        autoSendEnabled: false,
        deliveryRecoveryHold: null,
      })) as TelegramConfig;
      // A credential refresh for the same Bot keeps its queue. A different
      // Bot must not inherit records captured for the old account: the
      // Sidecar worker claims only the current account, so leaving those
      // rows pending would make them permanently unreachable.
      if (previousAccountId && previousAccountId !== id) {
        await this.request("telegram.cancelPending", { accountId: previousAccountId });
      }
      this.client = client;
      this.config = updated;
      return updated;
    });
  }

  async discoverTargets(): Promise<TelegramTarget[]> {
    return this.enqueueMutation(async () => {
      const client = this.requireClient();
      await client.deleteWebhook();
      const updates = await client.getUpdates(this.config?.nextUpdateOffset || undefined);
      // getUpdates is incremental because nextUpdateOffset advances after each
      // refresh. Keep previously discovered chats instead of replacing the
      // complete cache with only the latest (possibly empty) page.
      const seen = new Map<string, TelegramTarget>(
        (this.config?.discoveredTargets || []).map((target) => [target.id, target]),
      );
      // Older builds could already have persisted an empty discovery cache.
      // The verified target fields remain authoritative, so restore that chat
      // before applying the new updates.
      if (this.config?.targetChatId && this.config.targetChatType) {
        const existing = seen.get(this.config.targetChatId);
        seen.set(this.config.targetChatId, {
          ...existing,
          id: this.config.targetChatId,
          type: this.config.targetChatType,
          title: this.config.targetChatTitle || existing?.title || this.config.targetChatId,
          lastSeenAt: existing?.lastSeenAt || this.config.targetVerifiedAt || undefined,
        });
      }
      for (const update of updates) {
        const chat = chatFromUpdate(update);
        if (!chat) continue;
        const id = String(chat.id);
        seen.set(id, {
          ...seen.get(id),
          id,
          type: chat.type,
          title: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || id,
          username: chat.username,
          lastSeenAt: new Date().toISOString(),
        });
      }
      const targets = [...seen.values()];
      const nextUpdateOffset = updates.length > 0
        ? (updates.map((update) => BigInt(String(update.update_id)) + 1n).reduce((max, value) => value > max ? value : max, 0n)).toString()
        : this.config?.nextUpdateOffset || null;
      this.config = (await this.request("telegram.configure", { discoveredTargets: targets, nextUpdateOffset })) as TelegramConfig;
      return targets;
    });
  }

  async selectTarget(targetId: string): Promise<TelegramConfig> {
    return this.enqueueMutation(async () => {
      const id = telegramChatIdSchema.parse(targetId);
      const chat = await this.requireClient().getChat(id);
      this.config = (await this.request("telegram.configure", {
        targetChatId: id,
        targetChatType: chat.type,
        targetChatTitle: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || id,
        targetVerifiedAt: new Date().toISOString(),
      })) as TelegramConfig;
      return this.config;
    });
  }

  async sendTest(text: string): Promise<unknown> {
    return this.enqueueMutation(async () => {
      const cfg = await this.getConfig();
      if (!cfg.targetChatId) throw new Error("请先选择接收目标");
      return this.requireClient().sendMessage(cfg.targetChatId, text.trim() || "Downany 测试消息");
    });
  }

  async setAutoSend(enabled: boolean): Promise<TelegramConfig> {
    return this.enqueueMutation(async () => {
      const cfg = await this.getConfig();
      if (enabled && (!this.client || !cfg.accountId || !cfg.targetChatId || !cfg.targetVerifiedAt)) {
        throw new Error("请先绑定 Bot 并验证接收目标");
      }
      if (!enabled) await this.worker.stop();
      this.config = (await this.request("telegram.configure", { autoSendEnabled: enabled })) as TelegramConfig;
      if (enabled) this.worker.start();
      return this.config;
    });
  }

  async disconnect(): Promise<TelegramConfig> {
    return this.enqueueMutation(async () => {
      const cfg = await this.getConfig();
      await this.worker.stop();
      if (cfg.accountId) await this.request("telegram.cancelPending", { accountId: cfg.accountId });
      this.config = (await this.request("telegram.configure", {
        accountId: null,
        botUsername: null,
        targetChatId: null,
        targetChatType: null,
        targetChatTitle: null,
        targetVerifiedAt: null,
        discoveredTargets: [],
        autoSendEnabled: false,
        enabledAt: null,
        deliveryRecoveryHold: null,
      })) as TelegramConfig;
      await this.vault.clear();
      this.client = null;
      return this.config;
    });
  }

  async listDeliveries(offset = 0, limit = 50): Promise<{ items: TelegramDeliverySummary[]; total: number; offset: number; limit: number }> {
    return (await this.request("telegram.listDeliveries", { offset, limit })) as { items: TelegramDeliverySummary[]; total: number; offset: number; limit: number };
  }

  async retry(deliveryId: string, confirmPossibleDuplicate = false, confirmInterruptedOutput = false): Promise<TelegramDeliverySummary> {
    return this.enqueueMutation(async () => {
      const parsed = telegramRetrySchema.parse({ deliveryId, confirmPossibleDuplicate, confirmInterruptedOutput });
      return (await this.request("telegram.retry", parsed)) as TelegramDeliverySummary;
    });
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(operation, operation);
    // A failed mutation must not poison the queue for the next user action.
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async reload(): Promise<void> {
    this.config = (await this.request("telegram.getConfig", {})) as TelegramConfig;
    // Never keep an in-memory client while revalidating the persisted token.
    // If the vault was replaced, corrupted, or belongs to another account,
    // retaining the old client would let a later worker start send with a
    // token that no longer matches the persisted configuration.
    this.client = null;
    const token = await this.vault.read();
    if (token && this.config.accountId) {
      try {
        const client = await this.createClient(token);
        const user = await client.getMe();
        if (accountId(user) === this.config.accountId) this.client = client;
      } catch (error) {
        this.onError(asError(error));
      }
    }
  }

  private requireClient(): TelegramClient {
    if (!this.client) throw new Error("请先绑定 Telegram Bot");
    return this.client;
  }

  private async createClient(token: string): Promise<TelegramClient> {
    await this.supervisorReady;
    if (this.supervisor) {
      const endpoint = await this.supervisor.start();
      return new TelegramClient({ token, apiBase: endpoint.baseUrl, useLocalFileUris: true });
    }
    const apiBase = this.developmentApiBase;
    const useLocalFileUris = Boolean(apiBase && /^https?:\/\/127\.0\.0\.1(?::\d+)?$/i.test(apiBase.replace(/\/$/, "")));
    return new TelegramClient({ token, apiBase, useLocalFileUris });
  }
}
