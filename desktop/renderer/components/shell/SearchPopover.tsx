import { useEffect, useRef, type RefObject } from "react";

import { t, type Locale } from "../../i18n";
import type { SearchMode } from "../../lib/types";
import { Button, IconButton } from "../ui/Button";
import { TextField } from "../ui/TextField";

const SEARCH_MODES: Array<{ key: SearchMode; labelKey: string }> = [
  { key: "filter", labelKey: "search.filter" },
  { key: "network", labelKey: "search.network" },
];

interface SearchPopoverProps {
  open: boolean;
  mode: SearchMode;
  query: string;
  locale: Locale;
  inputRef: RefObject<HTMLInputElement>;
  onModeChange: (mode: SearchMode) => void;
  onQueryChange: (query: string) => void;
  onClose: () => void;
}

export function SearchPopover(props: SearchPopoverProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (props.open) queueMicrotask(() => props.inputRef.current?.focus());
  }, [props.inputRef, props.open]);

  useEffect(() => {
    if (!props.open) return;

    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      const target = event.target;
      if (!root || !(target instanceof Node)) return;
      if (root.contains(target)) return;
      props.onClose();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [props.onClose, props.open]);

  if (!props.open) return null;

  return (
    <div
      ref={rootRef}
      className="search-popover"
      role="dialog"
      aria-label={t("search.dialog", props.locale)}
      onBlur={(event) => {
        const root = rootRef.current;
        const nextTarget = event.relatedTarget;
        if (!root) return;
        if (nextTarget instanceof Node && root.contains(nextTarget)) return;
        props.onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          props.onClose();
        }
      }}
    >
      <div
        className="search-popover__modes"
        role="group"
        aria-label={t("search.modes.label", props.locale)}
      >
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
      {props.mode === "filter" ? (
        <TextField
          ref={props.inputRef}
          leadingIcon="search"
          type="search"
          aria-label={t("search.input.label", props.locale)}
          placeholder={t("search.placeholder", props.locale)}
          value={props.query}
          onChange={(event) => props.onQueryChange(event.target.value)}
        />
      ) : null}
      <IconButton
        icon="close"
        label={t("search.close", props.locale)}
        onClick={props.onClose}
      />
    </div>
  );
}
