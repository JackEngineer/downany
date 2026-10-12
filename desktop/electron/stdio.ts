import type { Writable } from "node:stream";

/** A launcher may disappear while the desktop app continues running. */
export function protectOutput(stream: Writable): (text: string) => void {
  let closed = false;
  const onError = (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") throw error;
    closed = true;
  };
  stream.on("error", onError);
  return (text) => {
    if (closed || stream.destroyed || !stream.writable) return;
    try {
      stream.write(text, (error) => { if (error) onError(error); });
    } catch (error) {
      onError(error as NodeJS.ErrnoException);
    }
  };
}

// Register before any application logging; asynchronous stream errors do not
// propagate through the Sidecar event callback's try/catch.
protectOutput(process.stdout);
export const writeStderr = protectOutput(process.stderr);
