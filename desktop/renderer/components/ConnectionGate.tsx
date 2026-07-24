import { useAppStore } from "../store/appStore";
import { openPath } from "../lib/api";

export function ConnectionGate() {
  const logDir = useAppStore((s) => s.logDir);

  return (
    <div className="gate" role="alert">
      <h1>无法连接下载核心</h1>
      <p>Sidecar 未能启动或已断开。下载相关操作暂不可用。</p>
      <p className="mono">{logDir || "（日志目录未知）"}</p>
      <button type="button" onClick={() => void openPath(logDir)} disabled={!logDir}>
        打开日志目录
      </button>
    </div>
  );
}
