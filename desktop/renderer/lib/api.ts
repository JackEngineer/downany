import type { ConnectionState, ProtocolEvent } from "./types";

export async function request<T = unknown>(
  method: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  return (await window.api.request(method, payload)) as T;
}

export function onEvent(handler: (event: ProtocolEvent) => void): () => void {
  return window.api.onEvent(handler);
}

export function onState(handler: (state: ConnectionState) => void): () => void {
  return window.api.onState(handler);
}

export async function getConnectionState(): Promise<ConnectionState> {
  return window.api.getConnectionState();
}

export async function getLogDir(): Promise<string> {
  return window.api.getLogDir();
}

export async function openPath(target: string): Promise<string> {
  return window.api.openPath(target);
}

export async function quitApp(): Promise<void> {
  return window.api.quit();
}
