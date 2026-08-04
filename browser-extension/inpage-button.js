/** 页内一键下载：悬停视频时显示悬浮按钮，点击后经 background 入队。 */

(function () {
  "use strict";

  const { findVideoCard } = globalThis.VideoDlShared || {};
  if (typeof findVideoCard !== "function") return;

  const STORAGE_KEY = "inpageButtonEnabled";
  const MIN_W = 200;
  const MIN_H = 120;
  const HIDE_DELAY_MS = 400;
  const DEDUPE_MS = 3000;
  const SUCCESS_RESET_MS = 2000;
  const BTN_W = 88;
  const BTN_OFFSET = 8;

  let enabled = true;
  /** @type {HTMLElement|null} */
  let hostEl = null;
  /** @type {ShadowRoot|null} */
  let shadow = null;
  /** @type {HTMLButtonElement|null} */
  let btn = null;
  /** @type {HTMLElement|null} */
  let currentVideo = null;
  /** @type {HTMLElement|null} */
  let attachRoot = null;
  /** @type {HTMLElement|null} */
  let positionedByUs = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let hideTimer = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let resetTimer = null;
  let busy = false;
  let pointerOnButton = false;
  /** @type {{key: string, at: number}|null} */
  let lastSend = null;

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

  function isOurHost(node) {
    return Boolean(
      node &&
        hostEl &&
        (node === hostEl ||
          (typeof hostEl.contains === "function" && hostEl.contains(node))),
    );
  }

  /**
   * 把按钮挂进视频祖先节点，才能让预览卡片的 :hover 在指针移到按钮时仍生效。
   * 挂在 documentElement（fixed）会导致卡片失焦 → 预览缩回 → 闪烁。
   */
  function findAttachRoot(video) {
    if (!video || !video.parentElement) return null;
    const article = typeof video.closest === "function" ? video.closest("article") : null;
    if (article) return article;

    const vRect = video.getBoundingClientRect();
    let node = video.parentElement;
    let best = video.parentElement;
    for (let i = 0; i < 10 && node && node !== document.body; i++) {
      if (node === document.documentElement) break;
      const r = node.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) {
        node = node.parentElement;
        continue;
      }
      const containsVideo =
        r.left <= vRect.left + 1 &&
        r.top <= vRect.top + 1 &&
        r.right >= vRect.right - 1 &&
        r.bottom >= vRect.bottom - 1;
      if (!containsVideo) break;

      best = node;
      // 紧贴播放器外壳：足够盖住 video，又不会胀成整页卡片的外围空白
      const tight =
        r.width <= vRect.width * 1.35 && r.height <= vRect.height * 1.35;
      if (tight) return node;
      // 再大就容易碰到 overflow:hidden 裁切；停在上一个合适节点
      if (r.width > vRect.width * 2.5 || r.height > vRect.height * 2.5) {
        break;
      }
      node = node.parentElement;
    }
    return best;
  }

  function ensurePositioned(root) {
    if (!root || !(root instanceof Element)) return;
    const cs = window.getComputedStyle(root);
    if (cs.position === "static") {
      root.style.position = "relative";
      positionedByUs = root;
      root.setAttribute("data-downany-pos", "1");
    }
  }

  function clearPositionedByUs() {
    if (positionedByUs && positionedByUs.getAttribute("data-downany-pos") === "1") {
      positionedByUs.style.position = "";
      positionedByUs.removeAttribute("data-downany-pos");
    }
    positionedByUs = null;
  }

  function ensureUi() {
    if (hostEl && btn) return;
    hostEl = document.createElement("div");
    hostEl.id = "downany-inpage-host";
    hostEl.setAttribute("data-downany", "inpage");
    Object.assign(hostEl.style, {
      all: "initial",
      position: "absolute",
      zIndex: "2147483646",
      top: "0",
      left: "0",
      width: "0",
      height: "0",
      pointerEvents: "none",
      display: "none",
      margin: "0",
      padding: "0",
      border: "0",
      overflow: "visible",
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
          transition: opacity 0.15s ease, transform 0.15s ease, background 0.15s ease;
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
    btn.addEventListener("mouseenter", () => {
      pointerOnButton = true;
      cancelHide();
    });
    btn.addEventListener("mouseleave", () => {
      pointerOnButton = false;
      scheduleHide();
    });
    btn.addEventListener("click", onClick);
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
    clearPositionedByUs();
    hostEl = null;
    shadow = null;
    btn = null;
    currentVideo = null;
    attachRoot = null;
    busy = false;
    pointerOnButton = false;
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

  function scheduleIdleReset() {
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      resetTimer = null;
      busy = false;
      if (currentVideo) {
        setState("idle", "下载", "用百纳下载");
      } else {
        hideNow();
      }
    }, SUCCESS_RESET_MS);
  }

  function mountOn(video) {
    ensureUi();
    const root = findAttachRoot(video);
    if (!root || !hostEl) return false;

    if (attachRoot !== root) {
      clearPositionedByUs();
      ensurePositioned(root);
      root.appendChild(hostEl);
      attachRoot = root;
    } else if (hostEl.parentNode !== root) {
      ensurePositioned(root);
      root.appendChild(hostEl);
    }
    return true;
  }

  function positionOver(video) {
    if (!hostEl || !btn || !video || !attachRoot) return;
    const vRect = video.getBoundingClientRect();
    const rRect = attachRoot.getBoundingClientRect();
    // 绝对定位相对 attachRoot；保持在视频右上角内侧，避免 overflow 裁切
    let top = vRect.top - rRect.top + BTN_OFFSET;
    let left = vRect.right - rRect.left - BTN_W - BTN_OFFSET;
    top = Math.max(0, top);
    left = Math.max(0, Math.min(left, Math.max(0, rRect.width - BTN_W)));

    hostEl.style.display = "block";
    hostEl.style.top = `${top}px`;
    hostEl.style.left = `${left}px`;
    hostEl.style.transform = "none";
    btn.classList.add("visible");
  }

  function showFor(video) {
    if (!enabled || isFullscreen()) {
      hideNow();
      return;
    }
    // 指针已在按钮上时，忽略短暂尺寸抖动（预览缩放/失焦恢复帧）
    if (videoTooSmall(video) && !pointerOnButton) {
      hideNow();
      return;
    }
    if (!mountOn(video)) {
      hideNow();
      return;
    }
    currentVideo = video;
    if (!busy) {
      setState("idle", "下载", "用百纳下载");
    }
    positionOver(video);
  }

  function hideNow() {
    cancelHide();
    if (btn) btn.classList.remove("visible");
    if (hostEl) hostEl.style.display = "none";
    currentVideo = null;
    pointerOnButton = false;
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
      if (busy || pointerOnButton) return;
      hideNow();
    }, HIDE_DELAY_MS);
  }

  function findVideoFromTarget(target) {
    if (!target || typeof target.closest !== "function") return null;
    if (isOurHost(target)) return currentVideo;
    const video = target.closest("video");
    if (video) return video;
    // 部分站点把控件放在 video 兄弟节点上：向上找最近 video
    let node = target;
    for (let i = 0; i < 5 && node; i++) {
      if (isOurHost(node)) return currentVideo;
      if (typeof node.querySelector === "function") {
        const v = node.querySelector("video");
        if (v) return v;
      }
      node = node.parentElement;
    }
    return null;
  }

  function onPointerOver(e) {
    if (!enabled || busy) return;
    if (isOurHost(e.target)) {
      pointerOnButton = true;
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
    if (isOurHost(related) || (related && shadow && shadow.contains(related))) {
      pointerOnButton = true;
      cancelHide();
      return;
    }
    if (isOurHost(e.target)) {
      pointerOnButton = false;
    }
    const nextVideo = findVideoFromTarget(related);
    if (nextVideo && nextVideo === currentVideo) return;
    // 仍在同一挂载卡片内移动（预览控件 / 标题），不要藏按钮、也不要拆掉 hover
    if (
      currentVideo &&
      attachRoot &&
      related &&
      typeof attachRoot.contains === "function" &&
      attachRoot.contains(related)
    ) {
      cancelHide();
      return;
    }
    scheduleHide();
  }

  function onScrollOrResize() {
    if (currentVideo && hostEl && hostEl.style.display !== "none") {
      if (isFullscreen()) {
        hideNow();
        return;
      }
      if (videoTooSmall(currentVideo) && !pointerOnButton) {
        hideNow();
        return;
      }
      if (attachRoot && !attachRoot.isConnected) {
        hideNow();
        return;
      }
      positionOver(currentVideo);
    }
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
        setState("ok", "已入队", "已加入下载队列");
        scheduleIdleReset();
        return;
      }
      const error =
        (result && result.error) || "发送失败，请确认下载器已启动";
      setState("err", "失败", error);
      scheduleIdleReset();
    } catch (err) {
      setState("err", "失败", String(err?.message || err || "发送失败"));
      scheduleIdleReset();
    }
  }

  function bindEvents() {
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

  bindEvents();
  readEnabled();
})();
