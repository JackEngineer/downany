/** 安装引导页：检测本机桥，并链到官网下载页。 */

const BRIDGE_BASE = "http://127.0.0.1:17888";
const DOWNLOAD_URL = "https://downany.app/download";

const statusEl = document.getElementById("status");
const recheckBtn = document.getElementById("recheck");
const downloadLink = document.getElementById("downloadLink");
const guideTitle = document.getElementById("guideTitle");
const guideLead = document.getElementById("guideLead");
const { installGuidePresentation } = globalThis.VideoDlShared;

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
    const presentation = installGuidePresentation(ok);
    if (guideTitle) guideTitle.textContent = presentation.title;
    if (guideLead) guideLead.textContent = presentation.lead;
    if (downloadLink) downloadLink.hidden = !presentation.showDownload;
    setStatus(presentation.statusKind, presentation.statusText);
    recheckBtn.textContent = presentation.buttonText;
  } finally {
    recheckBtn.disabled = false;
  }
}

if (recheckBtn) {
  recheckBtn.addEventListener("click", () => {
    void recheck();
  });
}

void recheck();
