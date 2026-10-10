export const siteLinks = {
  repository: "https://github.com/JackEngineer/downany",
  releases: "https://github.com/JackEngineer/downany/releases",
  releaseGuide: "https://github.com/JackEngineer/downany#安装与首次使用",
  extension: "https://github.com/JackEngineer/downany/tree/main/browser-extension",
  recognition: "https://github.com/JackEngineer/downany#功能",
  telegram: "https://github.com/JackEngineer/downany/blob/main/docs/TELEGRAM.md",
  readme: "https://github.com/JackEngineer/downany#readme",
} as const;

export const siteContent = {
  brand: "Downany · 百纳",
  navigation: [
    { label: "功能", href: "#features" },
    { label: "使用方法", href: "#how-it-works" },
    { label: "浏览器扩展", href: "#browser-extension" },
    { label: "常见问题", href: "#faq" },
  ],
  hero: {
    title: "把网页里的视频，稳稳收进本地。",
    description: "粘贴视频链接，选择画质、字幕与合集条目。支持 Apple Silicon Mac 与 Windows x64。",
  },
  workflow: {
    title: "你只需要三步",
    steps: [
      { title: "复制链接", description: "复制你有权下载的视频链接" },
      { title: "加入下载", description: "选择画质、字幕与合集条目" },
      { title: "打开文件", description: "下载完成后，打开文件或所在目录" },
    ],
  },
  recognition: {
    title: "复杂网页，也有办法",
    description: "在桌面端打开网页并播放，再检测可下载媒体。内容取决于识别结果和访问权限，网页可播放不保证能够下载。",
    action: "了解网页识别",
  },
  capabilities: {
    title: "下载之外，流程也替你收好",
    items: [
      {
        id: "web-recognition",
        title: "网页识别",
        description: "打开网页并播放，检测媒体后选择下载；部分内容需要有效登录状态。",
        href: "#recognition",
      },
      {
        id: "batch-queue",
        title: "批量与合集选集",
        description: "一次加入多条链接，按需选择合集视频、画质和字幕。",
        href: siteLinks.readme,
      },
      {
        id: "resume",
        title: "暂停与续传",
        description: "暂停后可继续；失败可重试，保留原画质与输出选择。",
        href: siteLinks.readme,
      },
      {
        id: "history",
        title: "下载记录",
        description: "快速查找并打开已下载内容，重启后保留任务与记录的排序偏好。",
        href: siteLinks.readme,
      },
      {
        id: "browser-extension",
        title: "Chrome 扩展",
        description: "检测正在播放的媒体或解析网页，把选中内容发送到 Downany。",
        href: siteLinks.extension,
      },
      {
        id: "telegram",
        title: "Telegram 自动转发",
        description: "下载完成后发送到已绑定的聊天；云端单文件上限 50 MB，较大视频可分段发送。",
        href: siteLinks.telegram,
      },
    ],
  },
  download: {
    title: "下载 Downany",
    description: "适用于 Apple Silicon Mac 与 Windows x64。首次安装或打开时，系统可能显示安全提示，请先核对官方下载来源。",
    installHelp: "查看安装说明",
  },
  faq: {
    title: "常见问题",
    items: [
      {
        question: "Downany 支持哪些网站？",
        answer:
          "支持识别 YouTube、Bilibili、抖音、TikTok、Twitter、Instagram 等常见平台的视频。可下载内容取决于实际识别结果和访问权限；部分页面需要有效登录状态，网页可播放不保证能够下载。",
      },
      {
        question: "下载的视频存放在哪里？",
        answer: "默认保存在用户目录下的 Downloads/Downany 文件夹，也可以在设置中修改。下载完成后可从任务打开文件或所在目录。",
      },
      {
        question: "遇到无法识别的视频怎么办？",
        answer: "可以在桌面端的网页识别窗口打开页面，播放目标视频后检测媒体。需要登录的内容，可在桌面设置中选择浏览器登录状态来源后重试。Chrome 扩展不读取浏览器 Cookie；能否下载仍取决于识别结果和访问权限。",
      },
      {
        question: "安装时为什么会出现系统安全提示？",
        answer: "当前 Windows 安装包未签名，Mac 应用未使用 Developer ID 签名或公证。先核对官方 GitHub Release 下载来源；Windows SmartScreen 可选择“更多信息”→“仍要运行”，Mac 可右键应用选择“打开”。具体操作请查看安装说明。",
      },
      {
        question: "怎样安装和使用 Chrome 扩展？",
        answer: "下载扩展 ZIP 并解压，在 chrome://extensions 开启开发者模式，选择“加载已解压的扩展程序”并选中解压目录。使用前先启动 Downany 桌面端，再打开视频页面并播放；在扩展中选择“下载检测媒体”或“解析本页视频”。首次提示本地网络访问权限时，需允许扩展连接桌面端。",
      },
      {
        question: "Telegram 自动转发有文件大小限制吗？",
        answer: "当前正式版使用 Telegram 云端发送，单文件上限为 50 MB。较大视频可切成能够独立播放的分段发送；其他超过上限的文件无法发送。先在设置中绑定 Bot、选择聊天并发送测试消息，再开启自动发送。当前安装包不支持本地发送的单文件 2 GB 能力。",
      },
    ],
  },
} as const;
