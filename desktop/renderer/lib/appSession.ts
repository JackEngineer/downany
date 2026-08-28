import type { DesktopApi } from "../../electron/preload";
import { useAppStore } from "../store/appStore";
import type { AppSnapshot, ConnectionState } from "./types";

export type AppSessionApi = Pick<DesktopApi, "request" | "onEvent" | "onState" | "getConnectionState" | "getLogDir">;

/** Subscribe before issuing requests so live events can protect their pending snapshots. */
export function startAppSession(api: AppSessionApi): () => void {
  let alive = true;
  let connectionEvents = 0;
  const refresh = () => {
    if (!alive) return;
    void useAppStore.getState().refreshSnapshot(
      () => api.request("app.getSnapshot") as Promise<AppSnapshot>,
    ).catch(() => undefined); // Connection state owns recovery and its visible error.
  };
  const applyConnection = (state: ConnectionState) => {
    const store = useAppStore.getState();
    store.invalidateSnapshotRequests();
    store.setConnection(state);
  };
  const offState = api.onState((state) => {
    if (!alive) return;
    connectionEvents += 1;
    applyConnection(state);
    if (state === "connected") refresh();
  });
  const offEvent = api.onEvent((event) => {
    if (!alive) return;
    if (event.event === "sidecar.health") {
      // Main obtains this payload asynchronously. It may already predate task
      // events received here, so never hydrate it as a synchronous snapshot.
      refresh();
      return;
    }
    useAppStore.getState().applyEvent(event);
  });

  const initialConnectionEvents = connectionEvents;
  void api.getConnectionState().then((state) => {
    if (!alive || connectionEvents !== initialConnectionEvents) return;
    if (state !== "connected") useAppStore.getState().invalidateSnapshotRequests();
    useAppStore.getState().setConnection(state);
  }).catch(() => undefined);
  void api.getLogDir().then((dir) => {
    if (alive) useAppStore.getState().setLogDir(dir);
  }).catch(() => undefined);
  refresh();

  return () => {
    if (!alive) return;
    alive = false;
    useAppStore.getState().invalidateSnapshotRequests();
    offState();
    offEvent();
  };
}
