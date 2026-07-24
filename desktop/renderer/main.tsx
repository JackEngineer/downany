import { useEffect } from "react";
import { createRoot } from "react-dom/client";

import { Shell } from "./components/Shell";
import * as api from "./lib/api";
import type { AppSnapshot } from "./lib/types";
import { useAppStore } from "./store/appStore";
import "./styles.css";

function Bootstrap() {
  useEffect(() => {
    let alive = true;
    const store = useAppStore.getState();

    void api.getLogDir().then((dir) => {
      if (alive) store.setLogDir(dir);
    });
    void api.getConnectionState().then((state) => {
      if (alive) store.setConnection(state);
    });

    const offState = api.onState((state) => {
      useAppStore.getState().setConnection(state);
      if (state === "connected") {
        void api.request<AppSnapshot>("app.getSnapshot").then((snap) => {
          useAppStore.getState().hydrateSnapshot(snap);
        });
      }
    });

    const offEvent = api.onEvent((event) => {
      if (event.event === "sidecar.health" && event.payload.snapshot) {
        useAppStore.getState().hydrateSnapshot(event.payload.snapshot as AppSnapshot);
        return;
      }
      useAppStore.getState().applyEvent(event);
    });

    void api
      .request<AppSnapshot>("app.getSnapshot")
      .then((snap) => {
        if (alive) useAppStore.getState().hydrateSnapshot(snap);
      })
      .catch(() => {
        /* 连接未就绪时忽略，等 onState */
      });

    return () => {
      alive = false;
      offState();
      offEvent();
    };
  }, []);

  return <Shell />;
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<Bootstrap />);
}
