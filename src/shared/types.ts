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
  quality?: string;
  skipExisting?: boolean;
  hasToken: boolean;
}

export interface LikedTrackPayload {
  id: string;
  title: string;
  url: string;
  uploader?: string;
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

export interface LikesResultPayload {
  tracks: LikedTrackPayload[];
  tokenInvalid: boolean;
  count: number;
}

export interface UpdateResultPayload {
  updated: string[];
  versions: { ytdlp: DepVersionInfo; ffmpeg: DepVersionInfo };
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
      getConfig: { params: {}; response: ConfigPayload };
      saveConfig: { params: Partial<ConfigPayload>; response: ConfigPayload };
      login: { params: {}; response: { oauthToken: string; username?: string } };
      loginWithToken: { params: { token: string }; response: { ok: boolean } };
      refreshLikes: { params: {}; response: LikesResultPayload };
      getLikesCache: {
        params: {};
        response: { tracks: LikedTrackPayload[]; cachedAt: number | null };
      };
      downloadAll: { params: {}; response: { ok: boolean; code: number } };
      downloadTrack: { params: { url: string }; response: { ok: boolean; code: number } };
      cancelDownload: { params: {}; response: { ok: boolean } };
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
