import { useRef, useState } from "react";

import { t, useLocale } from "../i18n";
import { request } from "../lib/api";
import { buildQueueUnits, moveQueueUnit, type QueueMove, type QueueUnit } from "../lib/queueOrdering";
import type { AppSnapshot } from "../lib/types";
import { useAppStore } from "../store/appStore";
import { Button } from "./ui/Button";

interface QueueOrderControlsProps {
  unitKey: QueueUnit["key"];
  label: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
}

export function QueueOrderControls({ unitKey, label, canMoveUp, canMoveDown }: QueueOrderControlsProps) {
  const locale = useLocale();
  const connected = useAppStore((state) => state.connection === "connected");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  const move = async (direction: QueueMove) => {
    if (pending.current || !connected) return;
    pending.current = true;
    setBusy(true);
    try {
      const units = buildQueueUnits(useAppStore.getState().tasks);
      const orderedIds = moveQueueUnit(units, unitKey, direction);
      const snapshot = await request<AppSnapshot>("download.reorder", { orderedIds });
      useAppStore.getState().applyQueueOrder(snapshot);
    } catch {
      useAppStore.getState().pushToast({ kind: "error", title: t("queue.orderFailed"), detail: t("queue.orderRetry") });
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="queue-order-controls" role="group" aria-label={t("queue.order", locale, { title: label })}>
      <Button variant="ghost" size="small" aria-label={t("queue.moveUpLabel", locale, { title: label })}
        disabled={!connected || busy || !canMoveUp} onClick={() => void move("up")}>
        {t("queue.moveUp", locale)}
      </Button>
      <Button variant="ghost" size="small" aria-label={t("queue.moveDownLabel", locale, { title: label })}
        disabled={!connected || busy || !canMoveDown} onClick={() => void move("down")}>
        {t("queue.moveDown", locale)}
      </Button>
      <Button variant="ghost" size="small" aria-label={t("queue.moveTopLabel", locale, { title: label })}
        disabled={!connected || busy || !canMoveUp} onClick={() => void move("top")}>
        {t("queue.moveTop", locale)}
      </Button>
    </div>
  );
}
