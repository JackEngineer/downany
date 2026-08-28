import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';

// Purpose-built for yt-dlp resume: bytes=N-M and bytes=N-. Suffix and multiple
// ranges are deliberately outside this test server's contract.
function parseSingleRange(header, mediaSize) {
  if (!header) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (!match) return { invalid: true };
  const start = Number(match[1]);
  const end = match[2] === '' ? mediaSize - 1 : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= mediaSize) {
    return { invalid: true };
  }
  return { start, end: Math.min(end, mediaSize - 1) };
}

export async function createMediaFaultServer(mediaPath, {
  chunkBytes = 16_384,
  intervalMs = 10,
  interruptAfterBytes = 65_536,
} = {}) {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new RangeError('chunkBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0) {
    throw new RangeError('intervalMs must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(interruptAfterBytes) || interruptAfterBytes <= 0) {
    throw new RangeError('interruptAfterBytes must be a positive safe integer');
  }

  const mediaSize = (await stat(mediaPath)).size;
  if (mediaSize === 0) throw new RangeError('media file must not be empty');
  const requests = [];
  const sockets = new Set();
  const modes = new Map();
  const modeWaiters = new Map();
  const streams = new Set();
  const timerCancels = new Set();

  function waitBetweenChunks() {
    if (intervalMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        timerCancels.delete(cancel);
        resolve();
      }, intervalMs);
      const cancel = () => {
        clearTimeout(timer);
        timerCancels.delete(cancel);
        resolve();
      };
      timerCancels.add(cancel);
    });
  }

  async function writeChunk(response, chunk, record) {
    if (response.destroyed || response.writableEnded) return false;
    const written = await new Promise((resolve) => {
      const finish = (success) => {
        response.removeListener('close', onClose);
        resolve(success);
      };
      const onClose = () => finish(false);
      response.once('close', onClose);
      response.write(chunk, (error) => finish(!error && !response.destroyed));
    });
    if (written) record.bytesSent += chunk.length;
    return written;
  }

  async function sendChunks(response, record, rangeStart, rangeEnd, afterChunk) {
    const stream = createReadStream(mediaPath, {
      start: rangeStart,
      end: rangeEnd,
      highWaterMark: chunkBytes,
    });
    streams.add(stream);
    try {
      for await (const chunk of stream) {
        if (!await writeChunk(response, chunk, record)) return false;
        if (afterChunk && !await afterChunk()) return false;
        await waitBetweenChunks();
      }
      if (!response.destroyed) response.end();
      return true;
    } catch {
      response.destroy();
      return false;
    } finally {
      streams.delete(stream);
      stream.destroy();
    }
  }

  function waitForHealthyOrClientClose(pathname, request) {
    if ((modes.get(pathname) ?? 'healthy') === 'healthy') return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiters = modeWaiters.get(pathname) ?? new Set();
      modeWaiters.set(pathname, waiters);
      const finish = (healthy) => {
        waiters.delete(onModeChange);
        if (waiters.size === 0) modeWaiters.delete(pathname);
        request.socket?.removeListener('close', onClientClose);
        resolve(healthy);
      };
      const onModeChange = () => {
        if ((modes.get(pathname) ?? 'healthy') === 'healthy') finish(true);
      };
      const onClientClose = () => finish(false);
      waiters.add(onModeChange);
      request.socket?.once('close', onClientClose);
    });
  }
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const mode = modes.get(pathname) ?? 'healthy';
    if (!pathname.startsWith('/') || !pathname.endsWith('.mp4') || mode === 'missing') {
      response.writeHead(404).end();
      requests.push({
        method: request.method,
        pathname,
        status: 404,
        rangeStart: null,
        rangeEnd: null,
        bytesSent: 0,
        disconnected: false,
        faultInjected: false,
      });
      return;
    }

    const range = parseSingleRange(request.headers.range, mediaSize);
    if (range?.invalid) {
      response.writeHead(416, { 'Content-Range': `bytes */${mediaSize}` }).end();
      requests.push({
        method: request.method,
        pathname,
        status: 416,
        rangeStart: null,
        rangeEnd: null,
        bytesSent: 0,
        disconnected: false,
        faultInjected: false,
      });
      return;
    }

    const rangeStart = range?.start ?? 0;
    const rangeEnd = range?.end ?? mediaSize - 1;
    const contentLength = rangeEnd - rangeStart + 1;
    const status = range ? 206 : 200;
    const record = {
      method: request.method,
      pathname,
      status,
      rangeStart,
      rangeEnd,
      bytesSent: 0,
      disconnected: false,
      faultInjected: false,
    };
    requests.push(record);
    response.once('close', () => {
      if (!response.writableEnded) record.disconnected = true;
    });
    const headers = {
      'Accept-Ranges': 'bytes',
      'Content-Length': contentLength,
      'Content-Type': 'video/mp4',
    };
    if (range) headers['Content-Range'] = `bytes ${rangeStart}-${rangeEnd}/${mediaSize}`;
    response.writeHead(status, headers);
    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    if (mode === 'disconnect-once') {
      void (async () => {
        await sendChunks(response, record, rangeStart, rangeEnd, async () => {
          if (record.bytesSent < interruptAfterBytes) return true;
          if ((modes.get(pathname) ?? 'healthy') !== 'disconnect-once') return true;
          modes.set(pathname, 'healthy');
          record.disconnected = true;
          record.faultInjected = true;
          await new Promise((resolve) => setImmediate(resolve));
          response.socket?.destroy();
          return false;
        });
      })();
      return;
    }

    if (mode === 'stall') {
      void (async () => {
        let stalled = false;
        await sendChunks(response, record, rangeStart, rangeEnd, async () => {
          if (!stalled && record.bytesSent >= interruptAfterBytes) {
            stalled = true;
            return waitForHealthyOrClientClose(pathname, request);
          }
          return true;
        });
      })();
      return;
    }

    void sendChunks(response, record, rangeStart, rangeEnd);
  });
  server.on('connection', (socket) => sockets.add(socket));
  server.on('connection', (socket) => socket.once('close', () => sockets.delete(socket)));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    setMode(pathname, mode) {
      modes.set(pathname, mode);
      for (const wake of modeWaiters.get(pathname) ?? []) wake();
    },
    async close() {
      for (const cancel of timerCancels) cancel();
      for (const stream of streams) stream.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
