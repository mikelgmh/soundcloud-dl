import type { RPCSchema } from "electrobun";

export type LogLevel = "info" | "success" | "warn" | "error";

export interface DepVersionInfo {
  current: string | null;
  latest: string | null;
  hasUpdate: boolean;
}

export interface DepsStatus {
  ytdlpPresent: boolean;
  ffmpegPresent: boolean;
  ytdlpPath: string | null;
  ffmpegDir: string | null;
  ready: boolean;
  ytdlpVersion: DepVersionInfo;
  ffmpegVersion: DepVersionInfo;
}

export interface ConfigPayload {
  setupDone?: boolean;
  oauthToken?: string;
  username?: string;
  outdir?: string;
  /** Bitrate MP3 (legacy, antes de format/bitrate). */
  quality?: string;
  /** Formato de salida: mp3 | m4a | opus | flac | wav | vorbis | original */
  format?: string;
  /** Bitrate para formatos con pérdida (320K, 192K...). */
  bitrate?: string;
  /** Plantilla del nombre de archivo (sin extensión). */
  filenameTemplate?: string;
  /** Tema: 'dark' | 'light' */
  theme?: string;
  /** Idioma de la interfaz: 'es' | 'en' (por defecto se detecta del sistema). */
  lang?: string;
  skipExisting?: boolean;
  hasToken: boolean;
}

export interface LikedTrackPayload {
  id: string;
  title: string;
  url: string;
  uploader?: string;
  /** URL de la portada de la canción. */
  thumbnail?: string;
  index: number;
}

export interface DownloadProgressPayload {
  current: number;
  total: number;
  percent: number;
  eta: string;
  title: string;
}

export interface StatusMessagePayload {
  stage: string;
  message: string;
}

export interface LogMessagePayload {
  level: LogLevel;
  text: string;
}

export interface StatusSnapshot {
  deps: DepsStatus;
  config: ConfigPayload;
  likesCount: number | null;
  likesCachedAt: number | null;
}

export interface LoginResultPayload {
  oauthToken: string;
  username?: string;
}

export interface SyncStatsPayload {
  total: number;
  downloaded: number;
  missing: number;
}

export interface HistoryItemPayload {
  ts: number;
  target: string;
  format: string;
  ok: boolean;
}

export interface LikesResultPayload {
  tracks: LikedTrackPayload[];
  tokenInvalid: boolean;
  count: number;
}

export interface UpdateResultPayload {
  updated: string[];
  versions: { ytdlp: DepVersionInfo; ffmpeg: DepVersionInfo };
}

export interface AppInfoPayload {
  name: string;
  version: string;
  channel: string;
  repo: string;
  license: string;
  licenseUrl: string;
}

export type AppRPCSchema = {
  // Funciones que ejecuta el proceso main (llamadas desde la UI)
  bun: RPCSchema<{
    requests: {
      getStatus: { params: {}; response: StatusSnapshot };
      checkDeps: { params: {}; response: DepsStatus };
      installDeps: { params: {}; response: DepsStatus };
      checkForUpdates: { params: {}; response: UpdateResultPayload };
      checkAppUpdate: {
        params: {};
        response: { updateAvailable: boolean; updateReady: boolean; version?: string };
      };
      applyAppUpdate: { params: {}; response: { ok: boolean } };
      getConfig: { params: {}; response: ConfigPayload };
      getAppInfo: { params: {}; response: AppInfoPayload };
      openExternal: { params: { url: string }; response: { ok: boolean } };
      saveConfig: { params: Partial<ConfigPayload>; response: ConfigPayload };
      login: { params: {}; response: LoginResultPayload };
      loginWithToken: { params: { token: string }; response: { ok: boolean } };
      logout: { params: {}; response: { ok: boolean } };
      selectFolder: { params: {}; response: { path: string | null } };
      refreshLikes: { params: {}; response: LikesResultPayload };
      getLikesCache: {
        params: {};
        response: { tracks: LikedTrackPayload[]; cachedAt: number | null };
      };
      getSyncStats: { params: {}; response: SyncStatsPayload };
      getDownloadedIds: { params: {}; response: { ids: string[] } };
      checkStreamingQuality: {
        params: {};
        response: { checked: boolean; highQuality: boolean; error?: string };
      };
      downloadUrl: { params: { url: string }; response: { ok: boolean; code: number } };
      exportConfig: { params: {}; response: { json: string } };
      importConfig: { params: { json: string }; response: { ok: boolean } };
      getHistory: { params: {}; response: { items: HistoryItemPayload[] } };
      cleanupNonFavorites: { params: {}; response: { removed: string[] } };
      cleanupPreview: { params: {}; response: { count: number } };
      getPlaylists: {
        params: {};
        response: {
          playlists: {
            id: string;
            title: string;
            url: string;
            uploader?: string;
            count?: number;
            thumbnail?: string;
          }[];
        };
      };
      getPlaylistTracks: {
        params: { url: string };
        response: { tracks: LikedTrackPayload[]; tokenInvalid: boolean };
      };
      searchSoundcloud: {
        params: { query: string };
        response: { tracks: LikedTrackPayload[] };
      };
      downloadUrls: {
        params: { urls: string[] };
        response: { ok: boolean; code: number };
      };
      downloadAll: { params: {}; response: { ok: boolean; code: number } };
      downloadMissing: { params: {}; response: { ok: boolean; code: number } };
      downloadTrack: { params: { url: string }; response: { ok: boolean; code: number } };
      showDownloadedItem: {
        params: { id: string; title: string };
        response: { ok: boolean };
      };
      cancelDownload: { params: {}; response: { ok: boolean } };
      pauseDownload: { params: {}; response: { ok: boolean } };
      resumeDownload: { params: {}; response: { ok: boolean } };
    };
    messages: {};
  }>;
  // Funciones del lado de la vista (mensajes que main envía a la UI)
  webview: RPCSchema<{
    requests: {};
    messages: {
      log: LogMessagePayload;
      status: StatusMessagePayload;
      downloadProgress: DownloadProgressPayload;
    };
  }>;
};
