import { describe, expect, it } from "vitest";
import { SEARCH_PLATFORMS, webSearchUrl } from "./searchPlatforms";
describe("official web search routes",()=>{
 it("separates the original in-app platforms and web-only platforms",()=>{expect(SEARCH_PLATFORMS.filter(p=>p.kind==="in-app").map(p=>p.key)).toEqual(["youtube","bilibili","dailymotion"]);expect(SEARCH_PLATFORMS.filter(p=>p.kind==="web").map(p=>p.key)).toEqual(["x","douyin","kuaishou"])});
 it.each(["x","douyin","kuaishou"])("encodes a query as data for %s without injecting path/query/fragment",platform=>{const query="海岸 / & ? #摄影 + 😀";const url=new URL(webSearchUrl(platform,query)!);expect(url.protocol).toBe("https:");expect(url.hash).toBe("");if(platform==="douyin"){expect(decodeURIComponent(url.pathname.slice("/search/".length))).toBe(query);expect(url.searchParams.get("type")).toBe("video");}else expect(url.searchParams.get(platform==="x"?"q":"searchKey")).toBe(query);});
 it("rejects empty, too-long and unsupported entries",()=>{for(const p of ["youtube","bilibili","https://evil.example","unknown"])expect(webSearchUrl(p,"test")).toBeNull();expect(webSearchUrl("x","   ")).toBeNull();expect(webSearchUrl("x","a".repeat(301))).toBeNull()});
});
