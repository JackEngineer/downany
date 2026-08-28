import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import test from 'node:test';

import { createMediaFaultServer } from './windows_media_fault_server.mjs';

const mediaBytes = Buffer.from(Array.from({ length: 100_003 }, (_, index) => index % 251));
const fixturePrefix = 'downany-media-fault-';
const requestTimeoutMs = 2_000;

async function createFixture(bytes = mediaBytes) {
  const fixtureParent = await realpath(tmpdir());
  const fixtureDir = await mkdtemp(join(fixtureParent, fixturePrefix));
  const mediaPath = join(fixtureDir, 'fixture.mp4');
  await writeFile(mediaPath, bytes);
  return { fixtureParent, fixtureDir, mediaPath };
}

async function removeFixture({ fixtureParent, fixtureDir }) {
  const resolvedParent = await realpath(fixtureParent);
  const resolvedFixture = await realpath(fixtureDir);
  const relativeFixture = relative(resolvedParent, resolvedFixture);
  assert.ok(isAbsolute(resolvedFixture), 'fixture cleanup target must be absolute');
  assert.equal(dirname(resolvedFixture), resolvedParent, 'fixture cleanup target must be directly below TEMP');
  assert.ok(basename(resolvedFixture).startsWith(fixturePrefix), 'fixture cleanup target must use the created prefix');
  assert.ok(relativeFixture && !relativeFixture.startsWith('..') && !isAbsolute(relativeFixture),
    'fixture cleanup target must stay within the created TEMP parent');
  await rm(resolvedFixture, { recursive: true, force: true });
}

async function withMediaServer(run, options = {}) {
  const fixture = await createFixture();
  const server = await createMediaFaultServer(fixture.mediaPath, options);
  try {
    await run(server);
  } finally {
    try {
      await completesWithin(server.close(), 500, 'media server cleanup');
    } finally {
      await removeFixture(fixture);
    }
  }
}

function httpRequest(baseUrl, pathname, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let timeout;
    const settle = (callback, value) => {
      clearTimeout(timeout);
      callback(value);
    };
    const req = request(`${baseUrl}${pathname}`, { method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => settle(resolve, {
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
        disconnected: false,
      }));
      response.on('aborted', () => settle(resolve, {
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
        disconnected: true,
      }));
      response.on('error', (error) => settle(reject, error));
    });
    timeout = setTimeout(() => req.destroy(new Error(`HTTP request exceeded ${requestTimeoutMs}ms`)), requestTimeoutMs);
    req.on('error', (error) => settle(reject, error));
    req.end();
  });
}

function httpGet(baseUrl, pathname, headers = {}) {
  return httpRequest(baseUrl, pathname, { headers });
}

function abortHttpGetAfterBytes(baseUrl, pathname, afterBytes) {
  return new Promise((resolve, reject) => {
    let timeout;
    let settled = false;
    let bytesRead = 0;
    let aborted = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const req = request(`${baseUrl}${pathname}`, (response) => {
      response.on('data', (chunk) => {
        bytesRead += chunk.length;
        if (!aborted && bytesRead >= afterBytes) {
          aborted = true;
          req.destroy();
        }
      });
      response.once('close', () => settle(resolve, bytesRead));
      response.once('error', (error) => {
        if (!aborted) settle(reject, error);
      });
    });
    timeout = setTimeout(() => req.destroy(new Error(`HTTP request exceeded ${requestTimeoutMs}ms`)), requestTimeoutMs);
    req.once('error', (error) => {
      if (!aborted) settle(reject, error);
    });
    req.end();
  });
}

function startHttpGet(baseUrl, pathname, afterBytes) {
  let resolveThreshold;
  let rejectThreshold;
  let resolveCompleted;
  let rejectCompleted;
  let thresholdReached = false;
  const reachedThreshold = new Promise((resolve, reject) => {
    resolveThreshold = resolve;
    rejectThreshold = reject;
  });
  const completed = new Promise((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  let timeout;
  const finish = (value) => {
    clearTimeout(timeout);
    if (!thresholdReached) rejectThreshold(new Error(`HTTP response ended before ${afterBytes} bytes arrived`));
    resolveCompleted(value);
  };
  const fail = (error) => {
    clearTimeout(timeout);
    if (!thresholdReached) rejectThreshold(error);
    rejectCompleted(error);
  };
  const req = request(`${baseUrl}${pathname}`, (response) => {
    const chunks = [];
    response.on('data', (chunk) => {
      chunks.push(chunk);
      if (!thresholdReached && Buffer.concat(chunks).length >= afterBytes) {
        thresholdReached = true;
        resolveThreshold();
      }
    });
    response.once('end', () => finish({
      status: response.statusCode,
      headers: response.headers,
      body: Buffer.concat(chunks),
      disconnected: false,
    }));
    response.once('aborted', () => finish({
      status: response.statusCode,
      headers: response.headers,
      body: Buffer.concat(chunks),
      disconnected: true,
    }));
    response.once('error', fail);
  });
  timeout = setTimeout(() => req.destroy(new Error(`HTTP request exceeded ${requestTimeoutMs}ms`)), requestTimeoutMs);
  req.once('error', fail);
  req.end();
  return { reachedThreshold, completed };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function completesWithin(promise, milliseconds, label) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function assertServerCreationFails(mediaPath, options, expectedMessage) {
  let server;
  try {
    server = await createMediaFaultServer(mediaPath, options);
  } catch (error) {
    assert.match(error.message, expectedMessage);
    return;
  } finally {
    await server?.close();
  }
  assert.fail('server creation unexpectedly succeeded');
}

test('healthy media route returns the complete fixture with accurate request evidence', async () => {
  await withMediaServer(async (server) => {
    const response = await httpGet(server.baseUrl, '/retry.mp4');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, mediaBytes);
    assert.equal(response.headers['content-length'], String(mediaBytes.length));
    assert.deepEqual(server.requests, [{
      method: 'GET',
      pathname: '/retry.mp4',
      status: 200,
      rangeStart: 0,
      rangeEnd: mediaBytes.length - 1,
      bytesSent: mediaBytes.length,
      disconnected: false,
      faultInjected: false,
    }]);
  });
});

test('healthy media route honors HEAD and single byte ranges while rejecting invalid ranges', async () => {
  await withMediaServer(async (server) => {
    const head = await httpRequest(server.baseUrl, '/range.mp4', { method: 'HEAD' });
    const partial = await httpGet(server.baseUrl, '/range.mp4', { Range: 'bytes=10-19' });
    const openEnded = await httpGet(server.baseUrl, '/range.mp4', { Range: 'bytes=100000-' });
    const invalid = await httpGet(server.baseUrl, '/range.mp4', { Range: 'bytes=100003-' });
    const nonMedia = await httpGet(server.baseUrl, '/not-media');

    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-length'], '100003');
    assert.equal(partial.status, 206);
    assert.equal(partial.headers['content-range'], 'bytes 10-19/100003');
    assert.deepEqual(partial.body, mediaBytes.subarray(10, 20));
    assert.equal(openEnded.status, 206);
    assert.equal(openEnded.headers['content-range'], 'bytes 100000-100002/100003');
    assert.deepEqual(openEnded.body, mediaBytes.subarray(100000));
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers['content-range'], 'bytes */100003');
    assert.equal(nonMedia.status, 404);
  });
});

test('a missing route can become healthy without replacing the server', async () => {
  await withMediaServer(async (server) => {
    server.setMode('/retry.mp4', 'missing');
    const missing = await httpGet(server.baseUrl, '/retry.mp4');
    server.setMode('/retry.mp4', 'healthy');
    const recovered = await httpGet(server.baseUrl, '/retry.mp4');

    assert.equal(missing.status, 404);
    assert.equal(recovered.status, 200);
    assert.deepEqual(recovered.body, mediaBytes);
  });
});

test('disconnect-once preserves a usable partial response for a byte-range retry', async () => {
  await withMediaServer(async (server) => {
    server.setMode('/interrupt.mp4', 'disconnect-once');
    const head = await httpRequest(server.baseUrl, '/interrupt.mp4', { method: 'HEAD' });
    const interrupted = await httpGet(server.baseUrl, '/interrupt.mp4');
    const retry = await httpGet(server.baseUrl, '/interrupt.mp4', {
      Range: `bytes=${interrupted.body.length}-`,
    });

    assert.equal(head.status, 200);
    assert.equal(interrupted.disconnected, true);
    assert.ok(interrupted.body.length >= 65_536);
    assert.equal(retry.status, 206);
    assert.deepEqual(Buffer.concat([interrupted.body, retry.body]), mediaBytes);
    assert.equal(server.requests[0].disconnected, false);
    assert.equal(server.requests[0].faultInjected, false);
    assert.equal(server.requests[1].disconnected, true);
    assert.equal(server.requests[1].faultInjected, true);
    assert.equal(server.requests[2].rangeStart, interrupted.body.length);
    assert.equal(server.requests[2].faultInjected, false);
  }, { chunkBytes: 16_384, intervalMs: 1, interruptAfterBytes: 65_536 });
});

test('a short client probe does not consume disconnect-once before the injected cutoff', async () => {
  await withMediaServer(async (server) => {
    server.setMode('/probe.mp4', 'disconnect-once');
    const probeBytes = await abortHttpGetAfterBytes(server.baseUrl, '/probe.mp4', 1);
    const interrupted = await httpGet(server.baseUrl, '/probe.mp4');
    const retry = await httpGet(server.baseUrl, '/probe.mp4', {
      Range: `bytes=${interrupted.body.length}-`,
    });

    assert.ok(probeBytes < 65_536);
    assert.equal(interrupted.disconnected, true);
    assert.ok(interrupted.body.length >= 65_536);
    assert.equal(retry.status, 206);
    assert.deepEqual(Buffer.concat([interrupted.body, retry.body]), mediaBytes);
    assert.equal(server.requests[0].faultInjected, false);
    assert.equal(server.requests[1].faultInjected, true);
    assert.equal(server.requests[2].faultInjected, false);
  }, { chunkBytes: 16_384, intervalMs: 1, interruptAfterBytes: 65_536 });
});

test('concurrent disconnect-once requests receive at most one injected disconnect', async () => {
  await withMediaServer(async (server) => {
    server.setMode('/parallel.mp4', 'disconnect-once');
    const responses = await Promise.all([
      httpGet(server.baseUrl, '/parallel.mp4'),
      httpGet(server.baseUrl, '/parallel.mp4'),
    ]);

    assert.equal(responses.filter((response) => response.disconnected).length, 1);
    assert.equal(server.requests.filter((record) => record.disconnected).length, 1);
    assert.equal(server.requests.filter((record) => record.faultInjected).length, 1);
  }, { chunkBytes: 16_384, intervalMs: 1, interruptAfterBytes: 65_536 });
});

test('stall holds an active response until its path is made healthy', async () => {
  await withMediaServer(async (server) => {
    server.setMode('/pause.mp4', 'stall');
    const stalled = startHttpGet(server.baseUrl, '/pause.mp4', 65_536);
    await stalled.reachedThreshold;

    const beforeRelease = await Promise.race([
      stalled.completed.then(() => 'completed'),
      delay(40).then(() => 'waiting'),
    ]);
    assert.equal(beforeRelease, 'waiting');

    server.setMode('/pause.mp4', 'healthy');
    const resumed = await stalled.completed;
    assert.equal(resumed.status, 200);
    assert.deepEqual(resumed.body, mediaBytes);
  }, { chunkBytes: 16_384, intervalMs: 1, interruptAfterBytes: 65_536 });
});

test('close releases a stalled socket without touching a separate local server', async () => {
  const fixture = await createFixture();
  const faultServer = await createMediaFaultServer(fixture.mediaPath, { interruptAfterBytes: 65_536 });
  const unrelated = createServer((_request, response) => response.end('unrelated'));
  await new Promise((resolve) => unrelated.listen(0, '127.0.0.1', resolve));
  const unrelatedPort = unrelated.address().port;
  try {
    faultServer.setMode('/pause.mp4', 'stall');
    const stalled = startHttpGet(faultServer.baseUrl, '/pause.mp4', 65_536);
    await stalled.reachedThreshold;

    await completesWithin(faultServer.close(), 500, 'fault server close');
    const outside = await httpGet(`http://127.0.0.1:${unrelatedPort}`, '/');
    assert.equal(outside.status, 200);
    assert.equal(outside.body.toString(), 'unrelated');
  } finally {
    await new Promise((resolve) => unrelated.close(resolve));
    await removeFixture(fixture);
  }
});

test('chunk interval keeps a healthy response open between chunks and close cancels that wait', async () => {
  await withMediaServer(async (server) => {
    const transfer = startHttpGet(server.baseUrl, '/paced.mp4', 16_384);
    await transfer.reachedThreshold;
    const beforeNextChunk = await Promise.race([
      transfer.completed.then(() => 'completed'),
      delay(30).then(() => 'waiting'),
    ]);
    assert.equal(beforeNextChunk, 'waiting');

    await completesWithin(server.close(), 500, 'paced server close');
  }, { chunkBytes: 16_384, intervalMs: 100 });
});

test('invalid throttling options and an empty media file fail before a server starts', async () => {
  const fixture = await createFixture(Buffer.alloc(0));
  try {
    await assertServerCreationFails(fixture.mediaPath, { chunkBytes: 0 }, /chunkBytes/);
    await assertServerCreationFails(fixture.mediaPath, { intervalMs: -1 }, /intervalMs/);
    await assertServerCreationFails(fixture.mediaPath, { interruptAfterBytes: 0 }, /interruptAfterBytes/);
    await assertServerCreationFails(fixture.mediaPath, {}, /empty/);
  } finally {
    await removeFixture(fixture);
  }
});
