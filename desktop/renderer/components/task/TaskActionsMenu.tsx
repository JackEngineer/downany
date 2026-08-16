import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { ContextMenuTemplateItem } from "../../../electron/preload";
import type { TaskSnapshot } from "../../lib/types";
import { IconButton } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { toTaskVisualState } from "./taskPresentation";
import type { TaskCommands } from "./useTaskCommands";

const POSTPROCESSING_OPTIONS = [
  { value: "none", label: "无后处理" },
  { value: "mp4", label: "转换为 MP4" },
  { value: "mp3", label: "提取音频 (MP3)" },
  { value: "script", label: "自定义脚本" },
] as const;

interface TaskActionsMenuProps {
  task: TaskSnapshot;
  commands: TaskCommands;
  onRename: () => void;
}

interface VisibleMenuItem {
  id: string;
  label: string;
  enabled: boolean;
  checked: boolean;
  separator: boolean;
}

const menuShellStyle = {
  position: "relative",
  display: "inline-flex",
} as const;

const menuPanelStyle = {
  position: "absolute",
  top: "calc(100% + 8px)",
  right: 0,
  zIndex: 30,
  minWidth: 196,
  padding: 8,
  borderRadius: 18,
  border: "1px solid var(--color-stroke-subtle)",
  background:
    "color-mix(in srgb, var(--color-surface-raised) 82%, rgba(255, 255, 255, 0.18))",
  boxShadow: "0 24px 60px rgba(15, 23, 42, 0.18)",
  backdropFilter: "blur(22px) saturate(1.15)",
} as const;

const menuItemStyle = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  width: "100%",
  padding: "8px 10px",
  border: 0,
  borderRadius: 12,
  background: "transparent",
  color: "var(--color-text-primary)",
  textAlign: "left",
  cursor: "pointer",
} as const;

const menuItemDisabledStyle = {
  opacity: 0.42,
  cursor: "default",
} as const;

const menuSeparatorStyle = {
  height: 1,
  margin: "6px 4px",
  background: "var(--color-stroke-subtle)",
} as const;

export function buildTaskContextTemplate(
  task: TaskSnapshot,
): ContextMenuTemplateItem[] {
  const status = toTaskVisualState(task.status);
  const showDownloadOptions =
    status === "pending" ||
    status === "downloading" ||
    status === "paused" ||
    status === "failed";
  const optionEditable = status !== "downloading";
  const items: ContextMenuTemplateItem[] = [
    { id: "rename", label: "重命名" },
    { id: "extract", label: "网页识别" },
  ];

  if (showDownloadOptions) {
    items.push(
      { id: "separator-download", label: "", type: "separator" },
      {
        id: (task.priority ?? 0) > 0 ? "priority-normal" : "priority-high",
        label: (task.priority ?? 0) > 0 ? "取消高优先级" : "设为高优先级",
      },
      {
        id: "audio-toggle",
        label: task.audio_only ? "取消仅音频" : "仅音频 (MP3)",
        enabled: optionEditable,
      },
      ...POSTPROCESSING_OPTIONS.map((option) => ({
        id: `pp:${option.value}`,
        label: option.label,
        enabled: optionEditable,
      })),
    );
  }
  if (status === "downloading") items.push({ id: "pause", label: "暂停" });
  if (status === "paused") items.push({ id: "resume", label: "继续" });
  if (status === "pending" || status === "downloading" || status === "paused") {
    items.push({ id: "cancel", label: "取消下载" });
  }
  if (status === "failed" || status === "cancelled") {
    items.push({ id: "retry", label: status === "failed" ? "重试" : "重新下载" });
  }
  if (status === "completed" && task.file_path) {
    items.push(
      { id: "open", label: "打开" },
      { id: "reveal", label: "在文件夹中显示" },
    );
  }
  if (status === "completed" || status === "failed" || status === "cancelled") {
    items.push({ id: "remove", label: "移除" });
  }
  return items;
}

export async function dispatchTaskAction(
  actionId: string,
  task: TaskSnapshot,
  commands: TaskCommands,
  startRename: () => void,
): Promise<void> {
  switch (actionId) {
    case "rename":
      startRename();
      return;
    case "extract":
      return commands.recognizePage();
    case "priority-high":
      return commands.update({ priority: 1 });
    case "priority-normal":
      return commands.update({ priority: 0 });
    case "audio-toggle":
      return commands.update({ audio_only: !task.audio_only });
    case "pause":
      return commands.run("download.pause");
    case "resume":
      return commands.run("download.resume");
    case "cancel":
      return commands.run("download.cancel");
    case "retry":
      return commands.run("download.retry");
    case "remove":
      return commands.run("download.remove");
    case "open":
      return commands.open();
    case "reveal":
      return commands.reveal();
    default:
      if (actionId.startsWith("pp:")) {
        return commands.update({ postprocessing: actionId.slice(3) });
      }
      throw new Error(`Unknown task action: ${actionId}`);
  }
}

function toVisibleMenuItems(task: TaskSnapshot): VisibleMenuItem[] {
  const activePostprocessing = task.postprocessing ?? "none";
  return buildTaskContextTemplate(task).map((item) => ({
    id: item.id,
    label: item.label,
    enabled: item.enabled !== false,
    checked: item.id === `pp:${activePostprocessing}`,
    separator: item.type === "separator",
  }));
}

export function TaskActionsMenu({
  task,
  commands,
  onRename,
}: TaskActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pendingFocusRef = useRef<"first" | "last" | null>(null);
  const items = useMemo(() => toVisibleMenuItems(task), [task]);

  const focusMenuItem = (target: "first" | "last") => {
    const focusable = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    ).filter((button) => !button.disabled);
    if (focusable.length === 0) return;
    if (target === "last") {
      focusable.at(-1)?.focus();
      return;
    }
    focusable[0]?.focus();
  };

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) {
      queueMicrotask(() => triggerRef.current?.focus());
    }
  };

  const openMenu = (focusTarget: "first" | "last" | null = null) => {
    pendingFocusRef.current = focusTarget;
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;

    window.dispatchEvent(
      new CustomEvent<string>("downany:task-menu-open", {
        detail: task.id,
      }),
    );

    if (pendingFocusRef.current) {
      queueMicrotask(() => {
        if (pendingFocusRef.current) {
          focusMenuItem(pendingFocusRef.current);
          pendingFocusRef.current = null;
        }
      });
    }

    const closeForOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const closeForEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu(true);
    };
    const closeForOtherMenu = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== task.id) {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeForOutsidePointer);
    document.addEventListener("keydown", closeForEscape);
    window.addEventListener("downany:task-menu-open", closeForOtherMenu);
    return () => {
      document.removeEventListener("pointerdown", closeForOutsidePointer);
      document.removeEventListener("keydown", closeForEscape);
      window.removeEventListener("downany:task-menu-open", closeForOtherMenu);
    };
  }, [open, task.id]);

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openMenu("first");
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openMenu("last");
    }
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const focusable = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    ).filter((button) => !button.disabled);
    if (focusable.length === 0) return;
    const currentIndex = focusable.findIndex((button) => button === document.activeElement);

    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % focusable.length;
        focusable[nextIndex]?.focus();
        break;
      }
      case "ArrowUp": {
        event.preventDefault();
        const nextIndex =
          currentIndex < 0
            ? focusable.length - 1
            : (currentIndex - 1 + focusable.length) % focusable.length;
        focusable[nextIndex]?.focus();
        break;
      }
      case "Home":
        event.preventDefault();
        focusable[0]?.focus();
        break;
      case "End":
        event.preventDefault();
        focusable.at(-1)?.focus();
        break;
      default:
        break;
    }
  };

  return (
    <div className="task-actions-menu" ref={rootRef} style={menuShellStyle}>
      <IconButton
        ref={triggerRef}
        icon="more"
        label="更多操作"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            closeMenu();
            return;
          }
          openMenu("first");
        }}
        onKeyDown={handleTriggerKeyDown}
      />
      {open ? (
        <div
          ref={menuRef}
          className="task-actions-menu__panel"
          role="menu"
          data-task-id={task.id}
          style={menuPanelStyle}
          onKeyDown={handleMenuKeyDown}
        >
          {items.map((item) =>
            item.separator ? (
              <div
                key={item.id}
                className="task-actions-menu__separator"
                aria-hidden="true"
                style={menuSeparatorStyle}
              />
            ) : (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={!item.enabled}
                className="task-actions-menu__item"
                style={{
                  ...menuItemStyle,
                  ...(!item.enabled ? menuItemDisabledStyle : {}),
                }}
                onClick={() => {
                  setOpen(false);
                  void dispatchTaskAction(item.id, task, commands, onRename);
                }}
              >
                {item.checked ? <Icon name="check" size={14} /> : <span style={{ width: 14 }} />}
                <span>{item.label}</span>
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
