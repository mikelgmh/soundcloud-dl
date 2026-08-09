import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkFfmpegUpdate,
  checkYtDlpUpdate,
  computeVersions,
  ensureDeps,
  fetchLatestVersions,
  getFfmpegVersion,
  getStoredYtDlpVersion,
  makeToolVersion,
  type Deps,
  type ToolVersion,
} from "../deps";
import {
  buildDownloadArgs,
  DEFAULT_FILENAME_TEMPLATE,
  downloadLikesStream,
  fetchFlatEntries,
  fetchLikes,
} from "../download";
import {
  appendHistory,
  ARCHIVE_FILE,
  BIN_DIR,
  loadConfig,
  loadLikesCache,
  readArchiveIds,
  readHistory,
  saveConfig,
  saveLikesCache,
  writeCookiesFile,
  type Config,
  type LikedTrack,
} from "../store";
import { clearSoundCloudSession } from "./login";
import { runStream, type ProcessController, type RunStreamOpts } from "../util";
import { Utils } from "electrobun/bun";
import type {
  ConfigPayload,
  DepsStatus,
  DownloadProgressPayload,
  LikesResultPayload,
  LoginResultPayload,
  LogLevel,
  StatusSnapshot,
  SyncStatsPayload,
  HistoryItemPayload,
  UpdateResultPayload,
} from "../shared/types";

export interface Emitter {
  log(level: LogLevel, text: string): void;
  status(stage: string, message: string): void;
  progress(p: DownloadProgressPayload): void;
}

export type LoginBrowserFn = (
  onStatus: (msg: string) => void,
) => Promise<LoginResultPayload>;

const DEFAULT_OUTDIR = path.join(os.homedir(), "Music", "SoundCloud");

// Formato antiguo por defecto: si quedó guardado en config, se migra.
const LEGACY_TEMPLATE = "%(uploader)s - %(title)s [%(id)s]";

class DownloadTracker {
  private lastEmit = 0;
  private state: DownloadProgressPayload = {
    current: 0,
    total: 0,
    percent: 0,
    eta: "",
    title: "",
  };
  constructor(private emit: (s: DownloadProgressPayload) => void) {}

  handle(line: string): void {
    const item = line.match(/\[download\] Downloading item (\d+) of (\d+)/);
    if (item) {
      this.state.current = Number(item[1]);
      this.state.total = Number(item[2]);
      // Cada canción nueva empieza su propio progreso.
      this.state.percent = 0;
      this.state.eta = "";
    }
    const pct = line.match(/\[download\]\s+([\d.]+)%/);
    if (pct) this.state.percent = parseFloat(pct[1]);
    const eta = line.match(/ETA\s+([0-9:]+)/);
    if (eta) this.state.eta = eta[1];
    const dest = line.match(/Destination:\s+(.+\.\w+)/);
    if (dest) {
      const base = dest[1].split("/").pop() ?? "";
      this.state.title = base.replace(/\.[^.]+$/, "");
    }
    const now = Date.now();
    if (now - this.lastEmit > 200) {
      this.lastEmit = now;
      this.emit({ ...this.state });
    }
  }
}

export class Service {
  private deps: Deps | null = null;
  private config: Config = loadConfig();
  private abort: AbortController | null = null;
  private controller: ProcessController | null = null;
  private versionsCache: { ytdlp: ToolVersion; ffmpeg: ToolVersion } | null = null;

  constructor(
    private emitter: Emitter,
    private loginBrowser: LoginBrowserFn,
    private folderPicker: () => Promise<string | null>,
    /** Inyectable para tests; por defecto usa runStream real. */
    private runStreamFn: (cmd: string[], opts?: RunStreamOpts) => Promise<number> = runStream,
  ) {}

  // ---- Estado ----

  async getStatus(): Promise<StatusSnapshot> {
    return {
      deps: await this.getDepsStatus(),
      config: this.toConfigPayload(this.config),
      likesCount: this.getLikesCount(),
      likesCachedAt: this.getLikesCachedAt(),
    };
  }

  private async getDepsStatus(): Promise<DepsStatus> {
    const ytdlpPath =
      this.deps?.ytdlp ?? Bun.which("yt-dlp") ?? path.join(BIN_DIR, "yt-dlp");
    const ytdlpPresent = fs.existsSync(ytdlpPath);
    const ffmpegDir = this.deps?.ffmpegDir ?? null;
    const ffmpegPresent =
      ffmpegDir != null || !!(Bun.which("ffmpeg") && Bun.which("ffprobe"));

    const ytCurrent = ytdlpPresent ? getStoredYtDlpVersion(ytdlpPath) : null;
    const ffCurrent = ffmpegPresent ? await getFfmpegVersion(ffmpegDir) : null;
    const cache = this.versionsCache;

    return {
      ytdlpPresent,
      ffmpegPresent,
      ytdlpPath,
      ffmpegDir,
      ready: ytdlpPresent && ffmpegPresent,
      ytdlpVersion: makeToolVersion(ytCurrent, cache?.ytdlp.latest ?? null),
      ffmpegVersion: makeToolVersion(ffCurrent, cache?.ffmpeg.latest ?? null),
    };
  }

  checkDeps(): Promise<DepsStatus> {
    return this.getDepsStatus();
  }

  async installDeps(): Promise<DepsStatus> {
    this.emitter.status("deps", "Comprobando dependencias...");
    const deps = await ensureDeps({
      onStatus: (m) => this.emitter.status("deps", m),
      askInstall: async () => true,
    });
    this.deps = deps;
    const hasFfmpeg =
      deps.ffmpegDir !== null ||
      !!(Bun.which("ffmpeg") && Bun.which("ffprobe"));
    if (!hasFfmpeg) {
      throw new Error("No se pudo instalar ffmpeg. Instálalo manualmente con: brew install ffmpeg");
    }
    this.emitter.log("success", `yt-dlp: ${deps.ytdlp}`);
    this.emitter.log("success", `ffmpeg: ${deps.ffmpegDir ?? "del sistema (PATH)"}`);
    return this.getDepsStatus();
  }

  private async ensureDepsReady(): Promise<Deps> {
    if (this.deps) return this.deps;
    const ytdlp = Bun.which("yt-dlp") ?? path.join(BIN_DIR, "yt-dlp");
    if (!fs.existsSync(ytdlp)) {
      throw new Error("yt-dlp no está disponible. Instala las dependencias.");
    }
    const hasFfmpeg = !!(Bun.which("ffmpeg") && Bun.which("ffprobe"));
    if (!hasFfmpeg) {
      throw new Error("ffmpeg no está disponible. Instala las dependencias.");
    }
    this.deps = { ytdlp, ffmpegDir: null };
    return this.deps;
  }

  /** Comprueba en segundo plano las versiones y actualiza si hay nuevas. */
  async checkForUpdates(): Promise<UpdateResultPayload> {
    const empty = {
      ytdlp: makeToolVersion(null, null),
      ffmpeg: makeToolVersion(null, null),
    };
    const deps = await this.ensureDepsReady().catch(() => null);
    if (!deps) return { updated: [], versions: empty };

    const cb = (m: string) => this.emitter.log("info", m);
    const latest = await fetchLatestVersions(deps);
    const versions = await computeVersions(deps, latest);
    const updated: string[] = [];

    if (versions.ytdlp.hasUpdate) {
      if (await checkYtDlpUpdate(deps.ytdlp, cb, latest.ytdlp)) updated.push("yt-dlp");
    }
    if (versions.ffmpeg.hasUpdate) {
      if (await checkFfmpegUpdate(deps.ffmpegDir, cb, latest.ffmpeg)) {
        updated.push("ffmpeg");
      }
    }

    const after = await computeVersions(deps, latest);
    this.versionsCache = after;
    for (const name of updated) {
      this.emitter.log("success", `${name} actualizado.`);
    }
    return { updated, versions: after };
  }

  // ---- Configuración ----

  getConfig(): ConfigPayload {
    return this.toConfigPayload(this.config);
  }

  saveConfig(patch: Partial<ConfigPayload>): ConfigPayload {
    const next: Config = { ...this.config };
    if (patch.username !== undefined) next.username = patch.username;
    if (patch.outdir !== undefined) next.outdir = patch.outdir;
    if (patch.format !== undefined) next.format = patch.format;
    if (patch.bitrate !== undefined) next.bitrate = patch.bitrate;
    if (patch.filenameTemplate !== undefined) {
      next.filenameTemplate = patch.filenameTemplate;
    }
    if (patch.theme !== undefined) next.theme = patch.theme as 'dark' | 'light';
    if (patch.skipExisting !== undefined) next.skipExisting = patch.skipExisting;
    if (patch.oauthToken === "") {
      delete next.oauthToken;
      this.emitter.log("info", "Sesión cerrada.");
    } else if (patch.oauthToken) {
      next.oauthToken = patch.oauthToken;
    }
    next.setupDone = true;
    this.config = next;
    saveConfig(next);
    return this.toConfigPayload(next);
  }

  private getFilenameTemplate(c: Config): string {
    return c.filenameTemplate && c.filenameTemplate !== LEGACY_TEMPLATE
      ? c.filenameTemplate
      : DEFAULT_FILENAME_TEMPLATE;
  }

  private toConfigPayload(c: Config): ConfigPayload {
    return {
      ...c,
      outdir: c.outdir || DEFAULT_OUTDIR,
      quality: c.quality ?? '320K',
      format: c.format ?? 'mp3',
      bitrate: c.bitrate ?? c.quality ?? '320K',
      filenameTemplate: this.getFilenameTemplate(c),
      theme: c.theme ?? 'dark',
      skipExisting: c.skipExisting ?? true,
      hasToken: !!c.oauthToken,
    };
  }

  /** Abre el selector nativo de carpeta. */
  async selectFolder(): Promise<{ path: string | null }> {
    try {
      const picked = await this.folderPicker();
      return { path: picked };
    } catch {
      return { path: null };
    }
  }

  // ---- Autenticación ----

  async login(): Promise<LoginResultPayload> {
    this.emitter.status("login", "Abriendo la ventana de SoundCloud...");
    const res = await this.loginBrowser((m) => this.emitter.status("login", m));
    this.config.oauthToken = res.oauthToken;
    if (res.username) this.config.username = res.username;
    this.config.setupDone = true;
    saveConfig(this.config);
    this.emitter.log("success", "Sesión iniciada y guardada.");
    return res;
  }

  async loginWithToken(token: string): Promise<{ ok: boolean }> {
    if (!token || token.trim().length < 10) {
      throw new Error("El token no parece válido.");
    }
    this.config.oauthToken = token.trim();
    this.config.setupDone = true;
    saveConfig(this.config);
    this.emitter.log("success", "Token guardado.");
    return { ok: true };
  }

  /** Cierra la sesión: borra el token guardado y la sesión de la webview. */
  logout(): { ok: boolean } {
    delete this.config.oauthToken;
    this.config.setupDone = true;
    saveConfig(this.config);
    clearSoundCloudSession();
    this.emitter.log("info", "Sesión cerrada.");
    return { ok: true };
  }

  // ---- Favoritos ----

  async refreshLikes(): Promise<LikesResultPayload> {
    const deps = await this.ensureDepsReady();
    const username = this.config.username;
    const token = this.config.oauthToken;
    if (!username || !token) {
      throw new Error("Inicia sesión y configura tu usuario primero.");
    }
    this.emitter.status("likes", "Obteniendo tus favoritos...");
    const result = await fetchLikes({
      ytdlp: deps.ytdlp,
      ffmpegDir: deps.ffmpegDir,
      cookiesFile: writeCookiesFile(token),
      username,
    });
    saveLikesCache(username, result.tracks);
    if (result.tokenInvalid) {
      this.emitter.log("warn", "El token parece no ser válido; solo se verán los likes públicos.");
    }
    this.emitter.log("success", `Favoritos: ${result.tracks.length}`);
    return { tracks: result.tracks, tokenInvalid: result.tokenInvalid, count: result.tracks.length };
  }

  getLikesCache(): { tracks: LikedTrack[]; cachedAt: number | null } {
    const username = this.config.username;
    if (!username) return { tracks: [], cachedAt: null };
    const cached = loadLikesCache(username);
    return cached ? { tracks: cached.tracks, cachedAt: cached.cachedAt } : { tracks: [], cachedAt: null };
  }

  /** Cuenta cuántos favoritos ya están descargados y cuántos faltan. */
  async getSyncStats(): Promise<SyncStatsPayload> {
    let tracks = this.getLikesCache().tracks;
    if (tracks.length === 0) {
      try {
        tracks = (await this.refreshLikes()).tracks;
      } catch {
        tracks = [];
      }
    }
    const ids = readArchiveIds();
    const downloaded = tracks.filter((t) => ids.has(t.id)).length;
    return {
      total: tracks.length,
      downloaded,
      missing: tracks.length - downloaded,
    };
  }

  /** Ids de las canciones ya descargadas (archivo de sincronización). */
  getDownloadedIds(): { ids: string[] } {
    return { ids: [...readArchiveIds()] };
  }

  private getLikesCount(): number | null {
    const c = this.getLikesCache();
    return c.cachedAt ? c.tracks.length : null;
  }

  private getLikesCachedAt(): number | null {
    return this.getLikesCache().cachedAt;
  }

  // ---- Descargas ----

  async downloadAll(): Promise<{ ok: boolean; code: number }> {
    const config = this.requireDownloadConfig();
    const outDir = config.outdir || DEFAULT_OUTDIR;
    fs.mkdirSync(outDir, { recursive: true });
    return this.runDownload(
      buildDownloadArgs(this.downloadOpts(config, outDir)),
      "Descargando todos tus favoritos...",
    );
  }

  async downloadTrack(url: string): Promise<{ ok: boolean; code: number }> {
    const config = this.requireDownloadConfig();
    const outDir = config.outdir || DEFAULT_OUTDIR;
    fs.mkdirSync(outDir, { recursive: true });
    this.emitter.log("info", `Descargando canción individual: ${url}`);
    return this.runDownload(
      buildDownloadArgs({ ...this.downloadOpts(config, outDir), url }),
      "Descargando canción...",
    );
  }

  /** Descarga cualquier enlace de SoundCloud pegado por el usuario. */
  async downloadUrl(url: string): Promise<{ ok: boolean; code: number }> {
    const trimmed = url.trim();
    if (!/^https?:\/\/(www\.|m\.|on\.)?soundcloud\.com\//i.test(trimmed)) {
      throw new Error("Ese enlace no parece ser de SoundCloud.");
    }
    return this.downloadTrack(trimmed);
  }

  /** Configuración exportable (sin el token de sesión). */
  exportConfig(): { json: string } {
    const { oauthToken: _omit, ...safe } = this.config;
    return { json: JSON.stringify(safe, null, 2) };
  }

  /** Importa la configuración (nunca el token de sesión). */
  importConfig(json: string): { ok: boolean } {
    const parsed = JSON.parse(json) as Partial<Config>;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("El JSON de configuración no es válido.");
    }
    const next: Config = { ...this.config };
    if (parsed.outdir) next.outdir = parsed.outdir;
    if (parsed.format) next.format = parsed.format;
    if (parsed.bitrate) next.bitrate = parsed.bitrate;
    if (parsed.filenameTemplate) next.filenameTemplate = parsed.filenameTemplate;
    if (parsed.skipExisting !== undefined) next.skipExisting = parsed.skipExisting;
    next.setupDone = true;
    this.config = next;
    saveConfig(next);
    this.emitter.log("success", "Configuración importada.");
    return { ok: true };
  }

  /** Historial reciente de descargas. */
  getHistory(): { items: HistoryItemPayload[] } {
    return { items: readHistory(30) };
  }

  /** Borra archivos descargados que ya no están en favoritos. */
  async cleanupNonFavorites(): Promise<{ removed: string[] }> {
    const config = this.requireDownloadConfig();
    const outDir = config.outdir || DEFAULT_OUTDIR;
    const favIds = new Set(this.getLikesCache().tracks.map((t) => t.id));
    const archive = readArchiveIds();
    const removed: string[] = [];
    const walk = (dir: string): void => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p);
        } else {
          const m = entry.name.match(/\[(\d+)\]/);
          if (m && archive.has(m[1]) && !favIds.has(m[1])) {
            try {
              fs.unlinkSync(p);
              removed.push(p);
            } catch {
              // seguir
            }
          }
        }
      }
    };
    if (fs.existsSync(outDir)) walk(outDir);
    return { removed };
  }

  // ---- Playlists ----

  /** Lista las playlists/sets del usuario. */
  async getPlaylists(): Promise<{
    playlists: { id: string; title: string; url: string }[];
  }> {
    const config = this.requireDownloadConfig();
    const deps = await this.ensureDepsReady();
    const { entries } = await fetchFlatEntries(
      `https://soundcloud.com/${config.username}/sets`,
      {
        ytdlp: deps.ytdlp,
        ffmpegDir: deps.ffmpegDir,
        cookiesFile: writeCookiesFile(config.oauthToken!),
        username: config.username!,
      },
    );
    return {
      playlists: entries.map((e) => ({ id: e.id, title: e.title, url: e.url })),
    };
  }

  /** Canciones de una playlist concreta. */
  async getPlaylistTracks(url: string): Promise<{
    tracks: LikedTrack[];
    tokenInvalid: boolean;
  }> {    const config = this.requireDownloadConfig();
    const deps = await this.ensureDepsReady();
    const { entries, tokenInvalid } = await fetchFlatEntries(url, {
      ytdlp: deps.ytdlp,
      ffmpegDir: deps.ffmpegDir,
      cookiesFile: writeCookiesFile(config.oauthToken!),
      username: config.username!,
    }, 'full');
    return { tracks: entries, tokenInvalid };
  }

  /** Busca canciones en todo SoundCloud. */
  async searchSoundcloud(query: string): Promise<{ tracks: LikedTrack[] }> {
    const q = query.trim();
    if (!q) throw new Error("Escribe un término de búsqueda.");
    const config = this.requireDownloadConfig();
    const deps = await this.ensureDepsReady();
    this.emitter.status("likes", `Buscando "${q}" en SoundCloud...`);
    const { entries } = await fetchFlatEntries(`scsearch20:${q}`, {
      ytdlp: deps.ytdlp,
      ffmpegDir: deps.ffmpegDir,
      cookiesFile: writeCookiesFile(config.oauthToken!),
      username: config.username!,
    });
    return { tracks: entries };
  }

  /** Descarga una lista de URLs (p.ej. una playlist entera). */
  async downloadUrls(urls: string[]): Promise<{ ok: boolean; code: number }> {
    const clean = urls.filter(Boolean);
    if (clean.length === 0) throw new Error("No hay canciones para descargar.");
    const config = this.requireDownloadConfig();
    const outDir = config.outdir || DEFAULT_OUTDIR;
    fs.mkdirSync(outDir, { recursive: true });
    return this.runDownload(
      buildDownloadArgs({ ...this.downloadOpts(config, outDir), urls: clean }),
      `Descargando ${clean.length} canciones...`,
    );
  }

  cancelDownload(): { ok: boolean } {
    if (this.abort) {
      this.abort.abort();
      this.emitter.log("warn", "Descarga cancelada por el usuario.");
    }
    return { ok: true };
  }

  pauseDownload(): { ok: boolean } {
    this.controller?.pause();
    this.emitter.log("info", "Descarga pausada.");
    return { ok: true };
  }

  resumeDownload(): { ok: boolean } {
    this.controller?.resume();
    this.emitter.log("info", "Descarga reanudada.");
    return { ok: true };
  }

  private requireDownloadConfig(): Config {
    const { username, oauthToken, outdir } = this.config;
    if (!username || !oauthToken) {
      throw new Error("Inicia sesión y configura tu usuario para descargar.");
    }
    return { ...this.config, outdir: outdir || DEFAULT_OUTDIR };
  }

  private downloadOpts(config: Config, outDir: string) {
    return {
      ytdlp: "",
      ffmpegDir: null as string | null,
      outDir,
      format: config.format ?? "mp3",
      bitrate: config.bitrate ?? config.quality ?? "320K",
      filenameTemplate: this.getFilenameTemplate(config),
      skipExisting: config.skipExisting ?? true,
      cookiesFile: writeCookiesFile(config.oauthToken!),
      username: config.username!,
      archiveFile: ARCHIVE_FILE,
    };
  }

  /** Serializa las descargas: solo se ejecuta una a la vez (anti-baneo). */
  private downloadChain: Promise<unknown> = Promise.resolve();

  private enqueueRun<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.downloadChain.then(fn, fn);
    this.downloadChain = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  private runDownload(
    args: string[],
    message: string,
  ): Promise<{ ok: boolean; code: number }> {
    return this.enqueueRun(async () => {
      const deps = await this.ensureDepsReady();
      args[0] = deps.ytdlp;
      this.emitter.status("download", message);
      this.abort = new AbortController();
      this.controller = { pause() {}, resume() {} };
      const tracker = new DownloadTracker((p) => this.emitter.progress(p));
      const code = await this.runStreamFn(args, {
        onStdout: (line) => {
          if (!/^\[download\]\s+\d+(?:\.\d+)?%/.test(line)) {
            this.emitter.log("info", line);
          }
          tracker.handle(line);
        },
        onStderr: (line) => {
          this.emitter.log("info", line);
          tracker.handle(line);
        },
        signal: this.abort.signal,
        controller: this.controller,
      });
      this.abort = null;
      this.controller = null;
      tracker.handle("");
      this.emitter.status(
        "download",
        code === 0 ? "Descarga completada" : `Descarga terminó con código ${code}`,
      );

      // Historial + notificación del sistema al terminar.
      const target = this.downloadUrlTarget(args);
      appendHistory({
        ts: Date.now(),
        target,
        format: this.config.format ?? "mp3",
        ok: code === 0,
      });
      if (code === 0) {
        try {
          Utils.showNotification({
            title: "Descarga completada",
            body:
              target === "favoritos"
                ? "Se ha sincronizado tu lista de favoritos."
                : `Se ha descargado: ${target}`,
          });
        } catch {
          // las notificaciones no son críticas
        }
      }
      return { ok: code === 0, code };
    });
  }

  /** Extrae de los args el destino de la descarga (para historial/notificación). */
  private downloadUrlTarget(args: string[]): string {
    const url = args[args.length - 1] ?? "";
    if (/\/likes$/.test(url)) return "favoritos";
    return url;
  }
}
