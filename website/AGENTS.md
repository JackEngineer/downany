# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## 官网维护约定

- 本轮 v0.3.2 官网更新沿用已确认的深色视觉与页面布局，同步产品内容、下载与安装说明。
- 产品主图使用隔离运行的实际应用截图，检查个人信息并在 `ASSETS.md` 记录来源与版本。工程候选的截图只证明对应界面，不能当作公开安装包的安装验收。
- 下载信息区分实时查询和已核验备用版本；备用版本显示“可下载版本”，不能称为最新正式版。
- 更新现有 Cloudflare Pages 官网时保留项目与域名，部署前核对当前生产部署并记录回滚点。
