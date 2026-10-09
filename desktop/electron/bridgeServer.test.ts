import { describe, expect, it } from "vitest";

import {
  startBridgeServer,
  parseEnqueueBody,
  parseTaskIdsQuery,
  BRIDGE_TASKS_MAX_IDS,
  resolveBridgePort,
} from "./bridgeServer";

describe("resolveBridgePort", () => {
  it("keeps the product bridge on 17888 by default", () => {
    expect(resolveBridgePort({})).toBe(17888);
  });

  it("allows an isolated acceptance instance to request an ephemeral port", () => {
    expect(resolveBridgePort({ DOWNANY_BRIDGE_PORT: "0" })).toBe(0);
  });

  it.each(["-1", "65536", "abc", "1.5"])("rejects invalid port %s", (value) => {
    expect(() => resolveBridgePort({ DOWNANY_BRIDGE_PORT: value })).toThrow(/DOWNANY_BRIDGE_PORT/);
  });
});

describe("parseEnqueueBody", () => {
  it("parses single url", () => {
    expect(parseEnqueueBody(JSON.stringify({ url: "https://youtu.be/a" }))).toEqual([
      { url: "https://youtu.be/a" },
    ]);
  });

  it("parses urls array and merges with url", () => {
    expect(
      parseEnqueueBody(
        JSON.stringify({
          url: "https://youtu.be/a",
          urls: ["https://youtu.be/b", ""],
        }),
      ),
    ).toEqual([{ url: "https://youtu.be/a" }, { url: "https://youtu.be/b" }]);
  });

  it("parses items with title and headers", () => {
    expect(
      parseEnqueueBody(
        JSON.stringify({
          items: [
            {
              url: "https://cdn.example/a.m3u8",
              title: "示例",
              headers: { Referer: "https://example.com/", Cookie: "a=1" },
            },
            { url: "https://cdn.example/b.mp4" },
            { url: "" },
            "https://cdn.example/c.mp4",
          ],
        }),
      ),
    ).toEqual([
      {
        url: "https://cdn.example/a.m3u8",
        title: "示例",
        headers: { Referer: "https://example.com/", Cookie: "a=1" },
      },
      { url: "https://cdn.example/b.mp4" },
      { url: "https://cdn.example/c.mp4" },
    ]);
  });

  it("parses pageUrl and thumbnail_url", () => {
    expect(
      parseEnqueueBody(
        JSON.stringify({
          items: [
            {
              url: "https://sns-video-bd.xhscdn.com/a.mp4",
              title: "笔记 - 小红书",
              pageUrl: "https://www.xiaohongshu.com/explore/abc",
              thumbnail_url: "https://sns-webpic-qc.xhscdn.com/cover.jpg",
              headers: {
                Referer: "https://www.xiaohongshu.com/explore/abc",
              },
            },
          ],
        }),
      ),
    ).toEqual([
      {
        url: "https://sns-video-bd.xhscdn.com/a.mp4",
        title: "笔记 - 小红书",
        pageUrl: "https://www.xiaohongshu.com/explore/abc",
        thumbnail_url: "https://sns-webpic-qc.xhscdn.com/cover.jpg",
        headers: {
          Referer: "https://www.xiaohongshu.com/explore/abc",
        },
      },
    ]);
  });

  it("dedupes url across items and legacy fields", () => {
    expect(
      parseEnqueueBody(
        JSON.stringify({
          items: [{ url: "https://youtu.be/a", title: "A" }],
          url: "https://youtu.be/a",
          urls: ["https://youtu.be/a", "https://youtu.be/b"],
        }),
      ),
    ).toEqual([
      { url: "https://youtu.be/a", title: "A" },
      { url: "https://youtu.be/b" },
    ]);
  });

  it("returns empty for invalid json", () => {
    expect(parseEnqueueBody("{")).toEqual([]);
    expect(parseEnqueueBody("{}")).toEqual([]);
  });
});

describe("parseTaskIdsQuery", () => {
  it("parses and dedupes comma-separated ids", () => {
    expect(parseTaskIdsQuery("a,b, a,c")).toEqual(["a", "b", "c"]);
  });

  it("returns empty for null or blank", () => {
    expect(parseTaskIdsQuery(null)).toEqual([]);
    expect(parseTaskIdsQuery("  ")).toEqual([]);
  });

  it("caps at BRIDGE_TASKS_MAX_IDS", () => {
    const ids = Array.from({ length: BRIDGE_TASKS_MAX_IDS + 10 }, (_, i) => `t${i}`);
    expect(parseTaskIdsQuery(ids.join(","))).toHaveLength(BRIDGE_TASKS_MAX_IDS);
  });
});


describe("extension task receipts", () => {
  it("keeps exact signed URLs and verified media identity", () => {
    const url = "https://cdn.example/media.mp4?signature=A%2FB&expires=123";
    expect(parseEnqueueBody(JSON.stringify({items:[{url,route:"media",media_title_verified:true,title:"clip"}]}))).toEqual([{url,route:"media",media_title_verified:true,title:"clip"}]);
  });
  it("deduplicates simultaneous requests and preserves the original task on retry/focus", async () => {
    let calls=0; const retried: string[]=[]; const focused: string[]=[];
    const server=startBridgeServer({
      enqueue: async () => { calls++; await new Promise(resolve=>setTimeout(resolve,30)); return {ok:true,taskIds:["original-task"]}; },
      retryTask: async id => {retried.push(id);return {ok:true,taskIds:[id]};},
      focusTask: async id => {focused.push(id);return {ok:true,taskIds:[id]};},
    },0);
    await new Promise<void>(resolve=>server.once("listening",resolve));
    const address=server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const base=`http://127.0.0.1:${address.port}`;
    const post=(path:string,body:unknown,origin?:string)=>fetch(base+path,{method:"POST",headers:{"Content-Type":"application/json",...(origin?{Origin:origin}:{})},body:JSON.stringify(body)});
    try {
      const body={requestId:"stable-request",items:[{url:"https://cdn.example/video.mp4?signature=exact",route:"media"}]};
      const responses=await Promise.all([post("/enqueue",body),post("/enqueue",body)]);
      expect(await Promise.all(responses.map(r=>r.json()))).toEqual([{ok:true,taskIds:["original-task"]},{ok:true,taskIds:["original-task"]}]); expect(calls).toBe(1);
      const conflict=await post("/enqueue",{...body,items:[{url:"https://different.example/v.mp4",route:"media"}]});expect(conflict.status).toBe(409);
      expect((await post("/task/retry",{taskId:"original-task"})).status).toBe(200);
      expect((await post("/task/focus",{taskId:"original-task"})).status).toBe(200);
      expect(retried).toEqual(["original-task"]);expect(focused).toEqual(["original-task"]);expect(calls).toBe(1);
      expect((await post("/task/retry",{taskId:"original-task"},"https://untrusted.example")).status).toBe(403);
    } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
  });
});


describe("extension output preferences", () => {
  it("preserves different outputs for one exact URL and explicit false", () => {
    const url="https://example.com/video?signature=exact";
    const items=parseEnqueueBody(JSON.stringify({items:[{url,route:"page",quality:"720p",audio_only:false},{url,route:"page",quality:"best",audio_only:true},{url,route:"page",quality:"720p",audio_only:false}]}));
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({quality:"720p",audio_only:false});
    expect(items[1]).toMatchObject({quality:"best",audio_only:true});
  });
});
