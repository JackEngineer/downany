import { useEffect, useState } from "react";
import type { RuntimeInfo } from "../../electron/runtimeInfo";
import { useAppStore } from "../store/appStore";
import { useLocale } from "../i18n";

export function RuntimeStatus() {
  const [info, setInfo] = useState<RuntimeInfo | null>(null);
  const connection = useAppStore(s => s.connection);
  const locale = useLocale();
  useEffect(() => {
    let active = true;
    const refresh = () => { void window.api?.getRuntimeInfo?.().then(result => { if (active) setInfo(result); }).catch(() => { if (active) setInfo(null); }); };
    refresh(); const timer = setInterval(refresh, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [connection]);
  if (!info) return null;
  const en = locale === "en";
  return <div className="runtime-status" role="status">
    <span>{en ? "Running desktop" : "当前桌面"} {info.appVersion}</span>
    <span>{en ? "Download service" : "下载服务"} {info.sidecarVersion || (en ? "not connected" : "未连接")}</span>
    <span>{en ? "Extension connection" : "插件连接"}：{info.bridge === "listening" ? (en ? "available" : "可连接") : (en ? "unavailable; reopen the app" : "不可用，请重新打开应用")}</span>
    {info.versionMismatch && <span className="field-error">{en ? "Versions differ. Reopen the matching installation." : "桌面与下载服务版本不同，请重新打开同一安装版本。"}</span>}
  </div>;
}
