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
  findTrackFile,
  renderFilenameTemplate,
  scanAudioStems,
} from "../download";
import {
  appendHistory,
  ARCHIVE_FILE,
  BIN_DIR,
  loadConfig,
  loadLikesCache,
  purgeArchiveIds,
  readArchiveIds,
  readHistory,
  saveConfig,
  saveLikesCache,
  writeCookiesFile,
  type Config,
  type LikedTrack,
} from "../store";
import { clearSoundCloudSession } from "./login";
import { run, runStream, type ProcessController, type RunStreamOpts } from "../util";
import { Utils } from "electrobun/bun";
import type {
  AppInfoPayload,
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
import { resolveLang, t, type Lang, type Vars } from "../shared/i18n";

export interface Emitter {
  log(level: LogLevel, text: string): void;
  status(stage: string, message: string): void;
  progress(p: DownloadProgressPayload): void;
}

export type LoginBrowserFn = (
  onStatus: (msg: string) => void,
  lang: Lang,
) => Promise<LoginResultPayload>;

const DEFAULT_OUTDIR = path.join(os.homedir(), "Music", "SoundCloud");

const APP_NAME = "SoundCloud Downloader";
const REPO_URL = "https://github.com/mikelgmh/soundcloud-dl";
const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;

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
    /** Dependencias ya resueltas (inyectables para tests). */
    initialDeps: Deps | null = null,
  ) {
    if (initialDeps) this.deps = initialDeps;
  }

  /** Lengua efectiva según la config guardada (o la del sistema). */
  private get lang(): Lang {
    return resolveLang(this.config.lang);
  }

  /** Traduce un mensaje con la lengua activa. */
  private msg(key: string, vars?: Vars): string {
    return t(this.lang, key, vars);
  }

  // ---- Estado ----

  async getStatus(): Promise<StatusSnapshot> {
    return {
      deps: await this.getDepsStatus(),
      config: this.toConfigPayload(this.config),
      likesCount: this.getLikesCount(),
      likesCachedAt: this.getLikesCachedAt(),
    };
  }

  /** Info de la app para la sección "Acerca de". La versión/canal se resuelve
   *  en el main (Updater.getLocalInfo) y se inyecta desde index.ts. */
  getAppInfo(opts?: { version?: string; channel?: string }): AppInfoPayload {
    return {
      name: APP_NAME,
      version: opts?.version || "dev",
      channel: opts?.channel || "dev",
      repo: REPO_URL,
      license: "MIT",
      licenseUrl: LICENSE_URL,
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
    this.emitter.status("deps", this.msg("deps.checking"));
    const deps = await ensureDeps({
      onStatus: (m) => this.emitter.status("deps", m),
      askInstall: async () => true,
      lang: this.lang,
    });
    this.deps = deps;
    const hasFfmpeg =
      deps.ffmpegDir !== null ||
      !!(Bun.which("ffmpeg") && Bun.which("ffprobe"));
    if (!hasFfmpeg) {
      throw new Error(this.msg("deps.installFfmpegError"));
    }
    this.emitter.log("success", this.msg("deps.ytdlpLog", { path: deps.ytdlp }));
    this.emitter.log("success", this.msg("deps.ffmpegLog", { path: deps.ffmpegDir ?? this.msg("tools.systemBinary") }));
    return this.getDepsStatus();
  }

  private async ensureDepsReady(): Promise<Deps> {
    if (this.deps) return this.deps;
    const ytdlp = Bun.which("yt-dlp") ?? path.join(BIN_DIR, "yt-dlp");
    if (!fs.existsSync(ytdlp)) {
      throw new Error(this.msg("deps.ytdlpUnavailable"));
    }
    const hasFfmpeg = !!(Bun.which("ffmpeg") && Bun.which("ffprobe"));
    if (!hasFfmpeg) {
      throw new Error(this.msg("deps.ffmpegUnavailable"));
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
      if (await checkYtDlpUpdate(deps.ytdlp, cb, latest.ytdlp, this.lang)) updated.push("yt-dlp");
    }
    if (versions.ffmpeg.hasUpdate) {
      if (await checkFfmpegUpdate(deps.ffmpegDir, cb, latest.ffmpeg, this.lang)) {
        updated.push("ffmpeg");
      }
    }

    const after = await computeVersions(deps, latest);
    this.versionsCache = after;
    for (const name of updated) {
      this.emitter.log("success", this.msg("deps.updated", { name }));
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
    if (patch.lang !== undefined) next.lang = patch.lang as 'es' | 'en';
    if (patch.skipExisting !== undefined) next.skipExisting = patch.skipExisting;
    if (patch.oauthToken === "") {
      delete next.oauthToken;
      this.emitter.log("info", this.msg("login.sessionClosed"));
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

  /** Bitrate por defecto según el formato (ninguno supera 256 kbps). */
  private defaultBitrate(format?: string): string {
    switch (format) {
      case 'm4a':
        return '256K';
      case 'mp3':
        return '256K';
      case 'opus':
        return '128K';
      case 'vorbis':
        return '192K';
      default:
        return '256K';
    }
  }

  private toConfigPayload(c: Config): ConfigPayload {
    return {
      ...c,
      outdir: c.outdir || DEFAULT_OUTDIR,
      quality: c.quality ?? '320K',
      format: c.format ?? 'm4a',
      bitrate: c.bitrate ?? c.quality ?? this.defaultBitrate(c.format),
      filenameTemplate: this.getFilenameTemplate(c),
      theme: c.theme ?? 'dark',
      lang: this.lang,
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
    this.emitter.status("login", this.msg("login.openingWindow"));
    const res = await this.loginBrowser(
      (m) => this.emitter.status("login", m),
      this.lang,
    );
    this.config.oauthToken = res.oauthToken;
    if (res.username) this.config.username = res.username;
    this.config.setupDone = true;
    saveConfig(this.config);
    this.emitter.log("success", this.msg("login.sessionSaved"));
    return res;
  }

  async loginWithToken(token: string): Promise<{ ok: boolean }> {
    if (!token || token.trim().length < 10) {
      throw new Error(this.msg("login.tokenInvalid"));
    }
    this.config.oauthToken = token.trim();
    this.config.setupDone = true;
    saveConfig(this.config);
    this.emitter.log("success", this.msg("login.tokenSaved"));
    return { ok: true };
  }

  /** Cierra la sesión: borra el token guardado y la sesión de la webview. */
  logout(): { ok: boolean } {
    delete this.config.oauthToken;
    this.config.setupDone = true;
    saveConfig(this.config);
    clearSoundCloudSession();
    this.emitter.log("info", this.msg("login.sessionClosed"));
    return { ok: true };
  }

  // ---- Favoritos ----

  async refreshLikes(): Promise<LikesResultPayload> {
    const deps = await this.ensureDepsReady();
    const username = this.config.username;
    const token = this.config.oauthToken;
    if (!username || !token) {
      throw new Error(this.msg("likes.loginFirst"));
    }
    this.emitter.status("likes", this.msg("likes.fetching"));
    const result = await fetchLikes({
      ytdlp: deps.ytdlp,
      ffmpegDir: deps.ffmpegDir,
      cookiesFile: writeCookiesFile(token),
      username,
    });
    saveLikesCache(username, result.tracks);
    if (result.tokenInvalid) {
      this.emitter.log("warn", this.msg("likes.tokenWarn"));
    }
    this.emitter.log("success", this.msg("likes.count", { count: result.tracks.length }));
    return { tracks: result.tracks, tokenInvalid: result.tokenInvalid, count: result.tracks.length };
  }

  getLikesCache(): { tracks: LikedTrack[]; cachedAt: number | null } {
    const username = this.config.username;
    if (!username) return { tracks: [], cachedAt: null };
    const cached = loadLikesCache(username);
    return cached ? { tracks: cached.tracks, cachedAt: cached.cachedAt } : { tracks: [], cachedAt: null };
  }

  /** "Stems" de los ficheros de audio presentes en la carpeta de salida. */
  private downloadedStems(): Set<string> {
    return scanAudioStems(this.config.outdir || DEFAULT_OUTDIR);
  }

  /** Cuenta cuántos favoritos ya están descargados y cuántos faltan, mirando
   *  los ficheros reales en disco (no solo el archivo de sincronización). */
  async getSyncStats(): Promise<SyncStatsPayload> {
    let tracks = this.getLikesCache().tracks;
    if (tracks.length === 0) {
      try {
        tracks = (await this.refreshLikes()).tracks;
      } catch {
        tracks = [];
      }
    }
    const template = this.getFilenameTemplate(this.config);
    const stems = this.downloadedStems();
    const downloaded = tracks.filter((t) =>
      stems.has(renderFilenameTemplate(template, t)),
    ).length;
    return {
      total: tracks.length,
      downloaded,
      missing: tracks.length - downloaded,
    };
  }

  /** Ids de las canciones descargadas (según los ficheros en disco). */
  getDownloadedIds(): { ids: string[] } {
    const template = this.getFilenameTemplate(this.config);
    const stems = this.downloadedStems();
    return {
      ids: this.getLikesCache()
        .tracks.filter((t) => stems.has(renderFilenameTemplate(template, t)))
        .map((t) => t.id),
    };
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
      this.msg("dl.allFavorites"),
    );
  }

  /** Re-descarga solo las favoritas cuyos ficheros faltan en la carpeta. */
  async downloadMissing(): Promise<{ ok: boolean; code: number }> {
    const config = this.requireDownloadConfig();
    const outDir = config.outdir || DEFAULT_OUTDIR;
    fs.mkdirSync(outDir, { recursive: true });
    const tracks = this.getLikesCache().tracks;
    const template = this.getFilenameTemplate(config);
    const stems = scanAudioStems(outDir);
    const missing = tracks.filter(
      (t) => !stems.has(renderFilenameTemplate(template, t)),
    );
    if (missing.length === 0) {
      throw new Error(this.msg("dl.nothingMissing"));
    }
    // Los ids faltantes pueden seguir en el archivo de sincronización (p. ej.
    // si el usuario borró los ficheros); se purgan para que yt-dlp los
    // vuelva a descargar en vez de saltárselos.
    purgeArchiveIds(missing.map((t) => t.id));
    return this.runDownload(
      buildDownloadArgs({
        ...this.downloadOpts(config, outDir),
        urls: missing.map((t) => t.url),
      }),
      this.msg("dl.downloadingMissing", { count: missing.length }),
    );
  }

  async downloadTrack(url: string): Promise<{ ok: boolean; code: number }> {
    const config = this.requireDownloadConfig();
    const outDir = config.outdir || DEFAULT_OUTDIR;
    fs.mkdirSync(outDir, { recursive: true });
    this.emitter.log("info", this.msg("dl.singleTrack", { url }));
    return this.runDownload(
      buildDownloadArgs({ ...this.downloadOpts(config, outDir), url }),
      this.msg("dl.downloadingTrack"),
    );
  }

  /** Descarga cualquier enlace de SoundCloud pegado por el usuario. */
  async downloadUrl(url: string): Promise<{ ok: boolean; code: number }> {
    const trimmed = url.trim();
    if (!/^https?:\/\/(www\.|m\.|on\.)?soundcloud\.com\//i.test(trimmed)) {
      throw new Error(this.msg("dl.badUrl"));
    }
    return this.downloadTrack(trimmed);
  }

  /** Abre en el explorador la carpeta con el fichero de la canción
   *  seleccionado (para la cola de descargas). */
  showDownloadedItem(params: { id: string; title: string }): { ok: boolean } {
    const config = this.requireDownloadConfig();
    const outDir = config.outdir || DEFAULT_OUTDIR;
    const cached = this.getLikesCache().tracks.find((t) => t.id === params.id);
    const track = cached ?? { id: params.id, title: params.title, url: "", index: 0 };
    const file = findTrackFile(outDir, this.getFilenameTemplate(config), track);
    if (!file) return { ok: false };
    try {
      Utils.showItemInFolder(file);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  /** Comprueba si la cuenta puede descargar en alta calidad. Usa yt-dlp (que
   *  pasa DataDome, igual que las descargas) sobre varios favoritos y mira si
   *  alguno ofrece formatos >= 256 kbps / Premium. */
  async checkStreamingQuality(): Promise<{
    checked: boolean;
    highQuality: boolean;
    error?: string;
  }> {
    if (!this.config.oauthToken) {
      return { checked: false, highQuality: false, error: "sin sesión" };
    }
    const trackUrls = this.getLikesCache()
      .tracks.slice(0, 3)
      .map((t) => t.url)
      .filter(Boolean);
    if (trackUrls.length === 0) {
      return { checked: false, highQuality: false, error: "Sin favoritos" };
    }
    try {
      const ytdlp =
        this.deps?.ytdlp ?? Bun.which("yt-dlp") ?? path.join(BIN_DIR, "yt-dlp");
      if (!fs.existsSync(ytdlp)) {
        throw new Error("yt-dlp no está instalado");
      }
      const cookiesFile = writeCookiesFile(this.config.oauthToken);
      const { code, stdout, stderr } = await run(
        [
          ytdlp,
          "--cookies",
          cookiesFile,
          "--impersonate",
          "chrome",
          "-j",
          ...trackUrls,
        ],
        { capture: true },
      );
      if (code !== 0) {
        throw new Error(stderr.trim().slice(-200) || `yt-dlp ${code}`);
      }
      let highQuality = false;
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const info = JSON.parse(trimmed);
          const formats: {
            abr?: number;
            format_note?: string;
            format_id?: string;
          }[] = info?.formats ?? [];
          if (
            formats.some(
              (f) =>
                (f?.abr ?? 0) >= 256 ||
                /premium|256k/i.test(
                  `${f?.format_note ?? ""} ${f?.format_id ?? ""}`,
                ),
            )
          ) {
            highQuality = true;
            break;
          }
        } catch {
          // línea no JSON: se ignora
        }
      }
      return { checked: true, highQuality };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitter.log("warn", this.msg("quality.checkLog", { error: message }));
      return { checked: false, highQuality: false, error: message };
    }
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
      throw new Error(this.msg("config.badJson"));
    }
    const next: Config = { ...this.config };
    if (parsed.outdir) next.outdir = parsed.outdir;
    if (parsed.format) next.format = parsed.format;
    if (parsed.bitrate) next.bitrate = parsed.bitrate;
    if (parsed.filenameTemplate) next.filenameTemplate = parsed.filenameTemplate;
    if (parsed.skipExisting !== undefined) next.skipExisting = parsed.skipExisting;
    if (parsed.lang !== undefined) next.lang = parsed.lang;
    next.setupDone = true;
    this.config = next;
    saveConfig(next);
    this.emitter.log("success", this.msg("config.imported"));
    return { ok: true };
  }

  /** Historial reciente de descargas. */
  getHistory(): { items: HistoryItemPayload[] } {
    return { items: readHistory(30) };
  }

  /** Archivos que se borrarían con la limpieza (sin borrarlos). */
  private computeCleanupCandidates(): string[] {
    const config = this.requireDownloadConfig();
    const outDir = config.outdir || DEFAULT_OUTDIR;
    const favIds = new Set(this.getLikesCache().tracks.map((t) => t.id));
    const archive = readArchiveIds();
    const candidates: string[] = [];
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
            candidates.push(p);
          }
        }
      }
    };
    if (fs.existsSync(outDir)) walk(outDir);
    return candidates;
  }

  /** Cuántos archivos se borrarían con la limpieza (para la modal). */
  cleanupPreview(): { count: number } {
    return { count: this.computeCleanupCandidates().length };
  }

  /** Borra archivos descargados que ya no están en favoritos. */
  async cleanupNonFavorites(): Promise<{ removed: string[] }> {
    const removed: string[] = [];
    for (const p of this.computeCleanupCandidates()) {
      try {
        fs.unlinkSync(p);
        removed.push(p);
      } catch {
        // seguir
      }
    }
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
    if (!q) throw new Error(this.msg("search.emptyQuery"));
    const config = this.requireDownloadConfig();
    const deps = await this.ensureDepsReady();
    this.emitter.status("likes", this.msg("search.searching", { query: q }));
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
    if (clean.length === 0) throw new Error(this.msg("dl.noTracks"));
    const config = this.requireDownloadConfig();
    const outDir = config.outdir || DEFAULT_OUTDIR;
    fs.mkdirSync(outDir, { recursive: true });
    return this.runDownload(
      buildDownloadArgs({ ...this.downloadOpts(config, outDir), urls: clean }),
      this.msg("dl.downloadingUrls", { count: clean.length }),
    );
  }

  cancelDownload(): { ok: boolean } {
    if (this.abort) {
      this.abort.abort();
      this.emitter.log("warn", this.msg("dl.cancelled"));
    }
    return { ok: true };
  }

  pauseDownload(): { ok: boolean } {
    this.controller?.pause();
    this.emitter.log("info", this.msg("dl.paused"));
    return { ok: true };
  }

  resumeDownload(): { ok: boolean } {
    this.controller?.resume();
    this.emitter.log("info", this.msg("dl.resumed"));
    return { ok: true };
  }

  private requireDownloadConfig(): Config {
    const { username, oauthToken, outdir } = this.config;
    if (!username || !oauthToken) {
      throw new Error(this.msg("dl.requireLogin"));
    }
    return { ...this.config, outdir: outdir || DEFAULT_OUTDIR };
  }

  private downloadOpts(config: Config, outDir: string) {
    return {
      ytdlp: "",
      ffmpegDir: null as string | null,
      outDir,
      format: config.format ?? "m4a",
      bitrate: config.bitrate ?? config.quality ?? this.defaultBitrate(config.format),
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
        code === 0
          ? this.msg("dl.completed")
          : this.msg("dl.finishedCode", { code }),
      );

      // Historial + notificación del sistema al terminar.
      const target = this.downloadUrlTarget(args);
      appendHistory({
        ts: Date.now(),
        target,
        format: this.config.format ?? "m4a",
        ok: code === 0,
      });
      if (code === 0) {
        try {
          Utils.showNotification({
            title: this.msg("dl.notificationTitle"),
            body:
              target === "favoritos"
                ? this.msg("dl.notificationFavs")
                : this.msg("dl.notificationTrack", { target }),
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
