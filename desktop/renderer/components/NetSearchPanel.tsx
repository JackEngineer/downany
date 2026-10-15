import { useEffect, useRef, useState } from "react";
import { createTasksAndRefresh } from "../lib/addFlow";
import { request } from "../lib/api";
import { platformLabel } from "../lib/format";
import type { NetSearchItem } from "../lib/types";
import { useAppStore } from "../store/appStore";
import { Icon } from "./ui/Icon";
import "../styles/search-workspace.css";
import { SEARCH_PLATFORMS, webSearchUrl } from "../lib/searchPlatforms";
export function formatSearchDuration(seconds:number):string{if(!Number.isFinite(seconds)||seconds<=0)return "";const n=Math.floor(seconds),m=Math.floor(n/60);return m>=60?`${Math.floor(m/60)}:${String(m%60).padStart(2,"0")}:${String(n%60).padStart(2,"0")}`:`${m}:${String(n%60).padStart(2,"0")}`;}
export function safeSearchError(error:string):string{if(/429|403|412|频繁|限制|denied|forbidden/i.test(error))return "平台暂时限制了搜索请求，请稍后重试。";if(/timeout|timed out|超时/i.test(error))return "搜索超时，请稍后重试。";return "搜索未完成，请检查网络连接后重试。";}
function safeUrl(value:string){try{const u=new URL(value);return ["https:","http:"].includes(u.protocol)&&!u.username&&!u.password?u.href:"";}catch{return ""}}
export function NetSearchPanel(){
 const mode=useAppStore(s=>s.searchMode),query=useAppStore(s=>s.netQuery),platform=useAppStore(s=>s.netPlatform),searching=useAppStore(s=>s.netSearching),results=useAppStore(s=>s.netResults),error=useAppStore(s=>s.netError),id=useAppStore(s=>s.netSearchId),submitted=useAppStore(s=>s.netSubmittedQuery),submittedPlatform=useAppStore(s=>s.netSubmittedPlatform),cancelled=useAppStore(s=>s.netCancelled),adding=useAppStore(s=>s.netAddingUrls),tasks=useAppStore(s=>s.tasks),connection=useAppStore(s=>s.connection);
 const selectedPlatform=SEARCH_PLATFORMS.find(p=>p.key===platform),web=selectedPlatform?.kind==="web";
 const [webOpening,setWebOpening]=useState(false),[webMessage,setWebMessage]=useState(""),[webError,setWebError]=useState("");
 const webLock=useRef(false),lastWebOpen=useRef({key:"",at:0}),webGeneration=useRef(0);
 useEffect(()=>{webGeneration.current++;setWebMessage("");setWebError("");},[platform,query]);
 useEffect(()=>()=>{webGeneration.current++;},[]);
 const openWebSearch=async()=>{
  const s=useAppStore.getState(),url=webSearchUrl(s.netPlatform,s.netQuery);
  if(!url){input.current?.focus();return;}
  if(webLock.current||(lastWebOpen.current.key===url&&Date.now()-lastWebOpen.current.at<1200))return;
  webLock.current=true;lastWebOpen.current={key:url,at:Date.now()};const generation=webGeneration.current;
  setWebOpening(true);setWebError("");
  try{await window.api.openExternal(url);if(generation===webGeneration.current)setWebMessage("已请求在浏览器打开。找到作品后，复制作品链接并返回导入。");}
  catch{lastWebOpen.current={key:"",at:0};if(generation===webGeneration.current)setWebError("无法打开浏览器，请重试。");}
  finally{webLock.current=false;setWebOpening(false);}
 };
 const input=useRef<HTMLInputElement>(null),[addErrors,setAddErrors]=useState<Record<string,string>>({});const store=useAppStore.getState();
 useEffect(()=>{if(mode==="network")queueMicrotask(()=>input.current?.focus());},[mode]);
 useEffect(()=>{const key=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="f"&&!document.querySelector('dialog[open], [aria-modal="true"]:not(dialog)')){e.preventDefault();input.current?.focus();}};window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key);},[]);
 const cancelCurrent=()=>{const s=useAppStore.getState(),active=s.netSearchId;if(s.netSearching&&active){s.cancelNetSearch();void request("search.cancel",{searchId:active}).catch(()=>undefined);}};
 const run=async()=>{if(web){await openWebSearch();return;}const s=useAppStore.getState(),text=s.netQuery.trim();if(!text||s.connection!=="connected"){input.current?.focus();return;}if(s.netSearching&&s.netSubmittedQuery===text&&s.netSubmittedPlatform===s.netPlatform)return;cancelCurrent();const next=crypto.randomUUID();s.startNetSearch(next,text,s.netPlatform);try{await request("search.query",{query:text,platform:s.netPlatform,maxResults:12,searchId:next});}catch{useAppStore.getState().failNetSearch(next,"request_failed");}};
 const add=async(item:NetSearchItem)=>{const s=useAppStore.getState();if(s.netAddingUrls.includes(item.url)||s.tasks.some(t=>t.url===item.url)||!safeUrl(item.url))return;s.setNetAddPending(item.url,true);setAddErrors(v=>({...v,[item.url]:""}));try{const ok=await createTasksAndRefresh([item.url],[{url:item.url,title:item.title,thumbnail_url:item.thumbnail_url}]);if(!ok)setAddErrors(v=>({...v,[item.url]:"未能加入，请检查下载位置后重试。"}));}catch{setAddErrors(v=>({...v,[item.url]:"未能加入下载，请稍后重试。"}));}finally{useAppStore.getState().setNetAddPending(item.url,false);}};
 const open=(item:NetSearchItem)=>{const url=safeUrl(item.url);if(url)void window.api.openExternal(url).catch(()=>store.pushToast({kind:"error",title:"无法打开原网页，请稍后重试。"}));};
 if(mode!=="network")return null;
 const hasResult=Boolean(id)||results.length>0;
 return <section className="wb-search-workspace" aria-label="网络搜索结果" onKeyDown={e=>{if(e.key==="Escape"&&searching){e.preventDefault();cancelCurrent();}}}>
 <header className="wb-search-heading"><h1>搜索视频</h1></header>
 <form className="wb-unified-search" role="search" aria-label="平台视频搜索" onSubmit={e=>{e.preventDefault();void run();}}><select aria-label="搜索平台" value={platform} onChange={e=>{cancelCurrent();store.setNetPlatform(e.target.value);store.clearNetSearch();}}>{["in-app","web"].map(kind=><optgroup key={kind} label={kind==="in-app"?"应用内搜索":"网页搜索"}>{SEARCH_PLATFORMS.filter(p=>p.kind===kind).map(p=><option key={p.key} value={p.key}>{p.label} · {kind==="in-app"?"应用内搜索":"网页搜索"}</option>)}</optgroup>)}</select><span className="wb-search-input"><Icon name="search" size={20}/><input ref={input} type="search" aria-label="搜索网络视频" placeholder="输入视频名称或关键词" value={query} maxLength={300} onChange={e=>{if(searching)cancelCurrent();store.setNetQuery(e.target.value);}} onKeyDown={e=>{if(e.key==="Enter"&&(e.nativeEvent.isComposing||e.nativeEvent.keyCode===229))e.preventDefault();if(e.key==="Escape"&&searching){e.preventDefault();cancelCurrent();}}}/></span><button className="primary" type="submit" disabled={!query.trim()||(web?webOpening:connection!=="connected"||(searching&&submitted===query.trim()&&submittedPlatform===platform))}>{web?(webOpening?"正在打开…":"浏览器搜索"):"搜索"}{web&&<Icon name="open" size={13}/>}</button></form>
 {!web&&connection!=="connected"&&<p className="wb-search-notice" role="status">下载服务尚未连接，恢复后可以继续搜索。</p>}
 {web?<div className="wb-web-search-flow">
 <p className="wb-web-search-help">在浏览器打开{selectedPlatform?.label}搜索。登录或验证请在原网站完成。</p>
 {webError?<p role="alert" className="wb-result-error">{webError}<button className="wb-search-reset" onClick={()=>void openWebSearch()}>重试打开</button></p>:webMessage&&<p role="status" className="wb-web-search-status">{webMessage}</p>}
 <div className="wb-web-import"><div><h2>找到想下载的作品？</h2><p>复制作品链接后导入，解析确认后再开始下载。部分作品可能需要登录或不支持下载。</p></div><button className="secondary" onClick={()=>store.requestAddFocus()}><Icon name="link" size={15}/>导入作品链接</button></div>
 </div>:<div className="wb-search-results" aria-live="polite" aria-busy={searching}>
 {searching?<div className="wb-search-progress" role="status"><span>正在搜索“{submitted}”…</span><button className="secondary compact" onClick={cancelCurrent}>取消搜索</button></div>:error?<div className="wb-search-message" role="alert"><p>{safeSearchError(error)}</p><button className="secondary" onClick={()=>void run()}>重试搜索</button></div>:cancelled?<p className="wb-search-empty" role="status">已取消搜索，可以修改关键词后重新搜索。</p>:!hasResult?<p className="wb-search-empty">输入关键词，查找视频。</p>:results.length===0?<p className="wb-search-empty" role="status">没有找到相关视频，试试其他关键词。</p>:<><div className="wb-search-results-heading"><span>{submitted?`“${submitted}” · `:""}{results.length} 个结果</span><span>{platformLabel(submittedPlatform)}<button className="wb-search-reset" onClick={()=>{cancelCurrent();store.clearNetSearch();input.current?.focus();}}>清除结果</button></span></div><ul className="wb-video-results">{results.map(item=>{const exists=tasks.some(t=>t.url===item.url),pending=adding.includes(item.url),duration=formatSearchDuration(item.duration);return <li key={item.url} className="wb-video-result"><button className="wb-result-thumb" aria-label={`打开原网页 ${item.title}`} title="在原网站查看视频" onClick={()=>open(item)} disabled={!safeUrl(item.url)}><Icon name="link" size={24}/>{/^https:\/\//.test(item.thumbnail_url)?<img src={item.thumbnail_url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={e=>{e.currentTarget.style.display="none";}}/>:null}<span className="wb-original-link"><Icon name="open" size={15}/></span>{duration&&<span className="wb-result-duration">{duration}</span>}</button><div className="wb-result-copy"><button className="wb-result-title" title={item.title} onClick={()=>open(item)} disabled={!safeUrl(item.url)}>{item.title||"未命名视频"}</button><span className="wb-result-meta">{[item.uploader&&item.uploader!=="未知"?item.uploader:"",platformLabel(item.platform)].filter(Boolean).join(" · ")||"作者信息未提供"}</span><button className="wb-result-source" onClick={()=>open(item)} disabled={!safeUrl(item.url)}>打开原网页<Icon name="open" size={12}/></button>{addErrors[item.url]&&<span className="wb-result-error" role="alert">{addErrors[item.url]}</span>}</div><button className="secondary wb-result-add" disabled={pending||exists||connection!=="connected"||!safeUrl(item.url)} onClick={()=>void add(item)}><Icon name={exists?"check":"plus"} size={15}/>{pending?"正在加入…":exists?"已在任务中":"加入下载"}</button></li>;})}</ul></>}
 </div>}</section>;
}
