export const siteLinks = {
  repository: "https://github.com/JackEngineer/downany",
  releases: "https://github.com/JackEngineer/downany/releases",
  releaseGuide: "https://github.com/JackEngineer/downany/blob/main/docs/RELEASE.md",
  extension: "https://github.com/JackEngineer/downany/tree/main/browser-extension",
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
    description: "粘贴链接即可下载，也能识别登录后播放的网页媒体。支持 macOS 与 Windows。",
  },
  workflow: {
    title: "你只需要三步",
    steps: [
      { title: "复制链接", description: "复制任意网页视频链接" },
      { title: "加入下载", description: "粘贴链接到 Downany" },
      { title: "打开文件", description: "下载完成，立即查看" },
    ],
  },
  recognition: {
    title: "复杂网页，也有办法",
    description: "登录后播放、动态加载或分段传输的网页媒体，Downany 会帮你识别并加入下载。",
    action: "了解网页识别",
  },
  capabilities: {
    title: "下载之外，流程也替你收好",
    items: [
      {
        id: "web-recognition",
        title: "网页识别",
        description: "识别当前页面正在播放的媒体，登录后的内容也不在话下。",
        href: "#recognition",
      },
      {
        id: "batch-queue",
        title: "批量队列",
        description: "一次加入多个任务，自动按顺序下载。",
        href: siteLinks.readme,
      },
      {
        id: "resume",
        title: "暂停与续传",
        description: "网络恢复后可以继续，不必从头开始。",
        href: siteLinks.readme,
      },
      {
        id: "history",
        title: "下载记录",
        description: "保留下载结果，完成内容可以快速打开。",
        href: siteLinks.readme,
      },
      {
        id: "browser-extension",
        title: "Chrome 扩展",
        description: "在网页上发现视频，直接送到 Downany。",
        href: siteLinks.extension,
      },
      {
        id: "telegram",
        title: "Telegram 自动转发",
        description: "下载完成后，可自动发送到已绑定的聊天、群组或频道。",
        href: siteLinks.telegram,
      },
    ],
  },
  download: {
    title: "下载 Downany",
    description: "首次打开时，系统可能会显示安全提示。我们准备了清晰的安装说明。",
    installHelp: "查看安装说明",
  },
  faq: {
    title: "常见问题",
    items: [
      {
        question: "Downany 支持哪些网站？",
        answer:
          "支持 YouTube、Bilibili、抖音、TikTok、Twitter、Instagram 等常见平台。部分页面需要有效登录状态。",
      },
      {
        question: "下载的视频存放在哪里？",
        answer: "默认保存在系统下载目录，也可以在设置中修改。下载完成后可从任务直接打开。",
      },
      {
        question: "遇到无法识别的视频怎么办？",
        answer: "先播放目标视频，再使用网页识别。部分站点需要导入浏览器登录状态后重试。",
      },
    ],
  },
} as const;
