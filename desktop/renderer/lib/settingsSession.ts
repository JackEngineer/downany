import type { DesktopApi } from "../../electron/preload";
import { useAppStore } from "../store/appStore";
import type { AppSettings } from "./types";

export type SettingsSessionApi = Pick<DesktopApi, "request" | "onEvent" | "onState" | "getConnectionState">;

/** Settings windows need no queue snapshot, but have the same late-reply boundary. */
export function startSettingsSession(api: SettingsSessionApi): () => void {
  let alive = true;
  let generation = 0;
  let connectionEvents = 0;
  const offStore = useAppStore.subscribe((current, previous) => {
    if (current.settings !== previous.settings) generation += 1;
  });
  const refresh = () => {
    const requested = ++generation;
    void api.request("settings.get").then((settings) => {
      if (!alive || requested !== generation) return;
      useAppStore.getState().applyEvent({ event: "settings.changed", payload: { settings: settings as AppSettings } });
    }).catch(() => undefined);
  };
  const offState = api.onState((state) => {
    if (!alive) return;
    connectionEvents += 1;
    generation += 1;
    useAppStore.getState().setConnection(state);
    if (state === "connected") refresh();
  });
  const offEvent = api.onEvent((event) => {
    if (!alive || event.event !== "settings.changed" || !event.payload.settings) return;
    generation += 1;
    useAppStore.getState().applyEvent(event);
  });
  const initialConnectionEvents = connectionEvents;
  void api.getConnectionState().then((state) => {
    if (!alive || connectionEvents !== initialConnectionEvents) return;
    if (state !== "connected") generation += 1;
    useAppStore.getState().setConnection(state);
  }).catch(() => undefined);
  refresh();
  return () => {
    if (!alive) return;
    alive = false;
    generation += 1;
    offStore();
    offState();
    offEvent();
  };
}
