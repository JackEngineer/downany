import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";

if (process.platform !== "win32") {
  throw new Error("Windows ProcessHost smoke must run on Windows");
}

const executableArg = process.argv.find((arg) => arg.startsWith("--executable="));
const executable = executableArg?.slice("--executable=".length);
if (!executable || !/^[A-Za-z]:[\\/]/.test(executable)) {
  throw new Error("--executable must be an absolute Windows path");
}

const instanceId = `process-host-smoke-${process.pid}`;
const targetCode = [
  "process.stdout.write('before-resume\\n');",
  "setTimeout(() => process.stdout.write('after-resume\\n'), 50);",
].join("");

const child = spawn(executable, ["--instance-id", instanceId, "--", process.execPath, "-e", targetCode], {
  cwd: process.cwd(),
  windowsHide: true,
  shell: false,
  stdio: ["pipe", "pipe", "pipe", "pipe"],
});
const control = child.stdio[3];
const stdout = child.stdout;
const stderr = child.stderr;
if (!control || !stdout || !stderr) throw new Error("ProcessHost stdio pipes were not created");
control.setEncoding("utf8");
stdout.setEncoding("utf8");
stderr.setEncoding("utf8");

function readLine(stream, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    const finish = (fn) => {
      cleanup();
      fn();
    };
    const onData = (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index >= 0) finish(() => resolve(buffer.slice(0, index).trim()));
    };
    const onEnd = () => finish(() => reject(new Error("control pipe closed before handshake")));
    const onError = (error) => finish(() => reject(error));
    timer = setTimeout(() => finish(() => reject(new Error("ProcessHost handshake timed out"))), timeoutMs);
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}

let outputBeforeResume = "";
stdout.on("data", (chunk) => { outputBeforeResume += chunk; });
try {
  const handshake = JSON.parse(await readLine(control, 30_000));
  if (handshake.schemaVersion !== 2 || handshake.instanceId !== instanceId) {
    throw new Error(`invalid handshake identity: ${JSON.stringify(handshake)}`);
  }
  if (handshake.containment !== "windows_job_object" || handshake.processGroupId !== null) {
    throw new Error(`invalid Windows containment: ${JSON.stringify(handshake)}`);
  }
  for (const field of ["guardianPid", "targetPid"]) {
    if (!Number.isInteger(handshake[field]) || handshake[field] <= 1) {
      throw new Error(`invalid handshake ${field}`);
    }
  }
  if (outputBeforeResume !== "") throw new Error(`target ran before resume: ${outputBeforeResume}`);
  control.write('{"command":"resume"}\n');
  const exitTimeout = setTimeout(() => child.kill(), 15_000);
  try {
    const [exitCode] = await once(child, "exit");
    if (exitCode !== 0) throw new Error(`ProcessHost exited with ${exitCode}; stderr=${await streamText(stderr)}`);
  } finally {
    clearTimeout(exitTimeout);
  }
  if (outputBeforeResume !== "before-resume\nafter-resume\n") {
    throw new Error(`unexpected target output: ${JSON.stringify(outputBeforeResume)}`);
  }
  console.log("Windows ProcessHost smoke passed");
} catch (error) {
  child.kill();
  throw error;
}

async function streamText(stream) {
  let value = "";
  for await (const chunk of stream) value += chunk;
  return value;
}
