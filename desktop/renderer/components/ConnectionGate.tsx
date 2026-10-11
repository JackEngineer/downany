import { useState } from "react";
import { RuntimeStatus } from "./RuntimeStatus";
import { t, useLocale } from "../i18n";
import { useAppStore } from "../store/appStore";
import { openPath } from "../lib/api";

export function ConnectionGate() {
  const locale = useLocale();
  const connection = useAppStore(s => s.connection);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const reconnect = async () => {
    if (busy) return; setBusy(true); setFailed(false);
    try { const result = await window.api.reconnect(); setFailed(!result.ok); }
    catch { setFailed(true); } finally { setBusy(false); }
  };
  const logDir = useAppStore((s) => s.logDir);
  const displayDir = logDir || t("connection.logPending", locale);

  return (
    <div className="gate" role="alert">
      <h1>{t("connection.title", locale)}</h1>
      <p>{t("connection.copy", locale)}</p>
      <RuntimeStatus />
      <p>{locale === "en" ? (["connecting", "reconnecting"].includes(connection) ? "Waiting for the download service…" : "The download service is unavailable. Reconnect or inspect the logs.") : (["connecting", "reconnecting"].includes(connection) ? "正在等待下载服务，连接恢复后任务会自动刷新。" : "下载服务未就绪。可重新连接；仍失败时查看日志，或重新打开应用。")}</p>
      <button type="button" disabled={busy || ["connecting", "reconnecting"].includes(connection)} onClick={() => void reconnect()}>{busy ? (locale === "en" ? "Connecting…" : "正在连接…") : (locale === "en" ? "Reconnect" : "重新连接")}</button>
      {failed && <p role="status">{locale === "en" ? "Could not reconnect. Reopen the app or inspect the logs." : "连接尚未恢复，请重新打开应用或查看日志。"}</p>}
      <p className="mono">{displayDir}</p>
      <button
        type="button"
        onClick={() => void openPath(logDir).catch(() => {
          useAppStore.getState().pushToast({ kind: "error", title: t("error.openFolder") });
        })}
        disabled={!logDir}
      >
        {t("connection.openLogs", locale)}
      </button>
    </div>
  );
}
