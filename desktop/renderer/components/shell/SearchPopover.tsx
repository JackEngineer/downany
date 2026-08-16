import { useEffect, type RefObject } from "react";

import { t, type Locale } from "../../i18n";
import type { SearchMode } from "../../lib/types";
import { Button, IconButton } from "../ui/Button";
import { TextField } from "../ui/TextField";

const SEARCH_MODES: Array<{ key: SearchMode; labelKey: string }> = [
  { key: "filter", labelKey: "search.filter" },
  { key: "network", labelKey: "search.network" },
];

const SEARCH_PLATFORMS = [
  { key: "youtube", label: "YouTube" },
  { key: "bilibili", label: "Bilibili" },
  { key: "pornhub", label: "Pornhub" },
] as const;

interface SearchPopoverProps {
  open: boolean;
  mode: SearchMode;
  query: string;
  platform: string;
  locale: Locale;
  inputRef: RefObject<HTMLInputElement>;
  onModeChange: (mode: SearchMode) => void;
  onQueryChange: (query: string) => void;
  onPlatformChange: (platform: string) => void;
  onSubmitNetwork: () => void;
  onClose: () => void;
}

export function SearchPopover(props: SearchPopoverProps) {
  useEffect(() => {
    if (props.open) queueMicrotask(() => props.inputRef.current?.focus());
  }, [props.inputRef, props.open]);

  if (!props.open) return null;

  return (
    <div
      className="search-popover"
      role="dialog"
      aria-label="搜索任务"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          props.onClose();
        }
      }}
    >
      <div className="search-popover__modes" role="group" aria-label="搜索模式">
        {SEARCH_MODES.map((mode) => (
          <Button
            key={mode.key}
            size="small"
            variant={props.mode === mode.key ? "primary" : "ghost"}
            aria-pressed={props.mode === mode.key}
            onClick={() => props.onModeChange(mode.key)}
          >
            {t(mode.labelKey, props.locale)}
          </Button>
        ))}
      </div>
      {props.mode === "network" ? (
        <select
          aria-label="搜索平台"
          value={props.platform}
          onChange={(event) => props.onPlatformChange(event.target.value)}
        >
          {SEARCH_PLATFORMS.map((platform) => (
            <option key={platform.key} value={platform.key}>
              {platform.label}
            </option>
          ))}
        </select>
      ) : null}
      <TextField
        ref={props.inputRef}
        leadingIcon="search"
        type="search"
        aria-label="搜索任务"
        placeholder={
          props.mode === "network"
            ? t("search.network.placeholder", props.locale)
            : t("search.placeholder", props.locale)
        }
        value={props.query}
        onChange={(event) => props.onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && props.mode === "network") {
            event.preventDefault();
            props.onSubmitNetwork();
          }
        }}
      />
      <IconButton icon="close" label="关闭搜索" onClick={props.onClose} />
    </div>
  );
}
