import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import type { ExportJob, ExportKind, ExportRequest, MediaFile, MediaInfo } from "./mediaTypes";

const FORMATS = "mov,matroska,webm,mp3,wav,flac,ogg,aac,image2,jpeg_pipe,png_pipe";
const TYPES: Record<string, [MediaFile["kind"], string]> = { ".mp4": ["video", "video/mp4"], ".m4v": ["video", "video/mp4"], ".mov": ["video", "video/quicktime"], ".mkv": ["video", "video/x-matroska"], ".webm": ["video", "video/webm"], ".mp3": ["audio", "audio/mpeg"], ".m4a": ["audio", "audio/mp4"], ".wav": ["audio", "audio/wav"], ".flac": ["audio", "audio/flac"], ".ogg": ["audio", "audio/ogg"], ".jpg": ["image", "image/jpeg"], ".jpeg": ["image", "image/jpeg"], ".png": ["image", "image/png"] };
interface Source { id: string; status: string; file_path: string }
interface Grant { taskId: string; fileId: string; path: string; dev: number; ino: number; size: number; mtime: number }
interface StoredFile { id: string; taskId: string; source: string; path: string }
export function parseByteRange(range: string | null, size: number): { start: number; end: number; partial: boolean } | null {
  if (!range) return { start: 0, end: size - 1, partial: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m || (!m[1] && !m[2])) return null;
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  let end = m[1] ? (m[2] ? Number(m[2]) : size - 1) : size - 1;
  if (![start, end].every(Number.isSafeInteger) || start < 0 || end < start || start >= size || (!m[1] && Number(m[2]) <= 0)) return null;
  end = Math.min(end, size - 1);
  return { start, end, partial: true };
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
export function exportArguments(kind: ExportKind, input: string, output: string, duration: number, start: unknown, end: unknown): string[] {
  if (!finite(duration) || duration <= 0 || duration > 7 * 86400) throw Error("invalid_media");
  if (!["clip", "frame", "audio"].includes(kind)) throw Error("invalid_export");
  const args = ["-nostdin", "-hide_banner", "-v", "error", "-n", "-protocol_whitelist", "file,pipe", "-format_whitelist", FORMATS];
  if (kind === "clip" || kind === "frame") {
    if (!finite(start) || start < 0 || start >= duration) throw Error("invalid_range");
    if (kind === "clip" && (!finite(end) || end <= start || end > duration)) throw Error("invalid_range");
    args.push("-ss", String(start));
  }
  args.push("-i", input);
  if (kind === "clip") args.push("-t", String((end as number) - (start as number)), "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "h264_videotoolbox", "-allow_sw", "1", "-b:v", "6000k", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart");
  else if (kind === "frame") args.push("-map", "0:v:0", "-frames:v", "1", "-an", "-c:v", "mjpeg", "-q:v", "2");
  else args.push("-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart");
  return [...args, "-progress", "pipe:1", "-nostats", output];
}
function fingerprint(filePath: string): Omit<Grant, "taskId" | "fileId"> {
  if (!path.isAbsolute(filePath) || !TYPES[path.extname(filePath).toLowerCase()] || fs.lstatSync(filePath).isSymbolicLink()) throw Error("unsupported_file");
  const canonical = fs.realpathSync(filePath), s = fs.statSync(canonical);
  if (!s.isFile() || s.size <= 0 || !Number.isSafeInteger(s.size)) throw Error("missing_file");
  return { path: canonical, dev: s.dev, ino: s.ino, size: s.size, mtime: s.mtimeMs };
}
function sameFile(grant: Grant): void {
  const s = fingerprint(grant.path);
  if (s.dev !== grant.dev || s.ino !== grant.ino || s.size !== grant.size || s.mtime !== grant.mtime) throw Error("file_changed");
}
export class MediaWorkbench {
  private grants = new Map<string, Grant>();
  private files: StoredFile[] = [];
  private jobs: ExportJob[] = [];
  private child: ChildProcess | null = null;
  private stopping: Promise<void> | null = null;
  private starting = false;
  private stopped = false;
  private probes = new Set<ChildProcess>();
  private probeCache = new Map<string, Promise<{ duration: number; width: number; height: number; video: string; audio: string }>>();
  constructor(private readonly options: { dataDir: string; binDir: string; lookup: (id: string) => Promise<Source | undefined>; changed?: (job: ExportJob) => void }) {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.manifest, "utf8"));
      if (raw && typeof raw === "object") {
        const saved = raw as { files?: StoredFile[]; jobs?: ExportJob[] };
        this.files = (saved.files || []).filter(f => typeof f.id === "string" && typeof f.taskId === "string" && typeof f.source === "string" && typeof f.path === "string").slice(-10000);
        this.jobs = (saved.jobs || []).filter(j => typeof j.id === "string" && typeof j.taskId === "string" && ["clip", "frame", "audio"].includes(j.kind)).slice(-100).map(j => ({ ...j, file: undefined, status: ["running", "cancelling"].includes(j.status) ? "interrupted" : j.status }));
      }
    } catch { /* A missing or damaged export index never modifies download history. */ }
  }
  private get manifest(): string { return path.join(this.options.dataDir, "media-exports.json"); }
  private persist(): void {
    fs.mkdirSync(this.options.dataDir, { recursive: true });
    const tmp = this.manifest + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ files: this.files, jobs: this.jobs.map(j => ({ ...j, file: undefined })) }), { mode: 0o600 });
    fs.renameSync(tmp, this.manifest);
  }
  private async source(id: unknown): Promise<Source> {
    if (typeof id !== "string" || !id || id.length > 160) throw Error("invalid_task");
    const task = await this.options.lookup(id);
    if (!task || task.status !== "completed" || !task.file_path) throw Error("not_ready");
    return task;
  }
  private grant(taskId: string, fileId: string, filePath: string): MediaFile {
    const info = fingerprint(filePath), type = TYPES[path.extname(filePath).toLowerCase()];
    // Reuse only unchanged grants. Tokens are never persisted or derived from a path.
    let token = [...this.grants].find(([, g]) => g.taskId === taskId && g.fileId === fileId && g.path === info.path && g.mtime === info.mtime && g.size === info.size)?.[0];
    if (!token) { token = randomBytes(24).toString("hex"); this.grants.set(token, { taskId, fileId, ...info }); }
    if (this.grants.size > 512) this.grants.delete(this.grants.keys().next().value!);
    return { id: fileId, name: path.basename(info.path), path: info.path, bytes: info.size, kind: type[0], url: `downany-media://local/${token}` };
  }
  private async resolve(taskId: unknown, fileId: unknown): Promise<Grant> {
    const task = await this.source(taskId);
    if (typeof fileId !== "string") throw Error("invalid_file");
    let filePath = task.file_path;
    if (fileId !== "original") {
      const record = this.files.find(f => f.id === fileId && f.taskId === task.id && f.source === task.file_path);
      if (!record) throw Error("invalid_file");
      // Exports must still be under the original file's dedicated export directory.
      const expected = path.join(path.dirname(fs.realpathSync(task.file_path)), "Downany Exports");
      if (path.dirname(fs.realpathSync(record.path)) !== expected) throw Error("invalid_file");
      filePath = record.path;
    }
    return { taskId: task.id, fileId, ...fingerprint(filePath) };
  }
  private runProbe(filePath: string): Promise<{ duration: number; width: number; height: number; video: string; audio: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(path.join(this.options.binDir, "ffprobe"), ["-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", FORMATS, "-show_format", "-show_streams", "-of", "json", filePath], { shell: false, windowsHide: true });
      this.probes.add(child);
      let text = "", done = false;
      const timer = setTimeout(() => { child.kill("SIGKILL"); finish(Error("probe_timeout")); }, 15000);
      const finish = (error?: Error) => { if (done) return; done = true; this.probes.delete(child); clearTimeout(timer); if (error) return reject(error); try { const info = JSON.parse(text), streams = Array.isArray(info.streams) ? info.streams : [], v = streams.find((s: { codec_type?: string; disposition?: { attached_pic?: number } }) => s.codec_type === "video" && !s.disposition?.attached_pic), a = streams.find((s: { codec_type?: string }) => s.codec_type === "audio"); const duration = Number(info.format?.duration || v?.duration || 0); resolve({ duration: Number.isFinite(duration) ? duration : 0, width: Number(v?.width) || 0, height: Number(v?.height) || 0, video: String(v?.codec_name || ""), audio: String(a?.codec_name || "") }); } catch { reject(Error("unsupported_file")); } };
      child.stdout.on("data", data => { text += String(data); if (text.length > 2 * 1024 * 1024) { child.kill(); finish(Error("invalid_media")); } });
      child.stderr.resume(); child.once("error", () => finish(Error("tool_unavailable"))); child.once("close", code => finish(code === 0 ? undefined : Error("unsupported_file")));
    });
  }
  private probe(filePath: string) {
    const f = fingerprint(filePath), key = `${f.path}:${f.ino}:${f.size}:${f.mtime}`;
    const known = this.probeCache.get(key); if (known) return known;
    const pending = this.runProbe(filePath); this.probeCache.set(key, pending);
    if (this.probeCache.size > 128) this.probeCache.delete(this.probeCache.keys().next().value!);
    pending.catch(() => this.probeCache.delete(key)); return pending;
  }
  async inspect(taskId: unknown): Promise<MediaInfo> {
    const task = await this.source(taskId);
    const files: MediaFile[] = [];
    let meta = { duration: 0, width: 0, height: 0, video: "", audio: "" };
    try { const original = this.grant(task.id, "original", task.file_path); files.push(original); meta = await this.probe(original.path); Object.assign(original, meta); }
    catch { return { taskId: task.id, files: [], ...meta, error: "missing_or_unsupported" }; }
    for (const f of this.files.filter(f => f.taskId === task.id && f.source === task.file_path)) {
      try { await this.resolve(task.id, f.id); const item = this.grant(task.id, f.id, f.path); files.push({ ...item, ...await this.probe(item.path) }); } catch { files.push({ id: f.id, name: path.basename(f.path), path: f.path, bytes: 0, kind: TYPES[path.extname(f.path)]?.[0] || "video", url: "", missing: true }); }
    }
    return { taskId: task.id, files, ...meta };
  }
  async respond(request: Request): Promise<Response> {
    const url = new URL(request.url), token = url.pathname.slice(1);
    const deny = (status: number) => new Response(null, { status, headers: { "Cache-Control": "no-store" } });
    if (url.hostname !== "local" || url.search || !/^[a-f0-9]{48}$/.test(token) || !["GET", "HEAD"].includes(request.method)) return deny(403);
    const g = this.grants.get(token); if (!g) return deny(403);
    let fd: number | undefined;
    try {
      const current = await this.resolve(g.taskId, g.fileId); if (current.path !== g.path) throw Error("file_changed"); sameFile(g);
      fd = fs.openSync(g.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd); if (stat.dev !== g.dev || stat.ino !== g.ino || stat.size !== g.size || stat.mtimeMs !== g.mtime) throw Error("file_changed");
      const range = parseByteRange(request.headers.get("range"), stat.size);
      if (!range) { fs.closeSync(fd); fd = undefined; return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } }); }
      const headers: Record<string,string> = { "Content-Type": TYPES[path.extname(g.path).toLowerCase()][1], "Accept-Ranges": "bytes", "Content-Length": String(range.end - range.start + 1), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
      if (range.partial) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${stat.size}`;
      if (request.method === "HEAD") { fs.closeSync(fd); fd = undefined; return new Response(null, { status: range.partial ? 206 : 200, headers }); }
      const stream = fs.createReadStream(g.path, { fd, start: range.start, end: range.end, autoClose: true }); fd = undefined;
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: range.partial ? 206 : 200, headers });
    } catch { if (fd !== undefined) fs.closeSync(fd); return deny(404); }
  }
  listJobs(): ExportJob[] { return this.jobs.map(j => ({ ...j })); }
  private emit(job: ExportJob): void { this.options.changed?.({ ...job }); }
  async start(input: ExportRequest): Promise<ExportJob> {
    if (this.stopped || this.starting) throw Error("export_busy");
    this.starting = true;
    try { return await this.createExport(input); } finally { this.starting = false; }
  }
  private async createExport(input: ExportRequest): Promise<ExportJob> {
    if (this.child || this.jobs.some(j => j.status === "running")) throw Error("export_busy");
    if (!input || typeof input !== "object" || Object.keys(input).some(k => !["taskId", "fileId", "kind", "start", "end"].includes(k))) throw Error("invalid_export");
    const g = await this.resolve(input.taskId, input.fileId); sameFile(g);
    const meta = await this.probe(g.path);
    if (this.stopped) throw Error("app_stopping");
    if ((input.kind === "audio" && !meta.audio) || (input.kind !== "audio" && !meta.video)) throw Error("missing_stream");
    const original = await this.source(g.taskId);
    const directory = path.join(path.dirname(fs.realpathSync(original.file_path)), "Downany Exports");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== directory) throw Error("invalid_destination");
    const job: ExportJob = { id: randomUUID(), taskId: g.taskId, kind: input.kind, status: "running", progress: 0 };
    const ext = input.kind === "frame" ? ".jpg" : input.kind === "audio" ? ".m4a" : ".mp4";
    const stem = path.basename(g.path, path.extname(g.path)).slice(0, 80);
    const filePath = path.join(directory, `${stem}_${input.kind}_${Date.now()}_${job.id.slice(0,8)}${ext}`);
    // Private staging directory and no-clobber link make publication non-destructive.
    const staging = fs.mkdtempSync(path.join(directory, ".export-")); const output = path.join(staging, "result" + ext);
    let args: string[];
    try { args = exportArguments(input.kind, g.path, output, meta.duration, input.start, input.end); } catch (error) { fs.rmSync(staging, { recursive: true }); throw error; }
    sameFile(g);
    this.jobs.push(job); this.jobs = this.jobs.slice(-100);
    try { this.persist(); } catch (error) { this.jobs = this.jobs.filter(j => j.id !== job.id); fs.rmSync(staging, { recursive: true, force: true }); throw error; }
    const child = spawn(path.join(this.options.binDir, "ffmpeg"), args, { shell: false, windowsHide: true }); this.child = child;
    let cancelled = false, buffer = "";
    const duration = input.kind === "clip" ? (input.end! - input.start!) : meta.duration;
    const timer = setTimeout(() => { cancelled = true; this.cancel(job.id); }, 30 * 60 * 1000);
    let closed!: () => void; this.stopping = new Promise(resolve => { closed = resolve; });
    child.stdout.on("data", chunk => { buffer += String(chunk); if (buffer.length > 8192) buffer = buffer.slice(-4096); const lines = buffer.split("\n"); buffer = lines.pop() || ""; for (const line of lines) if (line.startsWith("out_time_us=")) { const n = Number(line.slice(12)); if (Number.isFinite(n)) { job.progress = Math.max(job.progress, Math.min(99, Math.floor(n / 1000000 / duration * 100))); this.emit(job); } } }); child.stderr.resume();
    const finish = async (code: number | null) => {
      clearTimeout(timer);
      try {
        if (["cancelled", "cancelling"].includes(job.status) || cancelled) { job.status = "cancelled"; }
        else if (code !== 0 || !fs.existsSync(output) || !fs.statSync(output).size) { job.status = "failed"; job.error = "export_failed"; }
        else {
          const check = await this.probe(output);
          if (input.kind === "frame" ? !check.width || !check.height : !check.duration || (input.kind === "audio" ? !check.audio : !check.video)) throw Error("invalid_output");
          if (this.jobs.find(j => j.id === job.id)?.status === "cancelling") throw Error("export_cancelled");
          sameFile(g); if (fs.realpathSync(directory) !== directory) throw Error("invalid_destination"); fs.linkSync(output, filePath);
          const stored = { id: job.id, taskId: g.taskId, source: (await this.source(g.taskId)).file_path, path: filePath };
          this.files.push(stored); job.file = this.grant(g.taskId, job.id, filePath); job.progress = 100; job.status = "completed";
        }
      } catch { if (["cancelled", "cancelling"].includes(job.status)) job.status = "cancelled"; else { job.status = "failed"; job.error = "export_failed"; } }
      finally { fs.rmSync(staging, { recursive: true, force: true }); this.child = null; try { this.persist(); } catch { job.status = "failed"; job.error = "index_write_failed"; } this.emit(job); closed(); this.stopping = null; }
    };
    let finished = false; const once = (code: number | null) => { if (finished) return; finished = true; void finish(code); };
    child.once("error", () => once(-1)); child.once("close", once); this.emit(job); return { ...job };
  }
  cancel(id: unknown): void { const job = this.jobs.find(j => j.id === id && j.status === "running"); if (!job) return; job.status = "cancelling"; this.child?.kill("SIGTERM"); const child = this.child; setTimeout(() => { if (this.child === child) child?.kill("SIGKILL"); }, 1500).unref(); this.emit(job); }
  async stop(): Promise<void> { this.stopped = true; for (const probe of this.probes) probe.kill("SIGKILL"); const active = this.jobs.find(j => j.status === "running"); if (active) this.cancel(active.id); await this.stopping; this.grants.clear(); }
  async filePath(taskId: unknown, fileId: unknown): Promise<string> { return (await this.resolve(taskId, fileId)).path; }
}
