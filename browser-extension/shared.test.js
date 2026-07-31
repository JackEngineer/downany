/** Node 单测：加载 shared.js 后校验抖音 modal_id 归一。 */
"use strict";

const path = require("path");
const assert = require("assert");

require(path.join(__dirname, "shared.js"));
const {
  extractDouyinVideoId,
  normalizeYtdlpPageUrl,
  isYtdlpPreferredPage,
} = globalThis.VideoDlShared;

assert.strictEqual(
  extractDouyinVideoId(
    "https://www.douyin.com/jingxuan?modal_id=7661234567890123456",
  ),
  "7661234567890123456",
);
assert.strictEqual(
  normalizeYtdlpPageUrl(
    "https://www.douyin.com/jingxuan?modal_id=7661234567890123456&x=1",
  ),
  "https://www.douyin.com/video/7661234567890123456",
);
assert.ok(
  isYtdlpPreferredPage(
    "https://www.douyin.com/jingxuan?modal_id=7661234567890123456",
  ),
);
assert.ok(
  isYtdlpPreferredPage("https://www.douyin.com/video/7661234567890123456"),
);
assert.ok(!isYtdlpPreferredPage("https://www.douyin.com/jingxuan"));
assert.strictEqual(
  normalizeYtdlpPageUrl("https://www.youtube.com/watch?v=abc"),
  "https://www.youtube.com/watch?v=abc",
);

const { videoIdentityKey, extractVisibleTitle } = globalThis.VideoDlShared;

assert.strictEqual(
  videoIdentityKey("https://www.douyin.com/jingxuan?modal_id=111"),
  videoIdentityKey("https://www.douyin.com/video/111"),
);
assert.notStrictEqual(
  videoIdentityKey("https://www.douyin.com/video/111"),
  videoIdentityKey("https://www.douyin.com/video/222"),
);

const { countDisplayMedia } = globalThis.VideoDlShared;
assert.strictEqual(
  countDisplayMedia([
    {
      url: "https://cdn/a",
      pageUrl: "https://www.douyin.com/jingxuan?modal_id=1",
    },
    {
      url: "https://cdn/b",
      pageUrl: "https://www.douyin.com/video/1",
    },
    { url: "https://cdn/c", pageUrl: "https://www.douyin.com/video/2" },
  ]),
  2,
);

// jsdom-less：用简易 Document mock
const fakeDoc = {
  title: "抖音精选电脑版",
  querySelector(sel) {
    if (sel.includes("browse-video-desc")) {
      return { textContent: "  新视频标题ABC  " };
    }
    return null;
  },
};
assert.strictEqual(
  extractVisibleTitle(
    fakeDoc,
    "https://www.douyin.com/jingxuan?modal_id=999",
  ),
  "新视频标题ABC",
);

console.log("shared.js douyin tests passed");
