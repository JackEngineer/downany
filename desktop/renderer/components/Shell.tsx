import { useEffect } from "react";

import { submitAddText } from "../lib/addFlow";
import { useAppStore } from "../store/appStore";
import { AddConfirmDialog } from "./AddConfirmDialog";
import { ConnectionGate } from "./ConnectionGate";
import { HistorySection } from "./HistorySection";
import { TaskList } from "./TaskList";
import { ToastHost } from "./ToastHost";
import { TopBar } from "./TopBar";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest("input, textarea, select, [contenteditable='true']"),
  );
}

export function Shell() {
  const connection = useAppStore((s) => s.connection);
  const filter = useAppStore((s) => s.filter);
  const settings = useAppStore((s) => s.settings);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key === ",") {
        e.preventDefault();
        void window.api.openSettings();
      } else if ((e.key === "v" || e.key === "V") && !isEditableTarget(e.target)) {
        e.preventDefault();
        void window.api.readClipboardText().then((text) => {
          if (text) void submitAddText(text);
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const text =
        e.dataTransfer?.getData("text/uri-list") ||
        e.dataTransfer?.getData("text/plain") ||
        "";
      if (text) void submitAddText(text);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  useEffect(() => {
    return window.api.onNavigate((next) => {
      const store = useAppStore.getState();
      if (next === "new") {
        store.setFilter("all");
        store.requestAddFocus();
      } else if (next === "queue") {
        store.setFilter("active");
      } else if (next === "history") {
        store.setFilter("history");
      } else if (next === "settings") {
        void window.api.openSettings();
      }
    });
  }, []);

  useEffect(() => {
    return window.api.onHighlightTask((taskId) => {
      useAppStore.getState().setFilter("all");
      window.setTimeout(() => {
        const el = document.getElementById(`task-${taskId}`);
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("card-flash");
        window.setTimeout(() => el.classList.remove("card-flash"), 1800);
      }, 60);
    });
  }, []);

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

  useEffect(() => {
    const themeMode = settings?.theme_mode || "system";
    void window.api.setThemeSource(themeMode);
    if (themeMode !== "system") {
      document.documentElement.setAttribute("data-theme", themeMode);
    }
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
    <div className="window-shell">
      <TopBar />
      <main className="window-main" id="main">
        {filter === "history" ? <HistorySection /> : <TaskList />}
      </main>
      <AddConfirmDialog />
      <ToastHost />
    </div>
  );
}
