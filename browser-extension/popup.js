/** Phase-one popup: explicit media/page routes and durable task receipts. */
const Shared = globalThis.VideoDlShared;
const $ = id => document.getElementById(id);
let currentTabId = -1, currentUrl = "", currentTitle = "", items = [], receipts = {}, recent = [], busy = false;
const selected = new Set();
const selectionKey = () => `popupSelection:${currentTabId}:${currentUrl}`;
const httpUrl = value => { try { return ["http:","https:"].includes(new URL(value).protocol); } catch { return false; } };
const message = value => chrome.runtime.sendMessage(value);
function status(text, error = false) { $("status").hidden = !text; $("status").textContent = text; $("status").className = error ? "status error" : "status ok"; }
function label(s) { return ({pending:"排队中",downloading:"下载中",paused:"已暂停",completed:"已完成",failed:"下载失败",cancelled:"已取消",unknown:"暂无法查询"})[s] || "已入队"; }
function element(tag, className, text) { const node=document.createElement(tag); node.className=className; if (text != null) node.textContent=text; return node; }
function receiptFor(item) { return receipts[item.deliveryKey]; }
function blocked(item) { const r=receiptFor(item); return r?.state === "sent" || (r?.state === "sending" && Date.now()-r.at < 90000); }
async function persistSelection() { await chrome.storage.session.set({[selectionKey()]: [...selected]}); }
function updateButtons() {
  const count=items.filter(item => selected.has(item.url) && !blocked(item)).length;
  $("enqueue").disabled=busy || !backgroundOutputReady || !count;
  $("enqueue").textContent=busy ? "发送中…" : `下载检测媒体${count ? ` (${count})` : ""}`;
  const page=receipts[currentPageKey];
  $("enqueuePage").disabled=busy || !backgroundOutputReady || !httpUrl(currentUrl) || page?.state === "sent" || (page?.state === "sending" && Date.now()-page.at < 90000);
  $("enqueuePage").textContent=page?.state === "sent" ? "本页已入队" : "解析本页视频";
}
let currentPageKey = "";
let outputPreference = {audio_only:false,quality:"best"};
const popupDeliveries = VideoDlDelivery.createStore(chrome.storage.local, chrome.storage.session);
const popupRecentKey = "popupSentTasksV1";
function outputFor(item) {return VideoDlDelivery.outputOptions({...item,...outputPreference});}
function outputLabel(item) {const o=outputFor(item);return item.type === "audio" ? "音频下载 · MP3" : o.audio_only ? "提取音频 · MP3" : item.route === "page" ? `视频 · ${o.quality === "best" ? "最高可用" : o.quality+" 偏好"}` : "视频 · 当前媒体清晰度";}
async function refreshOutputKeys() {
  for (const item of items) item.deliveryKey=await VideoDlDelivery.identity({...item,route:"media",...outputFor({...item,route:"media"})});
  currentPageKey=await VideoDlDelivery.identity({url:Shared.normalizeYtdlpPageUrl(currentUrl),route:"page",...outputFor({route:"page"})});
  $("qualityPreference").disabled=outputPreference.audio_only;
  $("outputHint").textContent=outputPreference.audio_only ? "视频会提取为 MP3；已检测音频按音频保存。清晰度偏好不适用于音频。" : "清晰度仅用于网页解析，实际取决于站点；检测媒体不能切换清晰度。";
  mediaSignature="";renderMedia();
}
async function taskAction(type, taskId) {
  const result = await message({type, taskId}).catch(()=>({ok:false}));
  status(result?.ok ? ({retrySend:"原任务已重试",revealTask:"已在文件夹显示成品",focusTask:"已定位桌面任务"})[type] : "操作未完成，请连接百纳并查看原任务", !result?.ok);
  await refresh();
}
let mediaSignature = "", recentSignature = "";
const expandedUrls = new Set();
function renderMedia() {
  const signature = JSON.stringify([items, receipts, recent.map(t=>[t.taskId,t.status]), [...selected], busy]);
  if (signature === mediaSignature) { updateButtons(); return; }
  mediaSignature = signature;
  const list=$("mediaList");list.replaceChildren();list.hidden=!items.length;$("toolbar").hidden=!items.length;
  $("count").textContent=items.length ? `${items.length} 个检测媒体` : "";
  $("empty").hidden=!!items.length;
  $("empty").textContent="尚未检测到媒体，不能据此判断登录状态。请先播放原页视频再打开弹窗；也可在百纳使用「网页识别」（浏览器抓取）。网页解析不保证每个网站可用。";
  for (const item of items) {
    const row=element("li","media-item");
    const cb=document.createElement("input");cb.type="checkbox";cb.checked=selected.has(item.url);cb.disabled=busy || blocked(item);cb.setAttribute("aria-label",`选择 ${item.media_title_verified ? item.title : "未确认标题的媒体"}`);
    cb.addEventListener("change",()=>{cb.checked ? selected.add(item.url):selected.delete(item.url);void persistSelection();updateButtons();});row.append(cb);
    const body=element("div","media-body");
    const cover=element("div","media-cover");
    if (item.matched && httpUrl(item.thumbnail_url)) { const image=document.createElement("img");image.src=item.thumbnail_url;image.referrerPolicy="no-referrer";image.alt="媒体封面";image.onerror=()=>{cover.replaceChildren(element("span","","封面不可用"));};cover.append(image); } else cover.textContent="暂无封面";
    body.append(cover);
    const title=item.media_title_verified && !Shared.isWeakPageTitle(item.title) ? item.title : "未确认媒体标题";
    body.append(element("p","media-name",title));
    const type=({file:"视频文件",audio:"音频",hls:"HLS",dash:"DASH"})[item.type] || "媒体";
    const size=item.size > 0 ? `${(item.size/1048576).toFixed(1)} MB` : "大小未知";
    const duration=item.duration > 0 ? `${Math.floor(item.duration/60)}:${String(Math.round(item.duration)%60).padStart(2,"0")}` : "时长未知";
    const resolution=item.width && item.height ? `${item.width} × ${item.height}` : item.resolution ? String(item.resolution) : "分辨率未知";
    body.append(element("p","media-size",`${type} · ${size} · ${duration} · ${resolution}`));
    body.append(element("p","media-host",`${new URL(item.url).host} · ${item.matched ? "已关联播放器" : "未关联播放器"} · ${outputLabel({...item,route:"media"})}`));
    const details=document.createElement("details");details.open=expandedUrls.has(item.url);details.addEventListener("toggle",()=>{details.open ? expandedUrls.add(item.url) : expandedUrls.delete(item.url);});details.append(element("summary","","查看媒体链接"));details.append(element("p","full-url",item.url));body.append(details);
    const receipt=receiptFor(item);
    if (receipt) {
      const task=recent.find(t=>receipt.taskIds?.includes(t.taskId));
      body.append(element("p","delivery-status",receipt.state === "sent" ? label(task?.status) : receipt.state === "sending" && Date.now()-receipt.at < 90000 ? "发送中…" : receipt.error || "发送结果待确认，可重试核对"));
      if (receipt.state === "sent" && receipt.taskIds?.[0]) {
        const open=element("button","linkish","在百纳查看");open.addEventListener("click",()=>void taskAction("focusTask",receipt.taskIds[0]));body.append(open);
      }
    }
    row.append(body);list.append(row);
  }
  updateButtons();
}
function renderRecent() {
  const signature=JSON.stringify(recent);if(signature===recentSignature)return;recentSignature=signature;
  $("recentSection").hidden=!recent.length;$("recentList").replaceChildren();
  const active=recent.filter(t=>["pending","downloading"].includes(t.status)).length;
  $("recentActive").hidden=!active;$("recentActive").textContent=`${active} 个进行中`;
  for (const task of recent.slice(0,8)) {
    const li=element("li","recent-item");li.append(element("p","recent-name",task.title || (task.route === "media" ? "检测媒体任务" : "网页解析任务")));
    li.append(element("p","recent-status",`${label(task.status)}${task.status === "downloading" ? ` ${Math.round(task.progress || 0)}%` : ""} · ${task.route === "media" ? "直接下载" : "网页解析"}${typeof task.audio_only === "boolean" ? ` · ${task.audio_only ? "MP3 音频" : task.quality && task.quality !== "best" ? task.quality+" 偏好" : "视频"}` : ""}`));
    if (task.connectionStale) li.append(element("p","recent-status","未连接，显示上次状态；恢复连接后核对"));
    if (task.status === "downloading") { const progress=document.createElement("progress");progress.max=100;progress.value=Math.max(0,Math.min(100,task.progress || 0));progress.setAttribute("aria-label","下载进度");li.append(progress); }
    if (task.status === "completed") { li.append(element("p","recent-status",task.hasFile ? `成品：${task.fileName || "已保存"}` : "成品未能定位，请在百纳查看原任务")); if (task.hasFile) { const reveal=element("button","linkish","显示成品文件");reveal.addEventListener("click",()=>void taskAction("revealTask",task.taskId));li.append(reveal); } }
    if (task.error) li.append(element("p","recent-error",task.error));
    const open=element("button","linkish","在百纳查看");open.addEventListener("click",()=>void taskAction("focusTask",task.taskId));li.append(open);
    if (Shared.canRetryTask(task)) { const retry=element("button","recent-retry","重试原任务");retry.addEventListener("click",async()=>{retry.disabled=true;try {await taskAction("retrySend",task.taskId);} finally {retry.disabled=false;}});li.append(retry); }
    $("recentList").append(li);
  }
}
let backgroundOutputReady = false;
let checkingConnection = false;
let refreshRunning = false;
async function refreshConnection() {
  if (checkingConnection) return;
  checkingConnection = true;
  try {
    const loaded = chrome.runtime.getManifest().version;
    const health = await message({type:"getBridgeHealth"}).catch(()=>null);
    backgroundOutputReady = health?.outputProtocol === 1;
    const p=Shared.bridgeConnectionPresentation(health);
    $("connection").className=`connection ${p.kind}`;$("connection").textContent=p.text;
    $("runtimeVersions").textContent=`插件 ${loaded} · 桌面 ${health?.appVersion || "未连接"} · 下载服务 ${health?.sidecarVersion || "未连接"}`;
    let detail = "";
    if (!health) detail="扩展后台未响应，请重新打开弹窗；仍失败时由你重新加载百纳扩展。";
    else if (health.versionMismatch) detail="桌面与下载服务版本不同，请重新打开同一安装版本。";
    else if (health.ok && health.sidecarReady === false) detail="桌面已打开，下载服务尚未就绪。稍候重连；仍失败时在桌面查看连接状态。";
    else if (!health.ok) detail=health.failureKind === "unexpected_service" ? "本地端口响应异常，请检查是否运行了其他版本或其他程序。" : "未能访问桌面。请打开百纳；若已运行，请检查浏览器的本地网络访问提示。连接失败不代表未安装。";
    $("connectionDetail").textContent=detail;$("connectionDetail").hidden=!detail;
    $("openDesktop").hidden=health?.ok === true && health.sidecarReady !== false;
    updateButtons();
  } finally {checkingConnection=false;}
}

async function refresh() {
  if (refreshRunning) return; refreshRunning=true;
  try {
    const [r,t]=await Promise.all([message({type:"getDeliveries"}).catch(()=>null),message({type:"getSentTasks"}).catch(()=>null)]);
    receipts=r?.entries || await popupDeliveries.list();
    const own=(await chrome.storage.local.get(popupRecentKey))[popupRecentKey] || [];
    recent=[...own,...(t?.tasks || []).filter(task=>!own.some(item=>item.taskId===task.taskId))].slice(0,50);
    if (recent.length) {
      const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),2500);
      try {
        const ids=recent.map(task=>task.taskId).filter(Boolean).slice(0,50);
        const response=await fetch(`http://127.0.0.1:17888/tasks?ids=${encodeURIComponent(ids.join(","))}`,{signal:ctrl.signal,cache:"no-store"});
        const data=await response.json();
        if(response.ok && data.ok && Array.isArray(data.tasks)) {
          recent=recent.map(task=>{const live=data.tasks.find(item=>item.taskId===task.taskId || item.id===task.taskId);return live ? {...task,...live,error:Shared.taskFailureMessage(live.error, live.errorCode || live.error_code),hasFile:live.hasFile === true,connectionStale:false} : {...task,status:"unknown",hasFile:false};});
          await chrome.storage.local.set({[popupRecentKey]:recent.map(task=>({taskId:task.taskId,title:task.title,route:task.route,audio_only:task.audio_only,quality:task.quality,status:task.status,progress:task.progress,sentAt:task.sentAt,error:task.error,errorCode:task.errorCode || task.error_code || "",hasFile:task.hasFile,fileName:task.fileName}))});
        }
      } catch { recent=recent.map(task=>({...task,hasFile:false,connectionStale:true})); } finally {clearTimeout(timer);}
    }
    renderMedia();renderRecent();
    if ($("status").textContent === "无法读取扩展回执，请重新打开弹窗") status("");
  } catch { status("无法读取扩展回执，请重新打开弹窗",true); } finally {refreshRunning=false;}
}
async function rescan() {
  if (currentTabId < 0 || !httpUrl(currentUrl)) return;
  try {
    const payload=await chrome.tabs.sendMessage(currentTabId,{type:"rescan"});
    if (payload?.items) await message({type:"domMedia",tabId:currentTabId,...payload});
  } catch {
    try { await chrome.scripting.executeScript({target:{tabId:currentTabId},files:["shared.js","content.js"]}); } catch { /* Restricted page; explain empty state. */ }
  }
}
async function loadMedia() {
  const result=await message({type:"getMedia",tabId:currentTabId});
  items=await Promise.all((result?.items || []).filter(i=>httpUrl(i.url) && i.type !== "page").map(async i=>({...i,deliveryKey:await VideoDlDelivery.identity({...i,route:"media",...outputFor({...i,route:"media"})})})));
  const urls=new Set(items.map(i=>i.url));for (const url of selected) if (!urls.has(url)) selected.delete(url);
  renderMedia();
}
async function send(sendItems) {
  if (busy || !sendItems.length) return;
  busy=true;renderMedia();status("正在发送并等待任务回执…");
  try {
    const normalized=sendItems.map(item=>({...item,...outputFor(item)}));
    const result=await message({type:"enqueueExplicit",tabId:currentTabId,items:normalized});
    status(result?.ok ? "已收到任务回执；进度见卡片与最近发送" : result?.error || result?.results?.find(r=>!r.ok)?.error || "部分任务未发送，请查看卡片状态",!result?.ok);
    await refresh();
  } catch { status("发送结果待确认，请重新打开查看回执",true); }
  finally { busy=false;renderMedia();void refreshConnection(); }
}
$("enqueue").addEventListener("click",()=>void send(items.filter(i=>selected.has(i.url) && !blocked(i)).map(i=>({url:i.url,route:"media",type:i.type,pageUrl:i.pageUrl || currentUrl,title:i.media_title_verified ? i.title : "",media_title_verified:i.media_title_verified === true,thumbnail_url:i.matched ? i.thumbnail_url : ""}))));
$("enqueuePage").addEventListener("click",()=>void send([{url:Shared.normalizeYtdlpPageUrl(currentUrl),route:"page",pageUrl:currentUrl,title:""}]));
$("selectAll").addEventListener("click",()=>{for (const item of items) if (!blocked(item)) selected.add(item.url);void persistSelection();renderMedia();});
$("selectNone").addEventListener("click",()=>{selected.clear();void persistSelection();renderMedia();});
$("openDesktop").addEventListener("click",async()=>{ $("openDesktop").disabled=true;status("正在打开百纳…");try {const result=await message({type:"openDesktop"});status(result?.ok ? "百纳已就绪" : "未能唤起，请从应用程序打开百纳后重连",!result?.ok);await refreshConnection();} catch {status("请从应用程序打开百纳后重连",true);} finally {$("openDesktop").disabled=false;} });
$("refreshConnection").addEventListener("click",()=>void refreshConnection());
const preference="inpageButtonEnabled";
chrome.storage.sync.get({[preference]:true},data=>{$("inpageButtonToggle").checked=data[preference] !== false;});
$("inpageButtonToggle").addEventListener("change",()=>chrome.storage.sync.set({[preference]:$("inpageButtonToggle").checked}));
(async()=>{
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if (!tab) {status("请先打开一个网页",true);return;}
  currentTabId=tab.id;currentUrl=tab.url || "";currentTitle=tab.title || "未命名页面";
  $("title").textContent=currentTitle;$("url").textContent=currentUrl;$("url").title=currentUrl;
  currentPageKey=await VideoDlDelivery.identity({url:Shared.normalizeYtdlpPageUrl(currentUrl),route:"page"});
  const outputSaved=(await chrome.storage.local.get("popupOutputPreferencesV1")).popupOutputPreferencesV1;
  if(outputSaved) outputPreference=VideoDlDelivery.outputOptions({route:"page",...outputSaved});
  $("outputMode").value=outputPreference.audio_only ? "audio" : "video";$("qualityPreference").value=outputPreference.quality;
  await refreshOutputKeys();
  const saved=await chrome.storage.session.get(selectionKey());for (const u of saved[selectionKey()] || []) selected.add(u);
  await refreshConnection();await rescan();await loadMedia();await refresh();
  if (!saved[selectionKey()] && items.length) {const first=items.find(i=>i.matched && i.media_title_verified && i.thumbnail_url && !blocked(i)) || items.find(i=>i.matched && !blocked(i));if(first) selected.add(first.url);await persistSelection();renderMedia();}
  let tick=0;
  setInterval(()=>{void refresh();if(++tick%3 === 0){void refreshConnection();void rescan().then(loadMedia);}},1000);
})().catch(()=>status("无法读取当前页面，请重新打开弹窗",true));

for(const id of ["outputMode","qualityPreference"]) $(id).addEventListener("change",async()=>{
 outputPreference=VideoDlDelivery.outputOptions({route:"page",audio_only:$("outputMode").value === "audio",quality:$("qualityPreference").value});
 await chrome.storage.local.set({popupOutputPreferencesV1:outputPreference});await refreshOutputKeys();
});
