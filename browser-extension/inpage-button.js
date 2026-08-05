/** 页内一键下载：只负责发送入队；进度看工具栏角标与弹窗「最近发送」。 */

(function () {
  "use strict";

  const { findVideoCard } = globalThis.VideoDlShared || {};
  if (typeof findVideoCard !== "function") return;

  const STORAGE_KEY = "inpageButtonEnabled";
  const MIN_W = 200;
  const MIN_H = 120;
  /** 稍长一点，避开 Twitter 重绘导致的瞬时 out→over */
  const HIDE_DELAY_MS = 450;
  const DEDUPE_MS = 3000;
  const SUCCESS_RESET_MS = 2000;
  const APP_MISSING_RESET_MS = 5000;
  /** 位置变化小于该像素时不改 transform，避免 transition 闪 */
  const POS_EPSILON = 2;

  let enabled = true;
  /** @type {HTMLElement|null} */
  let hostEl = null;
  /** @type {ShadowRoot|null} */
  let shadow = null;
  /** @type {HTMLButtonElement|null} */
  let btn = null;
  /** @type {HTMLElement|null} */
  let currentVideo = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let hideTimer = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let resetTimer = null;
  let busy = false;
  /** @type {{key: string, at: number}|null} */
  let lastSend = null;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let lastTop = NaN;
  let lastLeft = NaN;
  /** 连续多少次“视频过小”才真正隐藏（抗 Twitter 布局抖动） */
  let smallHitCount = 0;

  function isFullscreen() {
    return Boolean(
      document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement,
    );
  }

  function videoTooSmall(video) {
    const rect = video.getBoundingClientRect();
    return rect.width < MIN_W || rect.height < MIN_H;
  }

  function ensureUi() {
    if (hostEl && btn) return;
    hostEl = document.createElement("div");
    hostEl.id = "downany-inpage-host";
    hostEl.setAttribute("data-downany", "inpage");
    Object.assign(hostEl.style, {
      all: "initial",
      position: "fixed",
      zIndex: "2147483646",
      top: "0",
      left: "0",
      width: "0",
      height: "0",
      pointerEvents: "none",
      display: "none",
    });
    shadow = hostEl.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        button {
          pointer-events: auto;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 10px;
          border: 0;
          border-radius: 999px;
          background: rgba(15, 23, 42, 0.88);
          color: #f8fafc;
          font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          cursor: pointer;
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
          backdrop-filter: blur(8px);
          opacity: 0;
          transform: translateY(-4px);
          transition: opacity 0.15s ease, background 0.15s ease;
          white-space: nowrap;
          user-select: none;
        }
        button.visible {
          opacity: 1;
          transform: translateY(0);
        }
        button:hover:not(:disabled) {
          background: rgba(37, 99, 235, 0.95);
        }
        button:disabled {
          cursor: default;
        }
        button.ok {
          background: rgba(22, 163, 74, 0.95);
        }
        button.err {
          background: rgba(220, 38, 38, 0.95);
        }
        .icon {
          width: 14px;
          height: 14px;
          flex: 0 0 auto;
        }
        .spin {
          animation: spin 0.8s linear infinite;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      </style>
      <button type="button" part="btn" title="用百纳下载" aria-label="用百纳下载">
        <svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 4v10m0 0l-4-4m4 4l4-4M5 18h14"
            stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="label">下载</span>
      </button>
    `;
    btn = shadow.querySelector("button");
    btn.addEventListener("mouseenter", cancelHide);
    btn.addEventListener("mouseleave", scheduleHide);
    btn.addEventListener("click", onClick);
    document.documentElement.appendChild(hostEl);
  }

  function destroyUi() {
    cancelHide();
    if (resetTimer) {
      clearTimeout(resetTimer);
      resetTimer = null;
    }
    if (hostEl && hostEl.parentNode) {
      hostEl.parentNode.removeChild(hostEl);
    }
    hostEl = null;
    shadow = null;
    btn = null;
    currentVideo = null;
    busy = false;
    lastTop = NaN;
    lastLeft = NaN;
    smallHitCount = 0;
  }

  function setLabel(text) {
    if (!btn) return;
    const label = btn.querySelector(".label");
    if (label) label.textContent = text;
  }

  function setIcon(kind) {
    if (!btn) return;
    const icon = btn.querySelector(".icon");
    if (!icon) return;
    icon.classList.remove("spin");
    if (kind === "loading") {
      icon.innerHTML =
        '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" fill="none" opacity="0.35"/><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>';
      icon.classList.add("spin");
      return;
    }
    if (kind === "ok") {
      icon.innerHTML =
        '<path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
      return;
    }
    if (kind === "err") {
      icon.innerHTML =
        '<path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/>';
      return;
    }
    icon.innerHTML =
      '<path d="M12 4v10m0 0l-4-4m4 4l4-4M5 18h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>';
  }

  function setState(kind, text, title) {
    if (!btn) return;
    btn.classList.remove("ok", "err");
    if (kind === "ok") btn.classList.add("ok");
    if (kind === "err") btn.classList.add("err");
    btn.disabled = kind === "loading" || kind === "ok";
    setIcon(kind === "idle" ? "download" : kind);
    setLabel(text);
    if (title != null) btn.title = title;
  }

  function scheduleIdleReset(delayMs) {
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      resetTimer = null;
      busy = false;
      if (currentVideo) {
        setState("idle", "下载", "用百纳下载（进度见扩展图标 / 弹窗）");
      } else {
        hideNow();
      }
    }, delayMs);
  }

  function pointerNearRect(rect, pad) {
    return (
      lastPointerX >= rect.left - pad &&
      lastPointerX <= rect.right + pad &&
      lastPointerY >= rect.top - pad &&
      lastPointerY <= rect.bottom + pad
    );
  }

  /** 指针是否仍在视频或其下载按钮附近（Shadow 的 relatedTarget 常为 null） */
  function pointerStillOnTarget() {
    if (btn) {
      try {
        if (btn.matches(":hover")) return true;
      } catch {
        // ignore
      }
      const br = btn.getBoundingClientRect();
      if (br.width > 0 && pointerNearRect(br, 4)) return true;
    }
    if (currentVideo && currentVideo.isConnected) {
      const vr = currentVideo.getBoundingClientRect();
      if (vr.width > 0 && pointerNearRect(vr, 8)) return true;
    }
    return false;
  }

  function positionOver(video) {
    if (!hostEl || !btn || !video) return;
    const rect = video.getBoundingClientRect();
    const top = Math.max(8, rect.top + 8);
    const left = Math.min(
      window.innerWidth - 110,
      Math.max(8, rect.right - 96),
    );
    const samePos =
      Number.isFinite(lastTop) &&
      Number.isFinite(lastLeft) &&
      Math.abs(top - lastTop) < POS_EPSILON &&
      Math.abs(left - lastLeft) < POS_EPSILON;

    if (hostEl.style.display !== "block") {
      hostEl.style.display = "block";
    }
    if (!samePos) {
      lastTop = top;
      lastLeft = left;
      hostEl.style.transform = `translate(${left}px, ${top}px)`;
    }
    if (!btn.classList.contains("visible")) {
      btn.classList.add("visible");
    }
  }

  function showFor(video) {
    if (!enabled || isFullscreen() || videoTooSmall(video)) {
      hideNow();
      return;
    }
    ensureUi();
    const sameVideo = currentVideo === video;
    const wasVisible =
      hostEl &&
      hostEl.style.display === "block" &&
      btn &&
      btn.classList.contains("visible");
    currentVideo = video;
    smallHitCount = 0;
    // 已在显示同一视频时不要反复 setState，避免图标/文案闪
    if (!busy && !(sameVideo && wasVisible)) {
      setState("idle", "下载", "用百纳下载（进度见扩展图标 / 弹窗）");
    }
    positionOver(video);
  }

  function hideNow() {
    cancelHide();
    if (btn) btn.classList.remove("visible");
    if (hostEl) hostEl.style.display = "none";
    currentVideo = null;
    lastTop = NaN;
    lastLeft = NaN;
    smallHitCount = 0;
  }

  function cancelHide() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function scheduleHide() {
    cancelHide();
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (busy) return;
      // Twitter / Shadow DOM：out 事件 relatedTarget 经常为空，真正离开再藏
      if (pointerStillOnTarget()) return;
      hideNow();
    }, HIDE_DELAY_MS);
  }

  function findVideoFromTarget(target) {
    if (!target || typeof target.closest !== "function") return null;
    const video = target.closest("video");
    if (video) return video;
    let node = target;
    for (let i = 0; i < 5 && node; i++) {
      if (typeof node.querySelector === "function") {
        const v = node.querySelector("video");
        if (v) return v;
      }
      node = node.parentElement;
    }
    return null;
  }

  function onPointerMove(e) {
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
  }

  function onPointerOver(e) {
    if (!enabled || busy) return;
    // 从按钮移回页面时不要重复处理
    if (
      e.target === hostEl ||
      (hostEl && hostEl.contains(e.target)) ||
      (shadow && shadow.contains(e.target))
    ) {
      cancelHide();
      return;
    }
    const video = findVideoFromTarget(e.target);
    if (!video) return;
    cancelHide();
    showFor(video);
  }

  function onPointerOut(e) {
    if (!enabled) return;
    const related = e.relatedTarget;
    if (related && hostEl && (related === hostEl || hostEl.contains(related))) {
      return;
    }
    if (related && shadow && shadow.contains(related)) {
      return;
    }
    // 移入 Shadow 按钮时 relatedTarget 常为 null：不要立刻判定离开
    const nextVideo = findVideoFromTarget(related);
    if (nextVideo && nextVideo === currentVideo) return;
    scheduleHide();
  }

  function onScrollOrResize() {
    if (!currentVideo || !hostEl || hostEl.style.display === "none") return;
    if (isFullscreen()) {
      hideNow();
      return;
    }
    if (videoTooSmall(currentVideo) || !currentVideo.isConnected) {
      smallHitCount += 1;
      // Twitter 重绘时 rect 可能短暂为 0，连续几次再藏，避免闪
      if (smallHitCount >= 3) hideNow();
      return;
    }
    smallHitCount = 0;
    positionOver(currentVideo);
  }

  function onFullscreenChange() {
    if (isFullscreen()) hideNow();
  }

  async function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!btn || busy) return;
    const video = currentVideo;
    if (!video) return;

    const card = findVideoCard(video, location, () =>
      (document.title || "").trim(),
    );
    const pageUrl = (card && card.pageUrl) || location.href;
    const title = (card && card.title) || (document.title || "").trim();
    const dedupeKey = pageUrl || location.href;
    const now = Date.now();
    if (
      lastSend &&
      lastSend.key === dedupeKey &&
      now - lastSend.at < DEDUPE_MS
    ) {
      return;
    }

    busy = true;
    setState("loading", "发送中…", "正在发送到百纳");
    try {
      const result = await chrome.runtime.sendMessage({
        type: "quickDownload",
        pageUrl,
        title,
      });
      if (result && result.ok) {
        lastSend = { key: dedupeKey, at: Date.now() };
        setState("ok", "已入队", "进度请看扩展图标角标或弹窗「最近发送」");
        scheduleIdleReset(SUCCESS_RESET_MS);
        return;
      }
      const error =
        (result && result.error) || "发送失败，请确认下载器已启动";
      setState("err", result && result.needApp ? "去安装" : "失败", error);
      scheduleIdleReset(
        result && result.needApp ? APP_MISSING_RESET_MS : SUCCESS_RESET_MS,
      );
      if (result && result.needApp) {
        void chrome.runtime.sendMessage({ type: "openInstallGuide" });
      }
    } catch (err) {
      setState("err", "失败", String(err?.message || err || "发送失败"));
      scheduleIdleReset(SUCCESS_RESET_MS);
    }
  }

  function bindEvents() {
    document.addEventListener("mousemove", onPointerMove, true);
    document.addEventListener("mouseover", onPointerOver, true);
    document.addEventListener("mouseout", onPointerOut, true);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
  }

  function applyEnabled(next) {
    enabled = !!next;
    if (!enabled) {
      destroyUi();
      return;
    }
    ensureUi();
  }

  function readEnabled() {
    try {
      chrome.storage.sync.get({ [STORAGE_KEY]: true }, (data) => {
        applyEnabled(data[STORAGE_KEY] !== false);
      });
    } catch {
      applyEnabled(true);
    }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync" && area !== "local") return;
      if (!Object.prototype.hasOwnProperty.call(changes, STORAGE_KEY)) return;
      applyEnabled(changes[STORAGE_KEY].newValue !== false);
    });
  } catch {
    // ignore
  }

  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || typeof message !== "object") return;
      if (message.type === "wakeStatus") {
        if (!busy || !btn) return;
        const text = String(message.message || "正在打开百纳…");
        setState("loading", text.length > 8 ? "打开中…" : text, text);
      }
    });
  } catch {
    // ignore
  }

  bindEvents();
  readEnabled();
})();
