import { useEffect, useRef, useState } from "react";

import { t, useLocale } from "../../i18n";
import { request, openExtractWindow } from "../../lib/api";
import { submitAddText } from "../../lib/addFlow";
import { taskActionToast } from "../../lib/taskActionReport";
import { refreshQueueAfterChange } from "../../lib/refreshQueue";
import type { TaskActionReport, ToastItem } from "../../lib/types";
import { useAppStore } from "../../store/appStore";
import { Button, IconButton } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { TextField } from "../ui/TextField";
import { SearchPopover } from "./SearchPopover";

export function ActionBar() {
  const connection = useAppStore((state) => state.connection);
  const searchQuery = useAppStore((state) => state.searchQuery);
  const setSearchQuery = useAppStore((state) => state.setSearchQuery);
  const searchMode = useAppStore((state) => state.searchMode);
  const setSearchMode = useAppStore((state) => state.setSearchMode);
  const addFocusSignal = useAppStore((state) => state.addFocusSignal);
  const pushToast = useAppStore((state) => state.pushToast);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const batchPending = useRef(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const locale = useLocale();
  const addRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const disabled = connection !== "connected";

  useEffect(() => {
    if (addFocusSignal > 0) addRef.current?.focus();
  }, [addFocusSignal]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        addRef.current?.focus();
      } else if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const onToggle = () => {
      if (menu.open) {
        document
          .querySelectorAll<HTMLDetailsElement>(
            "details.action-bar-menu[open]",
          )
          .forEach((other) => {
            if (other !== menu) other.open = false;
          });
        window.dispatchEvent(
          new CustomEvent<string>("downany:task-menu-open", {
            detail: "action-bar",
          }),
        );
      }
    };
    const closeForOtherMenu = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== "action-bar") {
        menu.open = false;
      }
    };
    menu.addEventListener("toggle", onToggle);
    window.addEventListener("downany:task-menu-open", closeForOtherMenu);
    return () => {
      menu.removeEventListener("toggle", onToggle);
      window.removeEventListener("downany:task-menu-open", closeForOtherMenu);
    };
  }, []);

  const addUrls = async (raw: string) => {
    setBusy(true);
    try {
      const urls = await submitAddText(raw);
      if (urls.length > 0) setText("");
    } finally {
      setBusy(false);
    }
  };

  const batch = async (method: "download.pauseAll" | "download.resumeAll" | "download.clearFinished") => {
    if (batchPending.current || disabled) return;
    batchPending.current = true;
    setBatchBusy(true);
    if (menuRef.current) menuRef.current.open = false;
    try {
      let toast: Pick<ToastItem, "kind" | "title">;
      switch (method) {
        case "download.pauseAll":
        case "download.resumeAll":
          toast = taskActionToast(await request<TaskActionReport>(method, {}));
          break;
        case "download.clearFinished":
          await request(method, {});
          toast = { kind: "success", title: t("batch.cleared") };
          break;
        default: {
          const exhaustive: never = method;
          throw new Error(`Unknown batch action: ${exhaustive}`);
        }
      }
      await refreshQueueAfterChange();
      pushToast(toast);
    } catch {
      pushToast({ kind: "error", title: t("error.action"), detail: t("error.retryLater") });
    } finally {
      batchPending.current = false;
      setBatchBusy(false);
    }
  };

  const openExtract = async () => {
    const candidate = text.trim();
    if (!candidate) {
      pushToast({ kind: "info", title: t("add.pageRequired") });
      addRef.current?.focus();
      return;
    }
    try {
      await openExtractWindow(candidate);
    } catch {
      pushToast({
        kind: "error",
        title: t("add.recognizeFailed"),
        detail: t("error.retryLater"),
      });
    }
  };

  return (
    <section className="action-bar" aria-label={t("add.actions", locale)}>
      <TextField
        ref={addRef}
        leadingIcon="link"
        aria-label={t("add.label", locale)}
        placeholder={t("add.placeholder", locale)}
        value={text}
        disabled={disabled || busy}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void addUrls(text);
          }
        }}
      />
      <Button
        variant="primary"
        loading={busy}
        leadingIcon="plus"
        onClick={() => void addUrls(text)}
      >
        {t("action.add", locale)}
      </Button>
      <Button
        className="action-bar__recognize"
        variant="ghost"
        leadingIcon="capture"
        aria-label={t("action.recognize", locale)}
        disabled={disabled}
        onClick={() => void openExtract()}
      >
        <span className="action-bar__recognize-label">
          {t("action.recognize", locale)}
        </span>
      </Button>
      <IconButton
        ref={searchTriggerRef}
        icon="search"
        label={t("action.search", locale)}
        onClick={() => setSearchOpen(true)}
      />
      <details className="action-bar-menu" ref={menuRef}>
        <summary aria-label={t("action.batch", locale)}>
          <Icon name="more" size={16} />
        </summary>
        <div className="action-bar__menu-list" role="menu">
          <button
            type="button"
            role="menuitem"
            disabled={disabled || batchBusy}
            onClick={() => void batch("download.pauseAll")}
          >
            {t("batch.pauseAll", locale)}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={disabled || batchBusy}
            onClick={() => void batch("download.resumeAll")}
          >
            {t("batch.resumeAll", locale)}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={disabled || batchBusy}
            onClick={() => void batch("download.clearFinished")}
          >
            {t("batch.clearFinished", locale)}
          </button>
        </div>
      </details>
      <IconButton
        icon="settings"
        label={t("settings.open", locale)}
        onClick={() => void window.api.openSettings()}
      />
      <SearchPopover
        open={searchOpen}
        mode={searchMode}
        query={searchQuery}
        locale={locale}
        inputRef={searchInputRef}
        onModeChange={(mode) => {
          setSearchMode(mode);
          if (mode === "network") setSearchOpen(false);
        }}
        onQueryChange={setSearchQuery}
        onClose={() => {
          setSearchOpen(false);
          searchTriggerRef.current?.focus();
        }}
      />
    </section>
  );
}
