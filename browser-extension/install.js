/** 安装引导页：检测本机桥，并链到官网下载占位页。 */

const BRIDGE_BASE = "http://127.0.0.1:17888";
const DOWNLOAD_URL = "https://downany.app/download";

const statusEl = document.getElementById("status");
const recheckBtn = document.getElementById("recheck");
const downloadLink = document.getElementById("downloadLink");

if (downloadLink) {
  downloadLink.href = DOWNLOAD_URL;
}

function setStatus(kind, text) {
  if (!statusEl) return;
  if (!text) {
    statusEl.hidden = true;
    statusEl.textContent = "";
    statusEl.className = "status";
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

async function probeBridge() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(`${BRIDGE_BASE}/health`, {
      method: "GET",
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    return Boolean(res.ok && data && data.ok && data.sidecarReady !== false);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function recheck() {
  if (!recheckBtn) return;
  recheckBtn.disabled = true;
  recheckBtn.textContent = "检测中…";
  setStatus("", "");
  try {
    const ok = await probeBridge();
    if (ok) {
      setStatus("ok", "已检测到百纳，可以关闭本页，回到原网站重新点下载。");
      return;
    }
    setStatus(
      "err",
      "仍未检测到桌面端。请先安装或运行百纳，再点「重新检测」。",
    );
  } finally {
    recheckBtn.disabled = false;
    recheckBtn.textContent = "我已打开，重新检测";
  }
}

if (recheckBtn) {
  recheckBtn.addEventListener("click", () => {
    void recheck();
  });
}

void recheck();
