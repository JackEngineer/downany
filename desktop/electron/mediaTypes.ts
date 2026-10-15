export type ExportKind = "clip" | "frame" | "audio";
export interface MediaFile { id: string; name: string; path: string; bytes: number; kind: "video" | "audio" | "image"; url: string; duration?: number; width?: number; height?: number; video?: string; audio?: string; missing?: boolean }
export interface MediaInfo { taskId: string; files: MediaFile[]; duration: number; width: number; height: number; video: string; audio: string; error?: string }
export interface ExportRequest { taskId: string; fileId: string; kind: ExportKind; start?: number; end?: number }
export interface ExportJob { id: string; taskId: string; kind: ExportKind; status: "running" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted"; progress: number; file?: MediaFile; error?: string }
