import { activeTaskCount, useAppStore } from "../store/appStore";
import type { AppRoute } from "../lib/types";

const ITEMS: { route: AppRoute; label: string; icon: string }[] = [
  { route: "new", label: "新建任务", icon: "＋" },
  { route: "queue", label: "下载队列", icon: "↓" },
  { route: "history", label: "历史记录", icon: "☰" },
];

interface SidebarProps {
  compact: boolean;
}

export function Sidebar({ compact }: SidebarProps) {
  const route = useAppStore((s) => s.route);
  const setRoute = useAppStore((s) => s.setRoute);
  const tasks = useAppStore((s) => s.tasks);
  const active = activeTaskCount(tasks);

  return (
    <nav className={`sidebar ${compact ? "sidebar-compact" : ""}`} aria-label="主导航">
      <div className="sidebar-brand">{compact ? "下" : "视频下载器"}</div>
      <ul className="sidebar-nav">
        {ITEMS.map((item) => (
          <li key={item.route}>
            <button
              type="button"
              className={route === item.route ? "nav-item active" : "nav-item"}
              onClick={() => setRoute(item.route)}
              aria-current={route === item.route ? "page" : undefined}
              title={item.label}
            >
              <span className="nav-icon" aria-hidden>
                {item.icon}
              </span>
              {!compact && <span>{item.label}</span>}
              {item.route === "queue" && active > 0 && (
                <span className="nav-badge">{active}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
      <div className="sidebar-footer">
        <button
          type="button"
          className={route === "settings" ? "nav-item active" : "nav-item"}
          onClick={() => setRoute("settings")}
          aria-current={route === "settings" ? "page" : undefined}
          title="设置"
        >
          <span className="nav-icon" aria-hidden>
            ⚙
          </span>
          {!compact && <span>设置</span>}
        </button>
      </div>
    </nav>
  );
}
