# Downany 真实媒体横幅还原实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让真实 Electron 中的低清、竖向、亮色与缺失缩略图都呈现稳定、精致且可读的媒体横幅，同时恢复深色视觉基准并消除顶部输入框的双层外壳。

**Architecture:** 新增一个无 React 依赖的媒体呈现模块，负责图片质量、画幅、相对亮度和亮度等级判断；`MediaTaskBanner` 只管理图片加载、尺寸监听与任务行为，并输出语义数据属性。所有静态视觉集中到令牌和 `media-task-banner.css`，低质量媒体由全幅模糊环境层与右侧清晰焦点层共同呈现。

**Tech Stack:** React 18、TypeScript 5、Vitest、Testing Library、CSS Custom Properties、ResizeObserver、Canvas 2D、Python `JsonConfig`、pytest、Electron 33。

## Global Constraints

- 不新增运行时依赖、远程图片服务或持久化媒体分析数据。
- 新配置默认主题是 `dark`；已有明确保存的 `light / dark / system` 必须原样保留。
- `standard` 要求天然宽高均不小于横幅渲染宽高，且图片宽高比不小于 `1.2`；其余有效图片为 `weak`，缺失、加载失败或尺寸无效为 `missing`。
- 图片天然尺寸或横幅尺寸未知时先按 `weak` 渲染，避免低清全幅闪现。
- 相对亮度阈值固定为：`dark < 0.24`、`medium = 0.24–0.58`、`light > 0.58`；无法读取 Canvas 像素时回退到 `light`。
- `weak` 环境层使用 `22px` 模糊、`0.62` 亮度、轻降饱和与小幅放大；右侧清晰焦点层宽 `48%`，左缘羽化 `88px`。
- Reading Glass 宽 `58%`、模糊 `40px`、饱和度 `1.2`、右缘羽化 `108px`；`dark / medium / light` 染色透明度分别为 `0.34 / 0.42 / 0.50`，`weak` 分别为 `0.38 / 0.46 / 0.54`。
- 浅色主题只改变窗口镀铬与普通控件；媒体横幅仍使用深色 Reading Glass 与白色媒体文字。
- React 只保留任务行为、媒体测量、媒体分类和动态进度；静态视觉不得继续由旧内联样式控制。
- 玻璃只覆盖左侧文字阅读区，右侧媒体焦点必须可辨认；禁止整卡灰雾、奶白蒙版和通用玻璃拟态。
- 保留现有任务状态、重命名、主要操作、更多菜单、恢复操作、键盘焦点和上下文菜单行为。
- `760px` 窗口宽度下标题可省略、主要操作可用且不得水平溢出。
- 最终视觉通过条件只接受真实 Electron 与现有 3 个任务；开发画廊只用于状态覆盖。

---

## 文件结构

- Create `desktop/renderer/components/task/artworkPresentation.ts`：媒体尺寸、画幅、亮度采样与分类的唯一实现。
- Create `desktop/renderer/components/task/artworkPresentation.test.ts`：纯函数边界、采样和安全回退测试。
- Modify `desktop/renderer/components/task/MediaTaskBanner.tsx`：接入测量结果，渲染环境层、焦点层与语义数据属性，删除旧内联视觉常量。
- Modify `desktop/renderer/components/task/MediaTaskBanner.test.tsx`：覆盖真实媒体结构、加载、尺寸变化、自动亮度和缺失回退。
- Modify `desktop/renderer/styles/media-task-banner.css`：横幅唯一视觉源与低质量媒体降级。
- Modify `design-system/tokens.css`：环境层、焦点层与两档 Reading Glass 令牌。
- Modify `desktop/renderer/styles/tokenContract.test.ts`：把新增语义令牌纳入现有令牌契约。
- Modify `desktop/renderer/components/design-system/DesktopCoreGallery.tsx`：删除手工 `artworkTone`，继续直接复用生产组件。
- Modify `desktop/renderer/components/design-system/DesktopCoreGallery.test.tsx`：验证画廊不再依赖手工亮度，仍覆盖所有任务状态。
- Modify `desktop/renderer/styles/ui.css`：关闭原生输入框外观，仅保留 `TextField` 外壳。
- Modify `desktop/renderer/components/ui/uiPrimitives.test.tsx`：验证实际输入控件只有一个外壳且原生 appearance 已关闭。
- Modify `src/data/json_config.py`：新配置默认主题改为深色。
- Modify `tests/data/test_json_config.py`：覆盖新默认值和既有三种显式主题值。
- Modify `docs/UI-DESIGN-LANGUAGE.md`：记录自动亮度来源和无法采样时的保守 `light` 回退。

### Task 1: 建立媒体呈现分类模块

**Files:**
- Create: `desktop/renderer/components/task/artworkPresentation.ts`
- Create: `desktop/renderer/components/task/artworkPresentation.test.ts`

**Interfaces:**
- Produces: `ArtworkDimensions`、`ArtworkQuality`、`ArtworkShape`、`ArtworkTone`。
- Produces: `classifyArtwork(naturalSize, renderedSize, unavailable): ArtworkQuality`。
- Produces: `classifyArtworkShape(naturalSize): ArtworkShape`。
- Produces: `averageRelativeLuminance(pixels): number | null`。
- Produces: `sampleArtworkLuminance(image, createCanvas?): number | null`。
- Produces: `classifyArtworkTone(relativeLuminance): ArtworkTone`。

- [ ] **Step 1: 先写会失败的分类与采样测试**

```ts
import { describe, expect, it } from "vitest";

import {
  averageRelativeLuminance,
  classifyArtwork,
  classifyArtworkShape,
  classifyArtworkTone,
  sampleArtworkLuminance,
} from "./artworkPresentation";

describe("artwork presentation", () => {
  it("keeps a sufficiently large landscape image standard", () => {
    expect(
      classifyArtwork(
        { width: 1920, height: 1080 },
        { width: 1200, height: 108 },
        false,
      ),
    ).toBe("standard");
  });

  it.each([
    [{ width: 720, height: 960 }, { width: 1200, height: 108 }],
    [{ width: 640, height: 360 }, { width: 1200, height: 108 }],
    [null, { width: 1200, height: 108 }],
  ])("uses the weak composition before or below the standard threshold", (natural, rendered) => {
    expect(classifyArtwork(natural, rendered, false)).toBe("weak");
  });

  it("marks unavailable or invalid artwork missing", () => {
    expect(classifyArtwork(null, null, true)).toBe("missing");
    expect(
      classifyArtwork({ width: 0, height: 1080 }, { width: 1200, height: 108 }, false),
    ).toBe("missing");
  });

  it("distinguishes portrait artwork at the 1.2 boundary", () => {
    expect(classifyArtworkShape({ width: 720, height: 960 })).toBe("portrait");
    expect(classifyArtworkShape({ width: 1200, height: 1000 })).toBe("landscape");
    expect(classifyArtworkShape(null)).toBe("unknown");
  });

  it.each([
    [0.239, "dark"],
    [0.24, "medium"],
    [0.58, "medium"],
    [0.581, "light"],
    [null, "light"],
    [Number.NaN, "light"],
  ] as const)("classifies luminance %s as %s", (luminance, tone) => {
    expect(classifyArtworkTone(luminance)).toBe(tone);
  });

  it("computes transparent-aware relative luminance from literal pixels", () => {
    const pixels = new Uint8ClampedArray([
      255, 255, 255, 255,
      0, 0, 0, 255,
      255, 0, 0, 0,
    ]);
    expect(averageRelativeLuminance(pixels)).toBeCloseTo(0.5, 5);
  });

  it("returns null when Canvas pixel access is rejected", () => {
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => {
        throw new DOMException("tainted", "SecurityError");
      },
    } as unknown as HTMLCanvasElement;
    expect(
      sampleArtworkLuminance({} as HTMLImageElement, () => canvas),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试并确认因模块尚不存在而失败**

Run: `cd desktop && npm test -- renderer/components/task/artworkPresentation.test.ts`

Expected: FAIL，错误包含无法解析 `./artworkPresentation`。

- [ ] **Step 3: 实现最小分类与采样模块**

```ts
export interface ArtworkDimensions {
  width: number;
  height: number;
}

export type ArtworkQuality = "standard" | "weak" | "missing";
export type ArtworkShape = "landscape" | "portrait" | "unknown";
export type ArtworkTone = "dark" | "medium" | "light";

function validDimensions(value: ArtworkDimensions | null): value is ArtworkDimensions {
  return Boolean(value && value.width > 0 && value.height > 0);
}

export function classifyArtwork(
  naturalSize: ArtworkDimensions | null,
  renderedSize: ArtworkDimensions | null,
  unavailable: boolean,
): ArtworkQuality {
  if (unavailable) return "missing";
  if (naturalSize && !validDimensions(naturalSize)) return "missing";
  if (!validDimensions(naturalSize) || !validDimensions(renderedSize)) return "weak";
  const wideEnough = naturalSize.width / naturalSize.height >= 1.2;
  return wideEnough &&
    naturalSize.width >= renderedSize.width &&
    naturalSize.height >= renderedSize.height
    ? "standard"
    : "weak";
}

export function classifyArtworkShape(
  naturalSize: ArtworkDimensions | null,
): ArtworkShape {
  if (!validDimensions(naturalSize)) return "unknown";
  return naturalSize.width / naturalSize.height >= 1.2 ? "landscape" : "portrait";
}

function linearChannel(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function averageRelativeLuminance(pixels: Uint8ClampedArray): number | null {
  let weightedTotal = 0;
  let alphaTotal = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const alpha = pixels[index + 3] / 255;
    if (alpha === 0) continue;
    const luminance =
      0.2126 * linearChannel(pixels[index]) +
      0.7152 * linearChannel(pixels[index + 1]) +
      0.0722 * linearChannel(pixels[index + 2]);
    weightedTotal += luminance * alpha;
    alphaTotal += alpha;
  }
  return alphaTotal > 0 ? weightedTotal / alphaTotal : null;
}

export function sampleArtworkLuminance(
  image: HTMLImageElement,
  createCanvas: () => HTMLCanvasElement = () => document.createElement("canvas"),
): number | null {
  try {
    const canvas = createCanvas();
    canvas.width = 16;
    canvas.height = 16;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, 16, 16);
    return averageRelativeLuminance(context.getImageData(0, 0, 16, 16).data);
  } catch {
    return null;
  }
}

export function classifyArtworkTone(relativeLuminance: number | null): ArtworkTone {
  if (
    relativeLuminance === null ||
    !Number.isFinite(relativeLuminance) ||
    relativeLuminance > 0.58
  ) return "light";
  if (relativeLuminance < 0.24) return "dark";
  return "medium";
}
```

- [ ] **Step 4: 运行测试并确认全部通过**

Run: `cd desktop && npm test -- renderer/components/task/artworkPresentation.test.ts`

Expected: PASS，14 个分类与采样用例全部通过；除既有 Vite CJS deprecation 外无新增警告。

- [ ] **Step 5: 做变异检查并提交**

确认把 `>= 1.2` 改成 `> 1.2`、把 `0.58` 改成 `0.6`、删除 `unavailable` 分支或忽略 alpha 时，至少一个测试会失败。

```bash
git add desktop/renderer/components/task/artworkPresentation.ts desktop/renderer/components/task/artworkPresentation.test.ts
git commit -m "feat(ui): 增加任务媒体自适应分类"
```

### Task 2: 接入自适应双层媒体与 Reading Glass

**Files:**
- Modify: `desktop/renderer/components/task/MediaTaskBanner.tsx`
- Modify: `desktop/renderer/components/task/MediaTaskBanner.test.tsx`
- Modify: `desktop/renderer/styles/media-task-banner.css`
- Modify: `design-system/tokens.css`
- Modify: `desktop/renderer/styles/tokenContract.test.ts`
- Modify: `desktop/renderer/components/design-system/DesktopCoreGallery.tsx`
- Modify: `desktop/renderer/components/design-system/DesktopCoreGallery.test.tsx`
- Modify: `docs/UI-DESIGN-LANGUAGE.md`

**Interfaces:**
- Consumes: Task 1 的 `classifyArtwork`、`classifyArtworkShape`、`sampleArtworkLuminance`、`classifyArtworkTone` 及其类型。
- Produces: 根节点 `data-media-quality`、`data-artwork-shape`、自动 `data-artwork-tone`。
- Produces: `.media-task-banner__artwork-ambient` 与仅在 `weak` 下存在的 `.media-task-banner__artwork-focus`。
- Preserves: `MediaTaskBannerProps = { task; density? }`，不再公开 `artworkTone`。

- [ ] **Step 1: 给组件测试增加可控 ResizeObserver 与 Canvas 边界**

在 `MediaTaskBanner.test.tsx` 中加入真实组件所需的浏览器边界替身。替身只控制外部 API，断言仍针对真实 `MediaTaskBanner` DOM 与数据属性。

```ts
let resizeCallback: ResizeObserverCallback;

class ResizeObserverMock implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): ResizeObserverEntry[] {
    return [];
  }
}

function emitResize(target: Element, width: number, height: number): void {
  resizeCallback(
    [{ target, contentRect: { width, height } } as ResizeObserverEntry],
    {} as ResizeObserver,
  );
}

function loadImage(image: HTMLImageElement, width: number, height: number): void {
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: width },
    naturalHeight: { configurable: true, value: height },
  });
  fireEvent.load(image);
}

function mockCanvasGray(channel: number): void {
  const pixels = new Uint8ClampedArray(16 * 16 * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = channel;
    pixels[index + 1] = channel;
    pixels[index + 2] = channel;
    pixels[index + 3] = 255;
  }
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    getImageData: () => ({ data: pixels }),
  } as unknown as CanvasRenderingContext2D);
}
```

在 `beforeEach` 设置 `globalThis.ResizeObserver = ResizeObserverMock`，在 `afterEach` 恢复 mocks。

- [ ] **Step 2: 先写会失败的真实媒体结构测试**

```tsx
it("uses ambient plus contained focus media for weak portrait artwork", () => {
  mockCanvasGray(255);
  const { container } = render(
    <MediaTaskBanner task={taskFixture({ thumbnail_url: "https://example.com/portrait.jpg" })} />,
  );
  const banner = container.querySelector(".media-task-banner") as HTMLElement;
  emitResize(banner, 1200, 108);
  const ambient = container.querySelector(
    ".media-task-banner__artwork-ambient",
  ) as HTMLImageElement;
  loadImage(ambient, 720, 960);

  expect(banner).toHaveAttribute("data-media-quality", "weak");
  expect(banner).toHaveAttribute("data-artwork-shape", "portrait");
  expect(banner).toHaveAttribute("data-artwork-tone", "light");
  expect(container.querySelectorAll(".media-task-banner__artwork-focus")).toHaveLength(1);
});

it("removes the focus layer for a standard landscape image", () => {
  mockCanvasGray(0);
  const { container } = render(
    <MediaTaskBanner task={taskFixture({ thumbnail_url: "https://example.com/wide.jpg" })} />,
  );
  const banner = container.querySelector(".media-task-banner") as HTMLElement;
  emitResize(banner, 1200, 108);
  loadImage(
    container.querySelector(".media-task-banner__artwork-ambient") as HTMLImageElement,
    1920,
    1080,
  );

  expect(banner).toHaveAttribute("data-media-quality", "standard");
  expect(banner).toHaveAttribute("data-artwork-tone", "dark");
  expect(container.querySelector(".media-task-banner__artwork-focus")).toBeNull();
});

it("reclassifies standard artwork when the banner grows past its natural width", () => {
  mockCanvasGray(100);
  const { container } = render(
    <MediaTaskBanner task={taskFixture({ thumbnail_url: "https://example.com/wide.jpg" })} />,
  );
  const banner = container.querySelector(".media-task-banner") as HTMLElement;
  const ambient = container.querySelector(
    ".media-task-banner__artwork-ambient",
  ) as HTMLImageElement;
  emitResize(banner, 1000, 108);
  loadImage(ambient, 1280, 720);
  expect(banner).toHaveAttribute("data-media-quality", "standard");

  emitResize(banner, 1400, 108);
  expect(banner).toHaveAttribute("data-media-quality", "weak");
});
```

同时把旧的“显式 `artworkTone`”用例删除，并让空图片与加载失败用例断言 `data-media-quality="missing"`。

- [ ] **Step 3: 运行组件测试并确认因结构与接口尚未实现而失败**

Run: `cd desktop && npm test -- renderer/components/task/MediaTaskBanner.test.tsx`

Expected: FAIL，缺少环境层、焦点层与 `data-media-quality`。

- [ ] **Step 4: 让 `MediaTaskBanner` 只管理行为与媒体测量**

删除 `TONE_OVERLAYS`、`ROOT_*`、`ARTWORK_*`、`GLASS_STYLE`、文字/元信息/状态/操作/进度等旧内联视觉常量。保留动态进度宽度这一项内联值。

核心状态与派生值采用以下结构：

```tsx
const rootRef = useRef<HTMLLIElement>(null);
const [thumbnailBroken, setThumbnailBroken] = useState(false);
const [naturalSize, setNaturalSize] = useState<ArtworkDimensions | null>(null);
const [bannerSize, setBannerSize] = useState<ArtworkDimensions | null>(null);
const [artworkTone, setArtworkTone] = useState<ArtworkTone>("light");

useEffect(() => {
  setThumbnailBroken(false);
  setNaturalSize(null);
  setArtworkTone("light");
}, [task.thumbnail_url]);

useEffect(() => {
  const node = rootRef.current;
  if (!node) return;
  const update = (width: number, height: number) => {
    setBannerSize({ width, height });
  };
  const rect = node.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) update(rect.width, rect.height);
  const observer = new ResizeObserver(([entry]) => {
    if (entry) update(entry.contentRect.width, entry.contentRect.height);
  });
  observer.observe(node);
  return () => observer.disconnect();
}, []);

const unavailable = !task.thumbnail_url || thumbnailBroken;
const mediaQuality = classifyArtwork(naturalSize, bannerSize, unavailable);
const artworkShape = classifyArtworkShape(naturalSize);

const handleArtworkLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
  const image = event.currentTarget;
  setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight });
  setArtworkTone(classifyArtworkTone(sampleArtworkLuminance(image)));
};
```

给现有根 `<li>` 增加以下属性；保留既有 `id`、状态 class 与上下文菜单处理器：

```tsx
ref={rootRef}
data-media-quality={mediaQuality}
data-artwork-shape={artworkShape}
data-artwork-tone={artworkTone}
```

在内容区之前渲染以下完整媒体、暗化和玻璃层：

```tsx
<>
  <div className="media-task-banner__artwork" aria-hidden>
    {mediaQuality === "missing" ? (
      <div className="media-task-banner__artwork-placeholder">{initial}</div>
    ) : (
      <>
        <img
          className="media-task-banner__artwork-ambient"
          src={task.thumbnail_url}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onLoad={handleArtworkLoad}
          onError={() => setThumbnailBroken(true)}
        />
        {mediaQuality === "weak" ? (
          <img
            className="media-task-banner__artwork-focus"
            src={task.thumbnail_url}
            alt=""
            referrerPolicy="no-referrer"
          />
        ) : null}
      </>
    )}
  </div>
  <div className="media-task-banner__shade" aria-hidden />
  <div className="media-task-banner__glass" aria-hidden />
</>
```

现有内容、任务动作、恢复动作、菜单和进度 DOM 保持原顺序，只删除其静态 `style` props；进度 `<span>` 的动态 `width` 继续保留。

- [ ] **Step 5: 运行组件测试并确认行为转绿**

Run: `cd desktop && npm test -- renderer/components/task/MediaTaskBanner.test.tsx`

Expected: PASS，原有任务动作测试与新增媒体测试全部通过。

- [ ] **Step 6: 扩展令牌并重写横幅视觉层**

在 `design-system/tokens.css` 中把横幅材质调整为：

```css
--material-task-glass-width: 58%;
--material-task-glass-blur: 40px;
--material-task-glass-saturate: 1.2;
--material-task-glass-tint-dark: rgba(15, 17, 20, 0.34);
--material-task-glass-tint-medium: rgba(15, 17, 20, 0.42);
--material-task-glass-tint-light: rgba(15, 17, 20, 0.5);
--material-task-glass-tint-weak-dark: rgba(15, 17, 20, 0.38);
--material-task-glass-tint-weak-medium: rgba(15, 17, 20, 0.46);
--material-task-glass-tint-weak-light: rgba(15, 17, 20, 0.54);
--material-task-glass-lift: rgba(255, 255, 255, 0.025);
--material-task-glass-feather: 108px;
--material-task-ambient-weak-blur: 22px;
--material-task-ambient-weak-brightness: 0.62;
--material-task-ambient-weak-saturate: 0.88;
--material-task-ambient-weak-scale: 1.08;
--material-task-focus-width: 48%;
--material-task-focus-feather: 88px;
```

把新增令牌加入 `tokenContract.test.ts` 的 `requiredTokens`，保持现有令牌单一来源契约。

在 `media-task-banner.css` 中移除与已删除内联常量竞争的 `!important`，但不扩大范围重构 `TaskActionsMenu` 自身仍依赖的遗留内联样式。媒体层关键规则为：

```css
.media-task-banner__artwork,
.media-task-banner__artwork-ambient,
.media-task-banner__shade {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.media-task-banner__artwork-ambient,
.media-task-banner__artwork-focus {
  display: block;
  object-fit: cover;
}

.media-task-banner[data-media-quality="weak"] .media-task-banner__artwork-ambient {
  filter: blur(var(--material-task-ambient-weak-blur))
    brightness(var(--material-task-ambient-weak-brightness))
    saturate(var(--material-task-ambient-weak-saturate));
  transform: scale(var(--material-task-ambient-weak-scale));
}

.media-task-banner__artwork-focus {
  position: absolute;
  inset: 0 0 0 auto;
  width: var(--material-task-focus-width);
  height: 100%;
  object-position: center;
  mask-image: linear-gradient(
    90deg,
    transparent 0,
    #000 var(--material-task-focus-feather),
    #000 100%
  );
  -webkit-mask-image: linear-gradient(
    90deg,
    transparent 0,
    #000 var(--material-task-focus-feather),
    #000 100%
  );
}

.media-task-banner[data-artwork-shape="portrait"] .media-task-banner__artwork-focus,
.media-task-banner[data-artwork-shape="unknown"] .media-task-banner__artwork-focus {
  object-fit: contain;
  object-position: right center;
}
```

`data-artwork-tone` 先选择标准染色，`data-media-quality="weak"` 再覆盖到对应 weak 令牌。Reading Glass 继续只保留一个大面积 `backdrop-filter`，保持左侧 `58%` 和 `108px` 羽化；内容宽度约束为 `min(72%, calc(100% - 112px))`，避免标题越过玻璃进入右侧按钮。

- [ ] **Step 7: 删除画廊手工亮度并更新系统规范**

在 `DesktopCoreGallery.tsx` 删除 `ArtworkTone` import、`GALLERY_TONES` 和所有 `artworkTone={...}`。画廊测试改为验证 8 个有 URL 的初始横幅使用 `weak`，无 URL 横幅使用 `missing`，并继续验证本地媒体资源、深浅主题和减少透明控制。

在 `docs/UI-DESIGN-LANGUAGE.md` 的亮度自适应段落写明：亮度来自 `16 × 16` Canvas 自动采样；远程图片因 CORS 无法读取或采样失败时回退为 `light`，不再回退 `medium`。

- [ ] **Step 8: 运行横幅、画廊和令牌测试**

Run: `cd desktop && npm test -- renderer/components/task/artworkPresentation.test.ts renderer/components/task/MediaTaskBanner.test.tsx renderer/components/design-system/DesktopCoreGallery.test.tsx renderer/styles/tokenContract.test.ts`

Expected: PASS；媒体分类、生产组件、画廊和令牌契约全部通过，除既有 Vite CJS deprecation 外无新增警告。

- [ ] **Step 9: 运行 TypeScript 与生产构建**

Run: `cd desktop && npm run build`

Expected: TypeScript 检查和 Renderer/Main/Preload Vite 构建全部成功。

- [ ] **Step 10: 提交横幅集成**

```bash
git add design-system/tokens.css docs/UI-DESIGN-LANGUAGE.md desktop/renderer/components/task/MediaTaskBanner.tsx desktop/renderer/components/task/MediaTaskBanner.test.tsx desktop/renderer/styles/media-task-banner.css desktop/renderer/styles/tokenContract.test.ts desktop/renderer/components/design-system/DesktopCoreGallery.tsx desktop/renderer/components/design-system/DesktopCoreGallery.test.tsx
git commit -m "feat(ui): 让任务横幅适配真实缩略图"
```

### Task 3: 恢复深色默认值并消除输入框双层外观

**Files:**
- Modify: `src/data/json_config.py`
- Modify: `tests/data/test_json_config.py`
- Modify: `desktop/renderer/styles/ui.css`
- Modify: `desktop/renderer/components/ui/uiPrimitives.test.tsx`

**Interfaces:**
- Preserves: `theme_mode` 的公开值仍是 `light | dark | system`。
- Changes: 新 `JsonConfig` 的默认 `theme_mode` 从 `system` 改为 `dark`。
- Preserves: 既有配置文件中显式保存的三种值不会被迁移或覆盖。
- Changes: `.ui-text-field` 是唯一可见输入外壳，内部原生 `<input>` 不再绘制平台 appearance、边框、圆角或阴影。

- [ ] **Step 1: 先写会失败的主题默认测试**

```py
def test_new_config_defaults_to_dark(tmp_path):
    cfg = JsonConfig(str(tmp_path / "config.json"))
    assert cfg.get_theme_mode() == "dark"


def test_saved_theme_modes_are_preserved(tmp_path):
    for mode in ("light", "dark", "system"):
        path = tmp_path / mode / "config.json"
        path.parent.mkdir()
        path.write_text(f'{{"theme_mode": "{mode}"}}', encoding="utf-8")
        assert JsonConfig(str(path)).get_theme_mode() == mode
```

- [ ] **Step 2: 运行主题测试并确认默认值失败**

Run: `pytest tests/data/test_json_config.py::test_new_config_defaults_to_dark tests/data/test_json_config.py::test_saved_theme_modes_are_preserved -q`

Expected: 第一个用例 FAIL，实际值为 `system`；三种既有值保留用例 PASS。

- [ ] **Step 3: 把新配置默认主题改为深色**

在 `JsonConfig._defaults()` 中只修改：

```py
"theme_mode": "dark",
```

不得删除 `system` 选项，不得迁移既有配置，不得改变 `set_theme_mode` 的公开输入集合。

- [ ] **Step 4: 运行完整 JsonConfig 测试**

Run: `pytest tests/data/test_json_config.py -q`

Expected: 全部 PASS。

- [ ] **Step 5: 先写会失败的单层输入外观测试**

在 `uiPrimitives.test.tsx` 引入 `../../styles.css`，并加入：

```tsx
it("uses the TextField shell as the only visible input chrome", () => {
  render(<TextField aria-label="视频链接" leadingIcon="link" />);
  const input = screen.getByRole("textbox", { name: "视频链接" });
  const shell = input.closest(".ui-text-field");

  expect(shell).not.toBeNull();
  expect(shell?.querySelectorAll("input")).toHaveLength(1);
  expect(getComputedStyle(input).appearance).toBe("none");
  expect(getComputedStyle(input).borderTopWidth).toBe("0px");
  expect(getComputedStyle(input).boxShadow).toBe("none");
});
```

- [ ] **Step 6: 运行 UI primitive 测试并确认 appearance 断言失败**

Run: `cd desktop && npm test -- renderer/components/ui/uiPrimitives.test.tsx`

Expected: FAIL，`appearance` 尚未为 `none`。

- [ ] **Step 7: 关闭内部原生 input 绘制**

在 `.ui-text-field input` 中加入并保留现有焦点由外层 `:focus-within` 负责：

```css
appearance: none;
-webkit-appearance: none;
border-radius: 0;
box-shadow: none;
font: inherit;
```

- [ ] **Step 8: 运行相关测试与构建**

Run: `cd desktop && npm test -- renderer/components/ui/uiPrimitives.test.tsx renderer/components/shell/ActionBar.test.tsx`

Expected: PASS，键盘焦点环、链接提交、网页识别与设置入口保持不变。

Run: `cd desktop && npm run build`

Expected: TypeScript 与 Vite 构建全部成功。

- [ ] **Step 9: 提交主题与输入外观修复**

```bash
git add src/data/json_config.py tests/data/test_json_config.py desktop/renderer/styles/ui.css desktop/renderer/components/ui/uiPrimitives.test.tsx
git commit -m "fix(ui): 恢复深色默认与单层输入外观"
```

## Final Verification

- [ ] Run: `cd desktop && npm test`

Expected: 全部 Renderer/Electron Vitest 测试通过；记录既有 Vite CJS deprecation，不接受新增 warning 或 error。

- [ ] Run: `pytest tests/core tests/data tests/sidecar -q`

Expected: 全部 Python 核心、数据与 Sidecar 测试通过。

- [ ] Run: `node browser-extension/shared.test.js`

Expected: 浏览器扩展共享测试通过。

- [ ] Run: `cd desktop && npm run build`

Expected: Renderer、Electron Main、Preload 构建通过。

- [ ] 使用 `DOWNANY_PYTHON=/Users/jacklee/work/personal/trae/downloader/venv/bin/python ./scripts/start_app.sh` 启动当前工作树的真实 Electron；确认进程路径来自 `.worktrees/design-system-desktop-core`，Vite 返回 HTTP 200，Sidecar 和扩展桥正常。

- [ ] 使用现有 3 个真实任务验证：四合院竖图进入 `weak + portrait`，右侧不再出现巨型黄色像素；火山方舟横图保持媒体辨识度；亮色网页图自动使用 `light` Reading Glass，标题不再白字压白底。

- [ ] 验证深色主题为目标基准；切换到浅色主题时窗口变浅但媒体横幅仍为深色阅读表面。

- [ ] 在 `760px` 窗口宽度验证标题省略、打开/更多操作可用、无水平滚动。

- [ ] 启用减少透明，确认 Reading Glass 退化为同宽深色渐变，信息与操作完整。

- [ ] 验证顶部链接输入框只有一个可见轮廓，键盘聚焦仍有 2px 焦点环。

- [ ] 截图必须来自真实 Electron，不使用开发画廊代替；对照 `docs/assets/downany-main-window-glass-v1.png` 检查注意力顺序、玻璃局部性、媒体清晰焦点与控件紧凑度。
