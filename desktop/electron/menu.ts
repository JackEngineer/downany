/** 应用菜单与导航。 */
import { Menu, BrowserWindow, app } from "electron";

export type AppRoute = "new" | "queue" | "history" | "settings";

export function buildAppMenu(
  getWindow: () => BrowserWindow | null,
  openSettings: () => void,
): Menu {
  const sendNavigate = (route: AppRoute) => {
    const win = getWindow();
    win?.webContents.send("app:navigate", route);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name || "视频下载器",
      submenu: [
        { role: "about", label: "关于 视频下载器" },
        { type: "separator" },
        {
          label: "设置…",
          accelerator: "CmdOrCtrl+,",
          click: () => openSettings(),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide", label: "隐藏 视频下载器" },
        { role: "hideOthers", label: "隐藏其他" },
        { role: "unhide", label: "全部显示" },
        { type: "separator" },
        { role: "quit", label: "退出 视频下载器" },
      ],
    },
    {
      label: "文件",
      submenu: [
        {
          label: "新建任务",
          accelerator: "CmdOrCtrl+N",
          click: () => sendNavigate("new"),
        },
        { type: "separator" },
        {
          label: "下载队列",
          accelerator: "CmdOrCtrl+1",
          click: () => sendNavigate("queue"),
        },
        {
          label: "历史记录",
          accelerator: "CmdOrCtrl+2",
          click: () => sendNavigate("history"),
        },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "缩放" },
        { type: "separator" },
        { role: "front", label: "前置全部窗口" },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}
