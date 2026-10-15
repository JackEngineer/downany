// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { MediaWorkbench, exportArguments, parseByteRange } from "./mediaWorkbench";
const roots: string[] = [];
afterEach(()=>{ for(const root of roots.splice(0)) fs.rmSync(root,{recursive:true,force:true}); });
const temp=()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),"downany-media-test-"));roots.push(root);return root};
const bin=fileURLToPath(new NodeURL("../resources/bin", import.meta.url));
const integration=process.env.DOWNANY_REQUIRE_MEDIA_INTEGRATION === "1" ? it : it.skip;
const digest=(p:string)=>createHash("sha256").update(fs.readFileSync(p)).digest("hex");
function sample(root:string){const file=path.join(root,"sample.mp4");const result=spawnSync(path.join(bin,"ffmpeg"),["-v","error","-nostdin","-f","lavfi","-i","testsrc2=size=128x72:rate=24","-f","lavfi","-i","sine=frequency=440:sample_rate=44100","-t","4","-c:v","h264_videotoolbox","-allow_sw","1","-pix_fmt","yuv420p","-c:a","aac","-movflags","+faststart",file],{timeout:30000});expect(result.status,String(result.stderr)).toBe(0);return file;}
async function terminal(service:MediaWorkbench,id:string){for(let i=0;i<300;i++){const job=service.listJobs().find(j=>j.id===id)!;if(!["running","cancelling"].includes(job.status))return job;await new Promise(r=>setTimeout(r,50));}throw Error("export timeout");}
describe("media range and parameter contracts",()=>{
 it("supports whole, bounded, open and suffix ranges and rejects malformed/multiple ranges",()=>{
  expect(parseByteRange(null,100)).toEqual({start:0,end:99,partial:false});expect(parseByteRange("bytes=20-39",100)).toEqual({start:20,end:39,partial:true});expect(parseByteRange("bytes=90-",100)?.end).toBe(99);expect(parseByteRange("bytes=-10",100)?.start).toBe(90);
  for(const v of ["bytes=100-101","bytes=4-2","bytes=-0","bytes=0-1,4-8","bytes=-","bytes=9007199254740992-"])expect(parseByteRange(v,100)).toBeNull();
 });
 it("uses literal arguments, local formats, finite bounded ranges and no shell flags from callers",()=>{
  const args=exportArguments("clip","/tmp/a; touch pwn.mp4","/tmp/new.mp4",4,1,2.5);expect(args).toContain("/tmp/a; touch pwn.mp4");expect(args).toContain("file,pipe");expect(args).toContain("-n");expect(args).not.toContain("-y");expect(args[args.indexOf("-t")+1]).toBe("1.5");
  for(const [a,b] of [[-1,2],[1,1],[0,5],[NaN,2],[0,Infinity]])expect(()=>exportArguments("clip","/tmp/a.mp4","/tmp/b.mp4",4,a,b)).toThrow();
  expect(()=>exportArguments("frame","/tmp/a.mp4","/tmp/a.jpg",4,4,undefined)).toThrow();
  expect(()=>exportArguments("evil" as "clip","/tmp/a","/tmp/b",4,0,1)).toThrow();
 });
 it("marks unfinished exports interrupted without resuming processing on reopen",()=>{const root=temp();fs.writeFileSync(path.join(root,"media-exports.json"),JSON.stringify({files:[],jobs:[{id:"j",taskId:"t",kind:"clip",status:"running",progress:30}]}));const s=new MediaWorkbench({dataDir:root,binDir:bin,lookup:async()=>undefined});expect(s.listJobs()[0].status).toBe("interrupted");});
});
describe("real media authorization and export integration",()=>{
 integration("authorizes exact tasks/files, streams ranges, rejects traversal, symlinks and stale grants",async()=>{
  const root=temp(),file=sample(root);let task: {id:string,status:string,file_path:string}|undefined={id:"t",status:"completed",file_path:file};const s=new MediaWorkbench({dataDir:path.join(root,"data"),binDir:bin,lookup:async id=>id==="t"?task:undefined});try{
   const info=await s.inspect("t");expect(info.duration).toBeCloseTo(4,1);const url=info.files[0].url;
   const response=await s.respond(new Request(url,{headers:{range:"bytes=20-39"}}));expect(response.status).toBe(206);expect(Buffer.from(await response.arrayBuffer())).toEqual(fs.readFileSync(file).subarray(20,40));
   expect((await s.respond(new Request(url,{headers:{range:"bytes=0-1,5-9"}}))).status).toBe(416);
   expect((await s.respond(new Request(url+"?path=/etc/passwd"))).status).toBe(403);expect((await s.respond(new Request("downany-media://local/%2e%2e%2fetc%2fpasswd"))).status).toBe(403);expect((await s.respond(new Request(url,{method:"POST"}))).status).toBe(403);
   await expect(s.start({taskId:"t",fileId:"../../etc/passwd",kind:"frame",start:0})).rejects.toThrow();
   task={...task!,file_path:path.join(root,"other.mp4")};fs.copyFileSync(file,task.file_path);expect((await s.respond(new Request(url))).status).toBe(404);
   fs.symlinkSync(file,path.join(root,"link.mp4"));task={...task,file_path:path.join(root,"link.mp4")};expect((await s.inspect("t")).error).toBeDefined();task=undefined;expect((await s.respond(new Request(url))).status).toBe(404);
  }finally{await s.stop();}
 },30000);
 integration("exports real trim, frame and audio without overwriting, cancels, and persists outputs",async()=>{
  const root=temp(),file=sample(root),before=digest(file),source={id:"t",status:"completed",file_path:file};const opts={dataDir:path.join(root,"data"),binDir:bin,lookup:async(id:string)=>id==="t"?source:undefined};let s=new MediaWorkbench(opts);try{
   for(const kind of ["clip","frame","audio"] as const){const job=await s.start({taskId:"t",fileId:"original",kind,...(kind==="clip"?{start:1,end:2.5}:kind==="frame"?{start:1}:{})});const done=await terminal(s,job.id);expect(done.status).toBe("completed");expect(done.file?.path).not.toBe(file);expect(digest(file)).toBe(before);const info=JSON.parse(spawnSync(path.join(bin,"ffprobe"),["-v","error","-show_format","-show_streams","-of","json",done.file!.path],{encoding:"utf8"}).stdout);if(kind==="clip")expect(Number(info.format.duration)).toBeCloseTo(1.5,1);if(kind==="audio")expect(info.streams.some((x:{codec_type:string})=>x.codec_type==="audio")).toBe(true);if(kind==="frame")expect(info.streams[0].width).toBe(128);expect(spawnSync(path.join(bin,"ffmpeg"),["-v","error","-nostdin","-xerror","-i",done.file!.path,"-f","null","-"],{timeout:30000}).status).toBe(0);}
   expect((await s.inspect("t")).files).toHaveLength(4);
   const cancelled=await s.start({taskId:"t",fileId:"original",kind:"clip",start:0,end:4});s.cancel(cancelled.id);expect((await terminal(s,cancelled.id)).status).toBe("cancelled");expect((await s.inspect("t")).files).toHaveLength(4);expect(fs.readdirSync(path.join(root,"Downany Exports")).some(x=>x.startsWith(".export-"))).toBe(false);
   const results=await Promise.allSettled([s.start({taskId:"t",fileId:"original",kind:"clip",start:0,end:4}),s.start({taskId:"t",fileId:"original",kind:"clip",start:0,end:4})]);expect(results.filter(x=>x.status==="rejected")).toHaveLength(1);const running=s.listJobs().find(x=>x.status==="running");if(running){s.cancel(running.id);await terminal(s,running.id);}await s.stop();s=new MediaWorkbench(opts);expect((await s.inspect("t")).files).toHaveLength(4);expect(digest(file)).toBe(before);
  }finally{await s.stop();}
 },60000);
 integration("reports a missing export tool as failure and preserves the source",async()=>{
  const root=temp(),file=sample(root),before=digest(file),tools=path.join(root,"tools");fs.mkdirSync(tools);fs.symlinkSync(path.join(bin,"ffprobe"),path.join(tools,"ffprobe"));
  const s=new MediaWorkbench({dataDir:path.join(root,"data"),binDir:tools,lookup:async()=>({id:"t",status:"completed",file_path:file})});try{const job=await s.start({taskId:"t",fileId:"original",kind:"audio"});expect((await terminal(s,job.id)).status).toBe("failed");expect(digest(file)).toBe(before);expect(fs.readdirSync(path.join(root,"Downany Exports"))).toEqual([]);}finally{await s.stop();}
 },30000);
 integration("rejects a symlink output directory and playlist content masquerading as video",async()=>{
  const root=temp(),file=sample(root);fs.mkdirSync(path.join(root,"elsewhere"));fs.symlinkSync(path.join(root,"elsewhere"),path.join(root,"Downany Exports"));const s=new MediaWorkbench({dataDir:path.join(root,"data"),binDir:bin,lookup:async()=>({id:"t",status:"completed",file_path:file})});try{await expect(s.start({taskId:"t",fileId:"original",kind:"clip",start:0,end:1})).rejects.toThrow();expect(fs.readdirSync(path.join(root,"elsewhere"))).toEqual([]);}finally{await s.stop();}
  fs.writeFileSync(path.join(root,"playlist.mp4"),'#EXTM3U\n#EXTINF:2\nfile:///etc/passwd');const bad=new MediaWorkbench({dataDir:path.join(root,"data2"),binDir:bin,lookup:async()=>({id:"t",status:"completed",file_path:path.join(root,"playlist.mp4")})});try{expect((await bad.inspect("t")).error).toBeDefined();}finally{await bad.stop();}
 },30000);
});
