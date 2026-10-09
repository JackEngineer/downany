/** Durable MV3 receipts: exact URL + explicit route; never store headers/Cookies. */
(function(root) {
  const KEY = "deliveryReceiptsV1";
  function outputOptions(item) {
    const audio_only = item.audio_only === true || item.type === "audio";
    const quality = item.route === "media" || audio_only ? "best" : ["1080p","720p"].includes(item.quality) ? item.quality : "best";
    return {audio_only,quality};
  }
  async function identity(item) {
    const options=outputOptions(item);
    const key=options.audio_only || options.quality !== "best" ? [item.route,item.url,options.audio_only,options.quality] : [item.route,item.url];
    const bytes = new TextEncoder().encode(JSON.stringify(key));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,"0")).join("");
  }
  function createStore(storage) {
    const inFlight = new Map();
    let writeQueue = Promise.resolve();
    async function list() { return (await storage.get(KEY))[KEY] || {}; }
    async function update(key, entry) {
      const operation = writeQueue.then(async () => {
        const entries = await list(); entries[key] = entry;
        const bounded = Object.fromEntries(Object.entries(entries).sort((a,b) => b[1].at-a[1].at).slice(0,500));
        await storage.set({ [KEY]: bounded });
      });
      writeQueue = operation.catch(() => {}); await operation;
    }
    async function send(item, transport) {
      const key = await identity(item);
      if (inFlight.has(key)) return inFlight.get(key);
      const operation = (async () => {
        const existing = (await list())[key];
        if (existing?.state === "sent") return { ok: true, duplicate: true, taskIds: existing.taskIds };
        const requestId = existing?.requestId || crypto.randomUUID();
        await update(key, { state: "sending", at: Date.now(), requestId, route: item.route });
        let result;
        try { result = await transport(requestId); }
        catch { result = { ok: false, error: "发送结果未知，请重试核对回执" }; }
        const taskIds = result.taskIds || [];
        if (result.ok && taskIds.length === 0) result = { ok: false, error: "未收到任务回执，请更新桌面端后重试" };
        await update(key, { state: result.ok ? "sent" : "error", at: Date.now(), requestId, route: item.route, taskIds, error: result.error || "" });
        return result;
      })();
      inFlight.set(key, operation);
      try { return await operation; } finally { inFlight.delete(key); }
    }
    return { list, send };
  }
  const api = { identity, createStore, outputOptions };
  root.VideoDlDelivery = api;
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
