import { useEffect } from "react";

import { t } from "../i18n";

import { refreshQueueAfterChange } from "../lib/refreshQueue";
import { useDocumentTheme } from "../lib/documentTheme";
import { useAppStore } from "../store/appStore";

import { ConnectionGate } from "./ConnectionGate";
import { TaskWorkbench } from "./TaskWorkbench";
import { ToastHost } from "./ToastHost";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest("input, textarea, select, [contenteditable='true']"),
  );
}

export function Shell() {
  const connection = useAppStore((s) => s.connection);
  const settings = useAppStore((s) => s.settings);

  useDocumentTheme(settings?.theme_mode);

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
          if (text) useAppStore.getState().setPendingAddUrls([text]);
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
      if (text) useAppStore.getState().setPendingAddUrls([text]);
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
        store.setSearchMode("filter");
        store.setFilter("all");
        store.requestAddFocus();
      } else if (next === "queue") {
        store.setSearchMode("filter");
        store.setFilter("active");
      } else if (next === "history") {
        store.setSearchMode("filter");
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
        el.classList.add("media-task-banner--flash");
        window.setTimeout(() => el.classList.remove("media-task-banner--flash"), 1800);
      }, 60);
    });
  }, []);

  useEffect(() => {
    const pushToast = useAppStore.getState().pushToast;
    return window.api.onExternalEnqueue((payload) => {
      if (payload.error) {
        pushToast({
          kind: "error",
          title: t("add.browserFailed"),
          detail: t("add.browserRetry"),
        });
        return;
      }
      const n = payload.count;
      pushToast({
        kind: "success",
        title: t("add.browserSuccess", undefined, { count: n }),
      });
      void refreshQueueAfterChange();
    });
  }, []);

  if (connection === "failed") {
    return (
      <>
        <ConnectionGate />
        <ToastHost />
      </>
    );
  }

  return (
    <div className="window-shell" data-platform={window.api.platform}>
      <TaskWorkbench />
      <ToastHost />
    </div>
  );
}
