/** 扩展桥入队门闸：Sidecar 未就绪时不得对扩展返回假成功。 */

export type BridgeGateDecision =
  | { kind: "flush" }
  | { kind: "defer"; error: string };

export const SIDECAR_NOT_READY_ERROR =
  "下载服务未就绪，请确认视频下载器已完全启动后再试";

/**
 * 桥接入队决策。
 * - flush：立刻交给 Sidecar createTasks
 * - defer：暂存 pending，并对扩展返回明确失败（避免「已发送」但队列无任务）
 */
export function decideBridgeEnqueue(sidecarReady: boolean): BridgeGateDecision {
  if (!sidecarReady) {
    return { kind: "defer", error: SIDECAR_NOT_READY_ERROR };
  }
  return { kind: "flush" };
}

/** Sidecar 连接态变化时是否应视为可入队。 */
export function isSidecarAcceptingEnqueue(
  state: "disconnected" | "connecting" | "connected" | "reconnecting" | "failed",
): boolean {
  return state === "connected";
}
