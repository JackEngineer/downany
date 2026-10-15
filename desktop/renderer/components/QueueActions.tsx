import { useRef, useState } from "react";
import { request } from "../lib/api";
import { refreshQueueAfterChange } from "../lib/refreshQueue";
import { taskActionToast } from "../lib/taskActionReport";
import { useAppStore } from "../store/appStore";
import type { TaskActionReport } from "../lib/types";
export function QueueActions(){const lock=useRef(false),[busy,setBusy]=useState(false),connection=useAppStore(s=>s.connection);const run=async(method:string)=>{if(lock.current)return;lock.current=true;setBusy(true);try{const result=await request<TaskActionReport>(method,{});if(method!=="download.clearFinished")useAppStore.getState().pushToast(taskActionToast(result));await refreshQueueAfterChange();}catch{useAppStore.getState().pushToast({kind:"error",title:"未能完成队列操作，请稍后重试。"});}finally{lock.current=false;setBusy(false);}};return <div className="action-row" aria-label="批量任务操作">{[["download.pauseAll","全部暂停"],["download.resumeAll","全部继续"],["download.clearFinished","清理已完成记录"]].map(([m,label])=><button key={m} className="secondary" disabled={busy||connection!=="connected"} onClick={()=>void run(m)}>{label}</button>)}</div>}
