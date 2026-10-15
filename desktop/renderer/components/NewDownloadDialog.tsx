import { useEffect, useRef, useState } from "react";
import { request, onEvent, openExtractWindow } from "../lib/api";
import { refreshQueueAfterChange } from "../lib/refreshQueue";
import { useAppStore } from "../store/appStore";
import type { FormatOption, ParseResultEvent, TaskLoginMode } from "../lib/types";
import { formatOptionLabel, formatSelectorValue } from "../lib/formats";
import { Icon } from "./ui/Icon";
import "../styles/new-download.css";

type Row = { id:string; url:string; source:string; title:string; status:"pending"|"ready"|"error"|"cancelled"|"added"; selected:boolean; unavailable?:boolean; thumb?:string; formats?:FormatOption[]; formatId?:string; group?:string; groupTitle?:string; index?:number };
export function normalizeDraft(text:string): { urls:string[]; duplicates:number; error?:string } {
 const lines=text.split(/\r?\n/).map(v=>v.trim()).filter(Boolean), urls:string[]=[]; let duplicates=0;
 if(!lines.length)return {urls,duplicates,error:"先输入一个视频或网页链接。"};
 if(lines.length>50)return {urls,duplicates,error:"一次最多添加50个链接，请分批添加。"};
 for(let i=0;i<lines.length;i++){try{const u=new URL(lines[i]);if(!["http:","https:"].includes(u.protocol)||!u.hostname||u.username||u.password)throw Error();u.hash="";if(urls.includes(u.href))duplicates++;else urls.push(u.href);}catch{return {urls:[],duplicates,error:`第${i+1}行需要有效的http(s)链接，请检查后重试。`};}}
 return {urls,duplicates};
}
function host(url:string){try{return new URL(url).hostname}catch{return "来源待确认"}}
function safeThumb(url?:string){return url&&/^(https:\/\/|downany-thumb:\/\/)/.test(url)?url:undefined}
export function NewDownloadDialog({open,onClose}:{open:boolean;onClose:()=>void}) {
 const settings=useAppStore(s=>s.settings),tasks=useAppStore(s=>s.tasks),pending=useAppStore(s=>s.pendingAddUrls),pendingMode=useAppStore(s=>s.pendingAddLoginMode),connection=useAppStore(s=>s.connection);
 const dialog=useRef<HTMLDialogElement>(null),input=useRef<HTMLTextAreaElement>(null),opener=useRef<HTMLElement|null>(null),generation=useRef(0),activeId=useRef<string|null>(null),starting=useRef(false),submitLock=useRef(false),eventBuffer=useRef<ParseResultEvent[]>([]),mounted=useRef(true);
 const [draft,setDraft]=useState(""),[rows,setRows]=useState<Row[]>([]),[parsing,setParsing]=useState(false),[submitting,setSubmitting]=useState(false),[notice,setNotice]=useState(""),[error,setError]=useState(""),[duplicates,setDuplicates]=useState(0),[created,setCreated]=useState(0),[format,setFormat]=useState("default"),[quality,setQuality]=useState("default"),[folder,setFolder]=useState<string|null>(null),[subtitles,setSubtitles]=useState<boolean|null>(null),[naming,setNaming]=useState("default"),[login,setLogin]=useState<TaskLoginMode>("auto"),[ranges,setRanges]=useState<Record<string,string>>({});
 const existing=(row:Row)=>row.status==="added"||tasks.some(t=>t.url===row.url);
 const chosen=rows.filter(r=>r.status==="ready"&&r.selected&&!r.unavailable&&!existing(r));
 const failures=rows.filter(r=>["error","cancelled"].includes(r.status));
 const cancel=()=>{generation.current++;starting.current=false;eventBuffer.current=[];const id=activeId.current;activeId.current=null;if(id)void request("download.cancelParse",{parseId:id}).catch(()=>undefined);setParsing(false);setRows(prev=>prev.map(r=>r.status==="pending"?{...r,status:"cancelled"}:r));};
 const close=()=>{if(submitLock.current)return;cancel();onClose();};
 const resetResults=(value:string)=>{cancel();setDraft(value);setRows([]);setCreated(0);setError("");setNotice("");};
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;const id=activeId.current;if(id)void request("download.cancelParse",{parseId:id}).catch(()=>undefined);};},[]);
 useEffect(()=>{if(!pending)return;resetResults(pending.join("\n"));setLogin(pendingMode);useAppStore.getState().setPendingAddUrls(null);},[pending]);
 useEffect(()=>{const d=dialog.current;if(!d)return;if(open){opener.current=document.activeElement as HTMLElement;if(!d.open)d.showModal();requestAnimationFrame(()=>input.current?.focus());}else if(d.open){d.close();requestAnimationFrame(()=>{const target=opener.current?.isConnected?opener.current:document.querySelector<HTMLButtonElement>('.titlebar-new');target?.focus();});}},[open]);
 const accept=(data:ParseResultEvent)=>{
  if(data.parseId!==activeId.current)return;
  setRows(previous=>{
   const pos=previous.findIndex(r=>r.source===data.url&&r.status==="pending");if(pos<0)return previous;
   const seed=previous[pos];let replacements:Row[];
   if(data.ok&&data.entries?.length){const group=`${data.parseId}-${data.index}`;replacements=data.entries.map((e,i)=>({id:`${group}-${i}`,url:e.url,source:data.url,title:e.title||e.id||host(e.url),status:"ready",selected:e.available!==false&&e.available!=="0",unavailable:e.available===false||e.available==="0",thumb:safeThumb(e.thumbnail_url),group,groupTitle:data.playlist?.title||data.info?.title,index:Number(e.index)||i+1}));}
   else replacements=[{...seed,status:data.cancelled?"cancelled":data.ok&&data.info?"ready":"error",title:data.info?.title||seed.title,thumb:safeThumb(data.info?.thumbnail_url),formats:data.info?.formats,selected:Boolean(data.ok&&data.info)}];
   const next=[...previous.slice(0,pos),...replacements,...previous.slice(pos+1)];if(!next.some(r=>r.status==="pending")){setParsing(false);activeId.current=null;}return next;
  });
 };
 const wasParsing=useRef(false);
 useEffect(()=>{if(wasParsing.current&&!parsing&&open)requestAnimationFrame(()=>dialog.current?.querySelector<HTMLButtonElement>('.nd-footer-actions .primary:not(:disabled)')?.focus());wasParsing.current=parsing;},[parsing,open]);
 const acceptRef=useRef(accept);acceptRef.current=accept;
 useEffect(()=>onEvent(event=>{if(event.event!=="download.parseResult")return;const data=event.payload as unknown as ParseResultEvent;if(starting.current){if(eventBuffer.current.length<10000)eventBuffer.current.push(data);}else acceptRef.current(data);}),[]);
 const analyze=async(retryOnly=false)=>{
  if(starting.current||parsing||submitLock.current||connection!=="connected")return;
  const normalized=normalizeDraft(draft);if(normalized.error&&!retryOnly){setError(normalized.error);input.current?.focus();return;}
  const urls=retryOnly?[...new Set(failures.map(r=>r.source))]:normalized.urls;if(!urls.length)return;
  cancel();const token=generation.current;setError("");setNotice("");setDuplicates(normalized.duplicates);setCreated(0);
  const seeds=urls.map((url,i):Row=>({id:`${token}-${i}`,url,source:url,title:host(url),status:"pending",selected:false}));
  setRows(prev=>retryOnly?[...prev.filter(r=>!urls.includes(r.source)),...seeds]:seeds);setParsing(true);starting.current=true;
  try{const result=await request<{parseId:string}>("download.parseUrls",{urls,allow_playlist:true,login_mode:login});
   if(token!==generation.current||!mounted.current){void request("download.cancelParse",{parseId:result.parseId}).catch(()=>undefined);return;}
   activeId.current=result.parseId;starting.current=false;const events=eventBuffer.current;eventBuffer.current=[];for(const e of events)acceptRef.current(e);
  }catch{if(token===generation.current&&mounted.current){starting.current=false;setParsing(false);setRows(prev=>prev.map(r=>r.status==="pending"?{...r,status:"error"}:r));setError("未能开始解析，请确认下载服务已连接后重试。");}}
 };
 const start=async()=>{
  if(submitLock.current||parsing||!chosen.length||connection!=="connected")return;
  submitLock.current=true;setSubmitting(true);setError("");setNotice("");let count=0;const added=new Set<string>(),failed=new Set<string>();
   const task_options:Record<string,unknown>={};if(folder)task_options.output_path=folder;if(quality!=="default")task_options.quality=quality;if(format!=="default")task_options.postprocessing=format;if(subtitles!==null)task_options.download_subtitles=subtitles;if(naming!=="default")task_options.filename_template=naming==="original"?"":"%(title)s_%(upload_date)s.%(ext)s";
  try{
   for(const r of chosen){
    if(added.has(r.url)||useAppStore.getState().tasks.some(t=>t.url===r.url)){added.add(r.url);continue;}
    try{const result=await request<{taskIds?:string[]}>("download.createTasks",{urls:[r.url],expand_playlists:false,login_mode:login,task_options,items:[{url:r.url,title:r.title,thumbnail_url:r.thumb,format_id:format==="mp3"?undefined:r.formatId,group_id:r.group,group_title:r.groupTitle,playlist_index:r.index}]});if(!result.taskIds?.length)throw Error();added.add(r.url);count+=result.taskIds.length;}
    catch{failed.add(r.url);}
   }
   try{await refreshQueueAfterChange();}catch{setNotice("任务已提交，但队列暂未刷新。请先检查工作台，避免重复添加。");}
   if(mounted.current){setRows(prev=>prev.map(r=>added.has(r.url)?{...r,status:"added",selected:false}:failed.has(r.url)?{...r,selected:true}:r));setCreated(count);if(failed.size)setError(`${failed.size}项未能确认添加。请检查队列与保存位置后，重试未添加项。`);else if(count)setNotice(`已添加${count}个任务。未选择或解析失败的链接仍保留。`);}
  }finally{submitLock.current=false;if(mounted.current)setSubmitting(false);}
 };
 const paste=async()=>{try{const text=await window.api.readClipboardText();if(open&&!submitLock.current){resetResults(text);input.current?.focus();}}catch{setError("无法粘贴，请在输入框中手动粘贴链接。");}};
 const browse=async()=>{try{const path=await window.api.selectDirectory();if(path)setFolder(path);}catch{setError("无法选择位置，请稍后重试。");}};
 const range=(group:string)=>{const value=ranges[group]||"";const selected=new Set<number>();for(const part of value.split(/[,，\s]+/)){const m=/^(\d+)(?:[-–](\d+))?$/.exec(part);if(!m)continue;const a=Number(m[1]),b=Number(m[2]||m[1]);if(Math.abs(b-a)>10000)continue;for(let i=Math.min(a,b);i<=Math.max(a,b);i++)selected.add(i);}if(!selected.size){setError("请输入有效集数，例如1-3,5。");return;}setRows(prev=>prev.map(r=>r.group===group?{...r,selected:!r.unavailable&&selected.has(r.index||0)}:r));};
 const busy=parsing||submitting;
 return <dialog ref={dialog} className="new-download-dialog" aria-modal="true" aria-labelledby="nd-title" onCancel={e=>{e.preventDefault();close();}} onKeyDown={e=>{
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="f"){e.preventDefault();e.stopPropagation();}
  if(e.key==="Tab"){const nodes=Array.from(dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),input:not(:disabled),select:not(:disabled),summary')).filter(n=>n.getClientRects().length);const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
  if(e.key==="Enter"&&!e.shiftKey&&!e.nativeEvent.isComposing&&e.nativeEvent.keyCode!==229){if((e.metaKey||e.ctrlKey)&&chosen.length){e.preventDefault();void start();}else if(e.target===input.current){e.preventDefault();void analyze();}}
 }}>
 <header className="nd-header"><span className="nd-heading-icon"><Icon name="plus" size={23}/></span><div><span className="nd-eyebrow">DOWNANY</span><h2 id="nd-title">新建下载</h2><p className="nd-subtitle">一个视频，或每行一个链接。</p></div><button className="nd-close icon-button" aria-label="关闭新建下载，保留草稿" disabled={submitting} onClick={close}><Icon name="close" size={19}/></button></header>
 <div className="nd-body"><div className="nd-label-row"><label htmlFor="nd-links" className="nd-field-label">视频或网页链接</label><button className="nd-paste" disabled={busy} onClick={()=>void paste()}>粘贴链接</button></div><textarea ref={input} id="nd-links" className="nd-url-input" rows={rows.length?2:3} value={draft} onChange={e=>resetResults(e.target.value)} placeholder="https://…" aria-label="视频或网页链接" disabled={busy} spellCheck={false}/><div className="nd-input-hint"><span>每行一个链接 · 最多50个</span><span>Enter解析 · Shift+Enter换行</span></div>
 {error&&<p className="nd-validation" role="alert">{error}</p>}{notice&&<p className="nd-inline-note" role="status">{notice}</p>}{connection!=="connected"&&<p className="nd-validation" role="status">下载服务尚未连接，连接恢复后可以继续。</p>}
 {parsing&&<div className="nd-parsing" role="status"><Icon name="link" size={22}/><div><strong>正在解析链接</strong><p>读取媒体信息与可用格式，不会创建下载任务。</p></div></div>}
 {rows.length>0&&<><div className="nd-result-heading"><strong>识别结果</strong><span>已选{chosen.length}项</span></div>{duplicates>0&&<p className="nd-inline-note">已合并{duplicates}个重复链接</p>}<div className="nd-result-list">{rows.map((r,i)=><div key={r.id}>
 {r.group&&rows.findIndex(v=>v.group===r.group)===i&&<div className="nd-group"><strong>{r.groupTitle||"合集选集"}</strong><button onClick={()=>setRows(prev=>prev.map(v=>v.group===r.group?{...v,selected:!v.unavailable}:v))}>全选</button><button onClick={()=>setRows(prev=>prev.map(v=>v.group===r.group?{...v,selected:!v.selected&&!v.unavailable}:v))}>反选</button><input aria-label="选集范围" placeholder="1-3,5" value={ranges[r.group]||""} onChange={e=>setRanges({...ranges,[r.group!]:e.target.value})}/><button onClick={()=>range(r.group!)}>选取</button></div>}
 <label className={`nd-result ${r.status==="error"?"error":existing(r)?"duplicate":""}`}><input type="checkbox" aria-label={`选择媒体 ${r.title}`} checked={!existing(r)&&r.selected&&!r.unavailable} disabled={busy||r.status!=="ready"||r.unavailable||existing(r)} onChange={e=>setRows(prev=>prev.map(v=>v.id===r.id?{...v,selected:e.target.checked}:v))}/>{r.thumb?<img src={r.thumb} alt="" referrerPolicy="no-referrer"/>:<span className="nd-error-thumb"><Icon name="play" size={22}/></span>}<span className="nd-result-copy"><strong>{r.index?`${r.index}. `:""}{r.title}</strong><small>{host(r.url)}{r.unavailable?" · 该项暂不可用":""}</small></span><span className="nd-row-status">{existing(r)?r.status==="added"?"已添加":"已在列表":r.unavailable?"不可用":r.status==="ready"?"可下载":r.status==="pending"?"解析中":r.status==="cancelled"?"已取消":"未识别"}</span></label>
 {r.status==="ready"&&!r.unavailable&&r.formats?.length&&format!=="mp3"?<label className="nd-row-quality">该项画质<select aria-label={`画质 ${r.title}`} value={r.formatId||""} disabled={busy} onChange={e=>setRows(prev=>prev.map(v=>v.id===r.id?{...v,formatId:e.target.value}:v))}><option value="">使用共同画质</option>{r.formats.map(f=><option key={f.format_id} value={formatSelectorValue(f)}>{formatOptionLabel(f)}</option>)}</select></label>:null}
 {r.status==="error"&&<div className="nd-recovery"><strong>未识别到可下载媒体</strong><p>检查原网页是否可正常播放。登录或作品权限限制需要本人处理，重试不会自动切换账号。</p><button disabled={busy} onClick={()=>void openExtractWindow(r.source).catch(()=>setError("无法打开网页识别，请检查原链接后重试。"))}>网页识别</button><small>在独立网页窗口中播放并选择真实媒体，不会自动开始下载。</small></div>}</div>)}</div></>}
 {failures.length>0&&!busy&&<button className="text-button" onClick={()=>void analyze(true)}>重试未识别链接</button>}
 {rows.some(r=>r.status==="ready"&&!r.unavailable&&!existing(r))&&<section className="nd-options" aria-label="下载选项"><div className="nd-option-grid"><label>格式<select aria-label="下载格式" disabled={busy} value={format} onChange={e=>setFormat(e.target.value)}><option value="default">使用设置</option><option value="none">保留源格式</option><option value="mp4">MP4 · 视频</option><option value="mp3">MP3 · 仅音频</option></select></label><label>共同画质<select aria-label="共同画质" value={quality} disabled={busy||format==="mp3"} onChange={e=>setQuality(e.target.value)}><option value="default">使用设置</option><option value="best">最佳可用画质</option>{[1080,720,480,360].map(q=><option key={q} value={`${q}p`}>{q}p以内</option>)}</select></label></div><div className="nd-save-location"><Icon name="folder" size={20}/><div><small>保存到 · 仅本次</small><strong>{folder||settings?.download_dir||"使用设置中的位置"}</strong></div><button disabled={busy} onClick={()=>void browse()}>更改</button></div><details className="nd-advanced"><summary>高级选项</summary><div className="nd-advanced-content"><label>字幕<select aria-label="字幕" value={subtitles===null?"default":subtitles?"yes":"no"} disabled={busy} onChange={e=>setSubtitles(e.target.value==="default"?null:e.target.value==="yes")}><option value="default">使用设置</option><option value="yes">保存字幕（如有）</option><option value="no">不单独保存字幕</option></select></label><label>文件命名<select aria-label="文件命名" value={naming} disabled={busy} onChange={e=>setNaming(e.target.value)}><option value="default">使用设置</option><option value="original">保留原标题</option><option value="date">标题 + 发布日期</option></select></label></div></details></section>}
 <details className="nd-advanced"><summary>账号选项 · 仅本次</summary><label>下载方式<select aria-label="下载方式" value={login} disabled={busy||rows.some(r=>r.status==="ready")} onChange={e=>setLogin(e.target.value as TaskLoginMode)}><option value="auto">自动（公开通路优先）</option><option value="none">只下载公开内容</option><option value="inherit">使用已配置账号</option></select></label><p className="nd-inline-note">选项用于解析和创建本次任务。修改方式前请先修改链接，重新解析。</p></details>
 </div><footer className="nd-footer"><div className="nd-safety-note"><span>关闭保留草稿 · 开始下载前不会创建任务</span></div><div className="nd-footer-actions"><span className="nd-footer-note">{created?`已添加${created}项`:chosen.length?"⌘ / Ctrl + Enter开始":""}</span><div>{submitting?<button className="primary" disabled>正在添加…</button>:parsing?<button className="secondary" onClick={()=>{cancel();setNotice("解析已取消，没有创建任务。");}}>取消解析</button>:<><button className="secondary" onClick={close}>{created?"返回工作台":"稍后再说"}</button>{chosen.length?<button className="primary" onClick={()=>void start()}>开始下载{chosen.length>1?` ${chosen.length}项`:""}</button>:<button className="primary" disabled={!draft.trim()||connection!=="connected"} onClick={()=>void analyze()}>解析链接</button>}</>}</div></div></footer>
 </dialog>;
}
