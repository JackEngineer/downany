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

// Instagram：document.title 常为站点名；og 必须与当前 shortcode 一致才可用
const igDocOg = {
  title: "Instagram",
  querySelector(sel) {
    if (sel.includes("og:url")) {
      return {
        getAttribute: () => "https://www.instagram.com/reels/DbC-8YmTgQt/",
      };
    }
    if (sel === 'meta[property="og:title"]' || sel.includes("og:title")) {
      return {
        getAttribute: () =>
          'goutouluoli_ on Instagram: "今日份小狗 #cute"',
      };
    }
    return null;
  },
};
assert.strictEqual(
  extractVisibleTitle(
    igDocOg,
    "https://www.instagram.com/reels/DbC-8YmTgQt/",
  ),
  "今日份小狗 #cute",
);

const igDocDesc = {
  title: "Instagram",
  querySelector(sel) {
    if (sel.includes("og:url")) {
      return {
        getAttribute: () => "https://www.instagram.com/p/AbCdEf123/",
      };
    }
    if (sel.includes("og:title")) {
      return { getAttribute: () => "Instagram" };
    }
    if (sel.includes("og:description")) {
      return { getAttribute: () => "海边日落，一起看吗？ #reels" };
    }
    return null;
  },
};
assert.strictEqual(
  extractVisibleTitle(
    igDocDesc,
    "https://www.instagram.com/p/AbCdEf123/",
  ),
  "海边日落，一起看吗？ #reels",
);

// SPA 切到下一条时 og 常滞后：不得沿用上一条文案
const igDocStaleOg = {
  title: "Instagram",
  querySelector(sel) {
    if (sel.includes("og:url")) {
      return {
        getAttribute: () => "https://www.instagram.com/reels/OLDCODE123/",
      };
    }
    if (sel.includes("og:title")) {
      return {
        getAttribute: () => 'user on Instagram: "上一条标题"',
      };
    }
    if (sel.includes("og:description")) {
      return { getAttribute: () => "上一条描述" };
    }
    return null;
  },
};
assert.strictEqual(
  extractVisibleTitle(
    igDocStaleOg,
    "https://www.instagram.com/reels/NEWCODE456/",
  ),
  "",
);

const { isWeakPageTitle, extractInstagramShortcode } = globalThis.VideoDlShared;
assert.strictEqual(
  extractInstagramShortcode("https://www.instagram.com/reels/DbC-8YmTgQt/"),
  "DbC-8YmTgQt",
);
assert.ok(isWeakPageTitle("Instagram"));
assert.ok(isWeakPageTitle("Video by goutouluoli_"));
assert.ok(!isWeakPageTitle("今日份小狗 #cute"));

const { isTwitterMediaCdn, isOrphanTwitterCdn } = globalThis.VideoDlShared;
assert.ok(
  isTwitterMediaCdn(
    "https://video.twimg.com/amplify_video/123/pl/YU84xiUy8KeKcvp3.m3u8",
  ),
);
assert.ok(
  isOrphanTwitterCdn(
    "https://video.twimg.com/amplify_video/123/pl/YU84xiUy8KeKcvp3.m3u8",
    "https://x.com/nisobudaow0",
  ),
  "profile page must not keep orphan HLS",
);
assert.ok(
  !isOrphanTwitterCdn(
    "https://video.twimg.com/amplify_video/123/pl/YU84xiUy8KeKcvp3.m3u8",
    "https://x.com/nisobudaow0/status/2082131456168747008",
  ),
  "status page may keep CDN (will collapse to 页面解析)",
);

const { pickPageThumbnail } = globalThis.VideoDlShared;
const thumbDoc = {
  querySelectorAll(sel) {
    if (sel === "video") {
      return [
        { poster: "https://sns-webpic-qc.xhscdn.com/note/cover.jpg" },
      ];
    }
    if (sel === "img[src]") return [];
    return [];
  },
  querySelector() {
    return null;
  },
};
assert.strictEqual(
  pickPageThumbnail(thumbDoc),
  "https://sns-webpic-qc.xhscdn.com/note/cover.jpg",
);

const { findVideoCard } = globalThis.VideoDlShared;

function makeAnchor(href, opts = {}) {
  return {
    getAttribute(name) {
      if (name === "href") return href;
      if (name === "title") return opts.title || "";
      return null;
    },
    querySelector(sel) {
      if (sel === "time" && opts.hasTime) return { tagName: "TIME" };
      return null;
    },
    closest(sel) {
      if (sel === "article") return opts.article || null;
      return null;
    },
  };
}

// 抖音 modal：不依赖 DOM，直接用 location
{
  const video = { closest() { return null; }, parentElement: null };
  const card = findVideoCard(
    video,
    {
      hostname: "www.douyin.com",
      href: "https://www.douyin.com/jingxuan?modal_id=1234567890123456789",
      origin: "https://www.douyin.com",
      pathname: "/jingxuan",
    },
    () => "抖音标题",
  );
  assert.ok(card);
  assert.strictEqual(
    card.pageUrl,
    "https://www.douyin.com/video/1234567890123456789",
  );
  assert.strictEqual(card.title, "抖音标题");
}

// X 卡片：从 article 内 /status/ 链接取详情页
{
  const article = {
    querySelectorAll(sel) {
      if (sel === "a[href]") {
        return [
          makeAnchor("/other/status/111", { article }),
          makeAnchor("/user/status/2222222222222222222", {
            article,
            hasTime: true,
          }),
        ];
      }
      if (sel === '[data-testid="tweetText"]') {
        return [
          {
            textContent: "  推文正文  ",
            closest(s) {
              return s === "article" ? article : null;
            },
          },
        ];
      }
      return [];
    },
    querySelector() {
      return null;
    },
  };
  const video = {
    closest(sel) {
      return sel === "article" ? article : null;
    },
    parentElement: article,
  };
  const card = findVideoCard(
    video,
    {
      hostname: "x.com",
      href: "https://x.com/home",
      origin: "https://x.com",
      pathname: "/home",
    },
    () => "fallback",
  );
  assert.ok(card);
  assert.strictEqual(
    card.pageUrl,
    "https://x.com/user/status/2222222222222222222",
  );
  assert.strictEqual(card.title, "推文正文");
}

// YouTube watch：无卡片时不硬猜，需有容器链接；模拟 watch 页容器
{
  const container = {
    querySelectorAll(sel) {
      if (sel === "a[href]") {
        return [makeAnchor("/watch?v=dQw4w9WgXcQ")];
      }
      if (sel === '[data-testid="tweetText"]') return [];
      return [];
    },
    querySelector(sel) {
      if (sel === "#video-title, h3, h2") {
        return { textContent: "  Never Gonna Give You Up  " };
      }
      return null;
    },
  };
  const video = {
    closest() {
      return null;
    },
    parentElement: container,
  };
  container.querySelector = function (sel) {
    if (
      sel ===
      "a[href*='/status/'], a[href*='/watch'], a[href*='/video/'], a[href*='/reel/'], a[href*='/p/']"
    ) {
      return makeAnchor("/watch?v=dQw4w9WgXcQ");
    }
    if (sel === "#video-title, h3, h2") {
      return { textContent: "  Never Gonna Give You Up  " };
    }
    if (sel === "a[title]") return null;
    return null;
  };
  const card = findVideoCard(
    video,
    {
      hostname: "www.youtube.com",
      href: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      origin: "https://www.youtube.com",
      pathname: "/watch",
    },
    () => "YT fallback",
  );
  assert.ok(card);
  assert.strictEqual(
    card.pageUrl,
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
  assert.strictEqual(card.title, "Never Gonna Give You Up");
}

// 无匹配主机：返回 null
{
  const video = { closest() { return null; }, parentElement: null };
  const card = findVideoCard(
    video,
    {
      hostname: "example.com",
      href: "https://example.com/player",
      origin: "https://example.com",
      pathname: "/player",
    },
    () => "x",
  );
  assert.strictEqual(card, null);
}

console.log("shared.js title tests passed");
