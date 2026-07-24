import { useEffect, useRef } from "react";

import { useAppStore } from "../store/appStore";

export function ToastHost() {
  const toasts = useAppStore((s) => s.toasts);
  const dismissToast = useAppStore((s) => s.dismissToast);
  const focused = useRef(false);

  useEffect(() => {
    const timers = toasts
      .filter((t) => !t.sticky)
      .map((t) =>
        window.setTimeout(() => {
          if (!focused.current) dismissToast(t.id);
        }, 4000),
      );
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [toasts, dismissToast]);

  if (toasts.length === 0) return null;

  return (
    <div
      className="toast-host"
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
      }}
    >
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role="status">
          <div>
            <strong>{t.title}</strong>
            {t.detail && <p>{t.detail}</p>}
          </div>
          <button type="button" aria-label="关闭" onClick={() => dismissToast(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
