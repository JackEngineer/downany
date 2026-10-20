# Downany · 百纳品牌资源

保留“播放三角形 + 下载箭头 + 托盘”的产品识别，统一到已落地桌面界面的珊瑚橙与暖炭灰。图形为手工矢量，不使用图片生成或付费服务。

## 主稿与派生

- `logo-mark.svg`：唯一图形主稿；64单位网格、透明底、无文字、无滤镜。窗口内、文档与本地官网使用。
- `app-icon.svg`：同轮廓配暖炭灰圆角底与透明外边距，用于Dock/应用图标。
- `logo-lockup.svg`：同轮廓配Downany及百纳名称，透明底，浅色背景使用。
- `tray-template.svg`：同轮廓纯黑透明模板，由macOS随菜单栏主题自动着色；不要画第二套箭头。
- `browser-extension/icons/icon-small.svg`：16像素工具栏专用紧凑底板，同一轮廓。

## 颜色

- 珊瑚橙 `#ed7051`：与桌面浅色主题accent一致；深色界面仍使用同色产品标识，任务控件继续遵循自己的主题token。
- 暖炭灰 `#252825`：应用图标底，与桌面深色标题栏一致。
- 正文 `#252825`、辅助文字 `#747773`。

标识不新增阴影、渐变或装饰。16/18/24/32/48/64像素均验收，单色模板在深浅菜单栏独立检查。行为图标继续使用Icon组件，不把品牌图形当成每个“下载”按钮的图标。

## 离线重建

`scripts/render_brand_assets.cjs`从主稿生成SVG派生、1024 PNG、多尺寸ICO、扩展PNG、菜单栏1x/2xPNG及可选iconset。使用已有Playwright/Chromium；可设DOWNANY_PLAYWRIGHT_MODULE、DOWNANY_CHROMIUM指定本机依赖，不在线安装。DOWNANY_ICONSET指定临时`.iconset`目录，然后用macOS `iconutil -c icns <目录> -o desktop/build/icon.icns`生成打包ICNS。Vite将菜单栏PNG复制到dist-electron，electron-builder将该目录与ICNS装入app；未改Windows安装逻辑或发布流程。
