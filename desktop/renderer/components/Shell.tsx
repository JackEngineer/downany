import { useEffect, useState } from "react";

import { useAppStore } from "../store/appStore";
import { ConnectionGate } from "./ConnectionGate";
import { Sidebar } from "./Sidebar";
import { ToastHost } from "./ToastHost";
import { NewTaskPage } from "../pages/NewTaskPage";
import { QueuePage } from "../pages/QueuePage";
import { HistoryPage } from "../pages/HistoryPage";
import { SettingsPage } from "../pages/SettingsPage";

function useCompact(breakpoint = 960): boolean {
  const [compact, setCompact] = useState(
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false,
  );
  useEffect(() => {
    const onResize = () => setCompact(window.innerWidth < breakpoint);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint]);
  return compact;
}

export function Shell() {
  const connection = useAppStore((s) => s.connection);
  const route = useAppStore((s) => s.route);
  const setRoute = useAppStore((s) => s.setRoute);
  const settings = useAppStore((s) => s.settings);
  const compact = useCompact();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key === "n") {
        e.preventDefault();
        setRoute("new");
      } else if (e.key === ",") {
        e.preventDefault();
        setRoute("settings");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setRoute]);

  useEffect(() => {
    return window.api.onNavigate((next) => setRoute(next));
  }, [setRoute]);

  useEffect(() => {
    const pushToast = useAppStore.getState().pushToast;
    return window.api.onExternalEnqueue((payload) => {
      if (payload.error) {
        pushToast({
          kind: "error",
          title: "外部入队失败",
          detail: payload.error,
        });
        return;
      }
      const n = payload.count;
      pushToast({
        kind: "success",
        title: n === 1 ? "已从浏览器加入 1 个任务" : `已从浏览器加入 ${n} 个任务`,
      });
      void window.api.request("app.getSnapshot").then((snap) => {
        useAppStore.getState().hydrateSnapshot(snap as never);
      });
    });
  }, []);

  useEffect(() => {
    const applySystem = async (mode?: "light" | "dark") => {
      const themeMode = useAppStore.getState().settings?.theme_mode || "system";
      if (themeMode !== "system") return;
      const resolved = mode || (await window.api.getNativeTheme());
      document.documentElement.setAttribute("data-theme", resolved);
    };
    void applySystem();
    return window.api.onNativeTheme((mode) => {
      void applySystem(mode);
    });
  }, [settings?.theme_mode]);

  if (connection === "failed") {
    return (
      <>
        <ConnectionGate />
        <ToastHost />
      </>
    );
  }

  return (
    <div className={`shell ${compact ? "shell-compact" : ""}`}>
      <Sidebar compact={compact} />
      <main className="main" id="main">
        {route === "new" && <NewTaskPage />}
        {route === "queue" && <QueuePage />}
        {route === "history" && <HistoryPage />}
        {route === "settings" && <SettingsPage />}
      </main>
      <ToastHost />
    </div>
  );
}
