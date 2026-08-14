import { useEffect, useMemo, useState } from "react";

import type { TelegramConfig, TelegramDeliverySummary, TelegramTarget } from "../../electron/telegram/types";

function displayTarget(target: TelegramTarget): string {
  const kind = target.type === "private" ? "私聊" : target.type === "channel" ? "频道" : "群组";
  return `${target.title || target.id} · ${kind}`;
}

function deliveryStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: "等待发送",
    preparing: "准备发送",
    sending: "发送中",
    retry_wait: "稍后重试",
    sent: "已发送",
    failed: "发送失败",
    uncertain: "结果待确认",
    skipped_oversize: "文件过大",
    target_failed: "目标不可用",
  };
  return labels[status] || "状态未知";
}

export function TelegramSettingsTab({ disabled }: { disabled: boolean }): JSX.Element {
  const [config, setConfig] = useState<TelegramConfig | null>(null);
  const [targets, setTargets] = useState<TelegramTarget[]>([]);
  const [deliveries, setDeliveries] = useState<TelegramDeliverySummary[]>([]);
  const [token, setToken] = useState("");
  const [testText, setTestText] = useState("Downany 测试消息");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const next = await window.api.telegram.getConfig();
      setConfig(next);
      setTargets(next.discoveredTargets || []);
      const page = await window.api.telegram.listDeliveries(0, 10);
      setDeliveries(page.items || []);
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    void load();
    return window.api.onEvent((event) => {
      if (event.event.startsWith("telegramDelivery.")) void load();
    });
  }, []);

  const connected = Boolean(config?.accountId);
  const visibleTargets = useMemo(() => {
    const byId = new Map(targets.map((target) => [target.id, target]));
    if (config?.targetChatId && config.targetChatType) {
      const existing = byId.get(config.targetChatId);
      byId.set(config.targetChatId, {
        ...existing,
        id: config.targetChatId,
        type: config.targetChatType,
        title: config.targetChatTitle || existing?.title || config.targetChatId,
        lastSeenAt: existing?.lastSeenAt || config.targetVerifiedAt || undefined,
      });
    }
    return [...byId.values()];
  }, [config, targets]);
  const selectedTarget = useMemo(
    () => visibleTargets.find((target) => target.id === config?.targetChatId),
    [config?.targetChatId, visibleTargets],
  );

  const run = async <T,>(name: string, action: () => Promise<T>, success: string) => {
    setBusy(name);
    setError("");
    setMessage("");
    try {
      const result = await action();
      if (result && typeof result === "object" && "accountId" in result) {
        setConfig(result as TelegramConfig);
      }
      setMessage(success);
      void window.api.telegram.listDeliveries(0, 10).then((page) => setDeliveries(page.items || [])).catch(() => undefined);
      return result;
    } catch (err) {
      setError(String(err));
      return null;
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="settings-grid">
      <section className="settings-section">
        <h2>Telegram 自动转发</h2>
        <p className="muted">
          绑定 Bot 后，下载完成的文件会自动发送到你验证过的聊天。Token 只保存在本机系统加密存储中。
        </p>
        {!connected ? (
          <>
            <label className="settings-row">
              <span>Bot Token</span>
              <input
                type="password"
                value={token}
                disabled={disabled || busy !== ""}
                placeholder="从 @BotFather 复制 Token"
                autoComplete="off"
                onChange={(event) => setToken(event.target.value)}
              />
            </label>
            <div className="settings-control">
              <button
                type="button"
                disabled={disabled || busy !== "" || token.trim().length === 0}
                onClick={() => void run("bind", () => window.api.telegram.bind(token), "Bot 已绑定")}
              >
                {busy === "bind" ? "正在验证…" : "绑定 Bot"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="settings-row">
              <span>当前 Bot</span>
              <strong>{config?.botUsername ? `@${config.botUsername}` : config?.accountId}</strong>
            </div>
            <div className="settings-control">
              <button
                type="button"
                disabled={disabled || busy !== ""}
                onClick={() => void run("discover", async () => {
                  const found = await window.api.telegram.discoverTargets();
                  setTargets(found);
                  return found;
                }, "已更新聊天列表")}
              >
                {busy === "discover" ? "正在读取…" : "读取聊天"}
              </button>
              <button
                type="button"
                disabled={disabled || busy !== ""}
                onClick={() => void run("disconnect", async () => {
                  const next = await window.api.telegram.disconnect();
                  setTargets([]);
                  setToken("");
                  return next;
                }, "已断开 Telegram")}
              >
                断开连接
              </button>
            </div>
          </>
        )}
      </section>

      {connected && (
        <>
          <label className="settings-row">
            <span>接收聊天</span>
            <select
              value={config?.targetChatId || ""}
              disabled={disabled || busy !== "" || visibleTargets.length === 0}
              onChange={(event) => {
                const targetId = event.target.value;
                if (!targetId) return;
                void run("target", async () => {
                  const next = await window.api.telegram.selectTarget(targetId);
                  setConfig(next);
                  return next;
                }, "接收聊天已验证");
              }}
            >
              <option value="">请选择聊天</option>
              {visibleTargets.map((target) => (
                <option key={target.id} value={target.id}>
                  {displayTarget(target)}
                </option>
              ))}
            </select>
          </label>
          {selectedTarget && <p className="muted small">已验证：{displayTarget(selectedTarget)}</p>}

          <label className="settings-row">
            <span>下载完成后自动发送</span>
            <input
              type="checkbox"
              checked={Boolean(config?.autoSendEnabled)}
              disabled={disabled || busy !== "" || !config?.targetVerifiedAt}
              onChange={(event) => void run("toggle", () => window.api.telegram.setAutoSend(event.target.checked), event.target.checked ? "自动发送已开启" : "自动发送已关闭")}
            />
          </label>

          <label className="settings-row">
            <span>发送测试消息</span>
            <div className="settings-control">
              <input value={testText} disabled={disabled || busy !== ""} onChange={(event) => setTestText(event.target.value)} />
              <button
                type="button"
                disabled={disabled || busy !== "" || !config?.targetVerifiedAt}
                onClick={() => void run("test", () => window.api.telegram.sendTest(testText), "测试消息已发送")}
              >
                {busy === "test" ? "发送中…" : "发送"}
              </button>
            </div>
          </label>

          <section className="settings-section">
            <h2>最近发送</h2>
            {deliveries.length === 0 ? (
              <p className="muted">还没有可显示的发送记录。</p>
            ) : (
              deliveries.slice(0, 5).map((delivery) => (
                <div className="settings-row" key={delivery.id}>
                  <span title={delivery.title}>{delivery.title || delivery.taskId}</span>
                  <span className="muted">{deliveryStatusLabel(delivery.status)}</span>
                  {(delivery.status === "failed" || delivery.status === "uncertain") && (
                    <button
                      type="button"
                      disabled={disabled || busy !== ""}
                      onClick={() => {
                        const confirmPossibleDuplicate = delivery.status === "uncertain";
                        const confirmInterruptedOutput = delivery.lastErrorCode === "POSTPROCESS_INTERRUPTED";
                        if (confirmPossibleDuplicate && !window.confirm("Telegram 可能已经收到这条文件，确定要重试吗？")) return;
                        if (confirmInterruptedOutput && !window.confirm("后处理结果可能不完整，确定要继续发送吗？")) return;
                        void run(
                          "retry",
                          () => window.api.telegram.retry(delivery.id, confirmPossibleDuplicate, confirmInterruptedOutput),
                          "已重新加入发送队列",
                        );
                      }}
                    >
                      重试
                    </button>
                  )}
                </div>
              ))
            )}
          </section>
        </>
      )}

      {message && <p className="muted">{message}</p>}
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}
