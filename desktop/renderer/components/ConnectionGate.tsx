import { useAppStore } from "../store/appStore";
import { openPath } from "../lib/api";

const FALLBACK_LOG_DIR =
  typeof window !== "undefined"
    ? "" // filled after getLogDir; keep button disabled until known
    : "";

export function ConnectionGate() {
  const logDir = useAppStore((s) => s.logDir);
  const displayDir = logDir || "（日志目录加载中…可稍后在「设置 → 诊断」导出）";

  return (
    <div className="gate" role="alert">
      <h1>无法连接下载核心</h1>
      <p>Sidecar 未能启动或已断开。下载相关操作暂不可用。</p>
      <p className="mono">{displayDir}</p>
      <button
        type="button"
        onClick={() => void openPath(logDir || FALLBACK_LOG_DIR)}
        disabled={!logDir}
      >
        打开日志目录
      </button>
    </div>
  );
}
