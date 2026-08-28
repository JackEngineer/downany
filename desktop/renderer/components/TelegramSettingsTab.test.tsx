import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TelegramSettingsTab } from "./TelegramSettingsTab";
import type { TelegramConfig, TelegramTarget } from "../../electron/telegram/types";

const target: TelegramTarget = {
  id: "-1001234567890",
  type: "supergroup",
  title: "Downany 测试群",
};

function config(partial: Partial<TelegramConfig> = {}): TelegramConfig {
  return {
    revision: "1",
    accountId: null,
    botUsername: null,
    targetChatId: null,
    targetChatType: "",
    targetChatTitle: null,
    targetVerifiedAt: null,
    autoSendEnabled: false,
    enabledAt: null,
    discoveredTargets: [],
    nextUpdateOffset: null,
    deliveryRecoveryHold: null,
    ...partial,
  };
}

describe("TelegramSettingsTab", () => {
  afterEach(() => cleanup());

  it("keeps the verified receiving chat visible when the discovery cache is empty", async () => {
    const selected = config({
      accountId: "bot-1",
      botUsername: "downany_bot",
      targetChatId: target.id,
      targetChatType: target.type,
      targetChatTitle: target.title,
      targetVerifiedAt: "2026-08-12T00:00:00.000Z",
      autoSendEnabled: true,
      enabledAt: "2026-08-12T00:00:01.000Z",
      discoveredTargets: [],
    });
    const telegram = {
      getConfig: vi.fn().mockResolvedValue(selected),
      bind: vi.fn(),
      discoverTargets: vi.fn(),
      selectTarget: vi.fn(),
      sendTest: vi.fn(),
      setAutoSend: vi.fn(),
      disconnect: vi.fn(),
      listDeliveries: vi.fn().mockResolvedValue({ items: [], total: 0, offset: 0, limit: 10 }),
      retry: vi.fn(),
    };
    (window as unknown as { api: unknown }).api = {
      telegram,
      onEvent: vi.fn(() => () => undefined),
    };

    render(<TelegramSettingsTab disabled={false} />);

    const targetSelect = await screen.findByRole("combobox");
    expect(targetSelect).toHaveValue(target.id);
    expect(targetSelect).not.toBeDisabled();
    expect(screen.getByRole("option", { name: "Downany 测试群 · 群组" })).toBeInTheDocument();
    expect(screen.getByText("已验证：Downany 测试群 · 群组")).toBeInTheDocument();
  });

  it("completes bind, target verification, and auto-forward enablement", async () => {
    const bound = config({
      accountId: "bot-1",
      botUsername: "downany_bot",
      discoveredTargets: [target],
    });
    const selected = config({
      ...bound,
      targetChatId: target.id,
      targetChatType: target.type,
      targetChatTitle: target.title,
      targetVerifiedAt: "2026-08-12T00:00:00.000Z",
    });
    const enabled = config({ ...selected, autoSendEnabled: true, enabledAt: "2026-08-12T00:00:01.000Z" });
    const telegram = {
      getConfig: vi.fn().mockResolvedValue(config()),
      bind: vi.fn().mockResolvedValue(bound),
      discoverTargets: vi.fn().mockResolvedValue([target]),
      selectTarget: vi.fn().mockResolvedValue(selected),
      sendTest: vi.fn().mockResolvedValue({ message_id: 1 }),
      setAutoSend: vi.fn().mockResolvedValue(enabled),
      disconnect: vi.fn(),
      listDeliveries: vi.fn().mockResolvedValue({ items: [], total: 0, offset: 0, limit: 10 }),
      retry: vi.fn(),
    };
    (window as unknown as { api: unknown }).api = {
      telegram,
      onEvent: vi.fn(() => () => undefined),
    };

    render(<TelegramSettingsTab disabled={false} />);
    await waitFor(() => expect(telegram.getConfig).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Bot Token"), { target: { value: "123456:secret" } });
    fireEvent.click(screen.getAllByRole("button")[0]);
    await waitFor(() => expect(telegram.bind).toHaveBeenCalledWith("123456:secret"));

    fireEvent.click(screen.getAllByRole("button")[0]);
    await waitFor(() => expect(telegram.discoverTargets).toHaveBeenCalled());
    const targetSelect = await screen.findByRole("combobox");
    fireEvent.change(targetSelect, { target: { value: target.id } });
    await waitFor(() => expect(telegram.selectTarget).toHaveBeenCalledWith(target.id));

    const autoSend = await screen.findByRole("checkbox");
    expect(autoSend).not.toBeDisabled();
    fireEvent.click(autoSend);
    await waitFor(() => expect(telegram.setAutoSend).toHaveBeenCalledWith(true));
  });

  it("keeps auto-forward disabled until a target is verified", async () => {
    const connected = config({ accountId: "bot-1", botUsername: "downany_bot", discoveredTargets: [target] });
    const telegram = {
      getConfig: vi.fn().mockResolvedValue(connected),
      bind: vi.fn(),
      discoverTargets: vi.fn(),
      selectTarget: vi.fn(),
      sendTest: vi.fn(),
      setAutoSend: vi.fn(),
      disconnect: vi.fn(),
      listDeliveries: vi.fn().mockResolvedValue({ items: [], total: 0, offset: 0, limit: 10 }),
      retry: vi.fn(),
    };
    (window as unknown as { api: unknown }).api = {
      telegram,
      onEvent: vi.fn(() => () => undefined),
    };

    render(<TelegramSettingsTab disabled={false} />);
    const autoSend = await screen.findByRole("checkbox");
    expect(autoSend).toBeDisabled();
    expect(telegram.setAutoSend).not.toHaveBeenCalled();
  });
});
