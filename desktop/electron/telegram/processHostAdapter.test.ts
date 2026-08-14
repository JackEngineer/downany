import { describe, expect, it } from "vitest";

import { createTelegramProcessHostAdapter } from "./processHostAdapter";

describe("Telegram ProcessHost adapter", () => {
  it("parses fd3 handshake and sends the only resume command", async () => {
    const script = [
      "const fs=require('fs');",
      "const id=process.argv[1];",
      "fs.writeSync(3, JSON.stringify({schemaVersion:2,instanceId:id,guardianPid:process.pid,guardianStartedAt:'2026-08-12T00:00:00.000Z',targetPid:process.pid+1,targetStartedAt:'2026-08-12T00:00:00.000Z',containment:'windows_job_object',processGroupId:null})+'\\n');",
      "const b=Buffer.alloc(1); let line=''; const read=()=>fs.read(3,b,0,1,null,(e,n)=>{if(e||!n)process.exit(2); const c=b.toString(); if(c==='\\n'){if(line==='{\\\"command\\\":\\\"resume\\\"}')process.exit(0); process.exit(3);} line+=c; read();}); read();",
    ].join("");
    const adapter = createTelegramProcessHostAdapter({ platform: "win32", handshakeTimeoutMs: 5_000 });
    const target = process.execPath;
    const child = await adapter.spawnContainedProcess(process.execPath, ["-e", script, "adapter-test", "--", target], {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      detached: false,
      windowsHide: true,
    });
    expect(child.candidate.instanceId).toBe("adapter-test");
    expect(child.candidate.root.executablePath).toBe(target);
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    await child.resume();
    await expect(exited).resolves.toBe(0);
  }, 15_000);
});
