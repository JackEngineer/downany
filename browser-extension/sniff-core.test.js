/** Node 单测：加载 sniff-core.js 后校验清单解析与 URL 分类。 */
"use strict";

const path = require("path");
const assert = require("assert");

require(path.join(__dirname, "sniff-core.js"));
const {
  parseM3U8,
  parseMPD,
  isSegmentUrl,
  playlistGroupKey,
  looksLikeMediaUrl,
  normalizeMediaKey,
  classifyByContentType,
} = globalThis.VideoDlSniffCore;

// ---- parseM3U8 master ----
const masterText = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=854x480
480p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1280x720
720p/index.m3u8
`;
const master = parseM3U8(masterText);
assert.ok(master);
assert.strictEqual(master.kind, "master");
assert.strictEqual(master.variants, 2);
assert.strictEqual(master.bestResolution, "1280x720");
assert.strictEqual(master.maxBandwidth, 2560000);

// ---- parseM3U8 media ----
const mediaText = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:5.0,
seg0.ts
#EXTINF:5.0,
seg1.ts
#EXT-X-ENDLIST
`;
const media = parseM3U8(mediaText);
assert.ok(media);
assert.strictEqual(media.kind, "media");
assert.strictEqual(media.variants, 0);
assert.strictEqual(media.duration, 10);

// invalid m3u8
assert.strictEqual(parseM3U8("not a playlist"), null);
assert.strictEqual(parseM3U8("#EXTM3U\n"), null);

// ---- parseMPD ----
const mpdText = `<MPD mediaPresentationDuration="PT1M30.5S"><Period></Period></MPD>`;
const dash = parseMPD(mpdText);
assert.ok(dash);
assert.strictEqual(dash.kind, "dash");
assert.strictEqual(dash.duration, 91);

// ---- isSegmentUrl ----
assert.ok(isSegmentUrl("https://cdn.example.com/seg001.ts"));
assert.ok(isSegmentUrl("https://cdn.example.com/init.m4s?token=abc"));
assert.ok(!isSegmentUrl("https://cdn.example.com/master.m3u8"));
assert.ok(!isSegmentUrl("https://cdn.example.com/video.mp4"));

// ---- playlistGroupKey ----
const twUrl =
  "https://video.twimg.com/ext_tw_video/123/pu/pl/720x1280/index.m3u8";
assert.strictEqual(
  playlistGroupKey(twUrl),
  "https://video.twimg.com/ext_tw_video/123/pu",
);
assert.strictEqual(
  playlistGroupKey("https://cdn.example.com/hls/720x1280/playlist.m3u8"),
  "https://cdn.example.com/hls",
);
assert.strictEqual(
  playlistGroupKey("https://cdn.example.com/hls/1080p/stream.m3u8"),
  "https://cdn.example.com/hls",
);

// ---- looksLikeMediaUrl ----
assert.ok(looksLikeMediaUrl("https://cdn.example.com/video.mp4"));
assert.ok(looksLikeMediaUrl("https://cdn.example.com/master.m3u8"));
assert.ok(!looksLikeMediaUrl("https://cdn.example.com/seg.ts"));
assert.ok(!looksLikeMediaUrl("https://cdn.example.com/page.html"));

// ---- normalizeMediaKey ----
assert.strictEqual(
  normalizeMediaKey("https://cdn.example.com/a.mp4?range=0-100&x=1"),
  "https://cdn.example.com/a.mp4?x=1",
);

// ---- classifyByContentType ----
assert.strictEqual(
  classifyByContentType("application/vnd.apple.mpegurl"),
  "hls",
);
assert.strictEqual(classifyByContentType("application/dash+xml"), "dash");
assert.strictEqual(classifyByContentType("video/mp4"), "file");
assert.strictEqual(classifyByContentType("text/html"), null);

console.log("sniff-core.js tests passed");
