import type { ConnectionState } from "./protocol";

export interface RuntimeInfo {
  appVersion: string;
  sidecarVersion: string | null;
  connection: ConnectionState;
  bridge: "listening" | "unavailable";
  versionMismatch: boolean;
}
export function runtimeInfo(appVersion: string, sidecarVersion: string | undefined,
  connection: ConnectionState, bridge: RuntimeInfo["bridge"]): RuntimeInfo {
  const version = connection === "connected" && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(sidecarVersion || "") ? sidecarVersion! : null;
  return { appVersion, sidecarVersion: version, connection, bridge,
    versionMismatch: version !== null && version !== appVersion };
}
