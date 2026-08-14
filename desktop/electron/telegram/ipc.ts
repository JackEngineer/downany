import { ipcMain } from "electron";

import { telegramRetrySchema, telegramTokenSchema } from "./ipcSchemas";
import type { TelegramController } from "./controller";

export function registerTelegramIpc(getController: () => TelegramController | null): void {
  const controller = () => {
    const value = getController();
    if (!value) throw new Error("Telegram 服务尚未启动");
    return value;
  };
  ipcMain.handle("telegram:getConfig", () => controller().getConfig());
  ipcMain.handle("telegram:bind", (_event, token: unknown) => controller().bind(telegramTokenSchema.parse(String(token || ""))));
  ipcMain.handle("telegram:discoverTargets", () => controller().discoverTargets());
  ipcMain.handle("telegram:selectTarget", (_event, targetId: unknown) => controller().selectTarget(String(targetId || "")));
  ipcMain.handle("telegram:sendTest", (_event, text: unknown) => controller().sendTest(String(text || "Downany 测试消息")));
  ipcMain.handle("telegram:setAutoSend", (_event, enabled: unknown) => controller().setAutoSend(Boolean(enabled)));
  ipcMain.handle("telegram:disconnect", () => controller().disconnect());
  ipcMain.handle("telegram:listDeliveries", (_event, offset: unknown, limit: unknown) => controller().listDeliveries(Number(offset || 0), Number(limit || 50)));
  ipcMain.handle("telegram:retry", (_event, payload: unknown) => {
    const parsed = telegramRetrySchema.parse(payload);
    return controller().retry(parsed.deliveryId, parsed.confirmPossibleDuplicate, parsed.confirmInterruptedOutput);
  });
}
