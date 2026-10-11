const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),vm=require("node:vm");
test("durable receipts omit sources while same-session page progress keeps its route",async()=>{
 const areas={local:{},session:{}},messages=[];
 const storage=name=>({get:async key=>({[key]:areas[name][key]}),set:async values=>Object.assign(areas[name],values)});
 const context={chrome:{storage:{local:storage("local"),session:storage("session")},tabs:{sendMessage:async(id,value)=>messages.push({id,value})}},
 VideoDlDelivery:{outputOptions:t=>({audio_only:t.audio_only===true,quality:t.quality||"best"})},
 VideoDlShared:{taskFailureMessage:()=>""},friendlyTaskError:()=>"",SENT_TASKS_KEY:"tasks",SENT_TASKS_MAX:50,
 updateDownloadBadge:async()=>{},ensurePollRunning:()=>{}};
 vm.createContext(context);
 const source=fs.readFileSync(__dirname+"/background.js","utf8");
 vm.runInContext(source.slice(source.indexOf("function persistedTask("),source.indexOf("async function fetchTasksFromBridge("))+";globalThis.api={recordSentTasks,loadSentTasks,pushTaskStatusToTab};",context);
 await context.api.recordSentTasks({taskIds:["one"],items:[{url:"https://example.com/media?token=private",pageUrl:"https://example.com/page",title:"sample"}],tabId:7});
 assert.equal(JSON.stringify(areas.local).includes("private"),false);
 const [task]=await context.api.loadSentTasks();context.api.pushTaskStatusToTab({...task,status:"completed"});
 assert.equal(messages[0].id,7);assert.equal(messages[0].value.url,"https://example.com/media?token=private");
 areas.session={};const [restored]=await context.api.loadSentTasks();
 assert.equal(restored.taskId,"one");assert.equal(restored.url,undefined);assert.equal(restored.tabId,undefined);
});
