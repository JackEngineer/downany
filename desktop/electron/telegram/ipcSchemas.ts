import { z } from "zod";

export const telegramChatIdSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/, "接收位置 ID 无效");

export const telegramTokenSchema = z
  .string()
  .regex(/^\d{5,20}:[A-Za-z0-9_-]{20,}$/, "Bot Token 格式无效");

export const telegramTargetSchema = z.object({
  id: telegramChatIdSchema,
  type: z.enum(["private", "group", "supergroup", "channel"]),
  title: z.string().max(256),
  username: z.string().max(256).optional(),
  lastSeenAt: z.string().datetime({ offset: true }),
}).strict();

export const telegramConfigureSchema = z.object({
  accountId: z.string().max(64).optional(),
  botUsername: z.string().max(256).optional(),
  targetChatId: telegramChatIdSchema.optional(),
  targetChatType: z.enum(["private", "group", "supergroup", "channel"]).optional(),
  targetChatTitle: z.string().max(256).optional(),
  targetVerifiedAt: z.string().datetime({ offset: true }).nullable().optional(),
  autoSendEnabled: z.boolean().optional(),
  enabledAt: z.string().datetime({ offset: true }).nullable().optional(),
  discoveredTargets: z.array(telegramTargetSchema).max(200).optional(),
  nextUpdateOffset: z.string().regex(/^(?:0|[1-9][0-9]*)$/).nullable().optional(),
}).strict();

export const telegramDeliveryIdSchema = z.object({ deliveryId: z.string().min(1).max(128) }).strict();

export const telegramRetrySchema = telegramDeliveryIdSchema.extend({
  confirmPossibleDuplicate: z.boolean().default(false),
  confirmInterruptedOutput: z.boolean().default(false),
}).strict();

export type TelegramConfigureInput = z.infer<typeof telegramConfigureSchema>;
