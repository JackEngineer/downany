import { useEffect, useRef, useState } from "react";

import { getLocale, t, type Locale } from "../../i18n";
import { request, openExtractWindow } from "../../lib/api";
import { submitAddText } from "../../lib/addFlow";
import type { AppSnapshot } from "../../lib/types";
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [locale, setLocaleState] = useState<Locale>(() => getLocale());
  const addRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const disabled = connection !== "connected";

  useEffect(() => {
    const updateLocale = () => setLocaleState(getLocale());
    window.addEventListener("downany:locale", updateLocale);
    return () => window.removeEventListener("downany:locale", updateLocale);
  }, []);

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

  const batch = async (method: string, successTitle: string) => {
    if (menuRef.current) menuRef.current.open = false;
    try {
      await request(method, {});
      const snapshot = await request<AppSnapshot>("app.getSnapshot");
      useAppStore.getState().hydrateSnapshot(snapshot);
      pushToast({ kind: "success", title: successTitle });
    } catch (error) {
      pushToast({ kind: "error", title: "操作失败", detail: String(error) });
    }
  };

  const openExtract = async () => {
    const candidate = text.trim();
    if (!candidate) {
      pushToast({ kind: "info", title: "请先输入要识别的页面链接" });
      addRef.current?.focus();
      return;
    }
    try {
      await openExtractWindow(candidate);
    } catch (error) {
      pushToast({
        kind: "error",
        title: "无法打开网页识别",
        detail: String(error),
      });
    }
  };

  return (
    <section className="action-bar" aria-label="下载操作">
      <TextField
        ref={addRef}
        leadingIcon="link"
        aria-label="添加下载链接"
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
            disabled={disabled}
            onClick={() => void batch("download.pauseAll", "已全部暂停")}
          >
            全部暂停
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={() => void batch("download.resumeAll", "已全部恢复")}
          >
            全部恢复
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={() => void batch("download.clearFinished", "已清除完成项")}
          >
            清除已完成
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
