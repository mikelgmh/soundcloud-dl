import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Cuando el código está empaquetado por electrobun, vive dentro del build de
// la app (que se regenera en cada build). En ese caso los datos y binarios se
// guardan en una ruta estable del usuario para no descargarlos cada vez.
const isAppBundle = (() => {
  try {
    return import.meta.dir.includes(`${path.sep}Resources${path.sep}app`);
  } catch {
    return false;
  }
})();

export const DATA_ROOT = isAppBundle
  ? process.env.SOUNDCLOUD_DOWNLOADER_DIR ||
    path.join(os.homedir(), 'Library', 'Application Support', 'SoundCloudDownloader')
  : path.resolve(import.meta.dir, '..');

export const SND_DIR = isAppBundle ? DATA_ROOT : path.join(DATA_ROOT, '.snd');
export const BIN_DIR = isAppBundle
  ? path.join(DATA_ROOT, 'bin')
  : path.join(DATA_ROOT, '.bin');
export const PROFILE_DIR = path.join(SND_DIR, 'profile');
export const COOKIES_FILE = path.join(SND_DIR, 'cookies.txt');
export const ARCHIVE_FILE = path.join(SND_DIR, 'archive.txt');
export const HISTORY_FILE = path.join(SND_DIR, 'history.jsonl');

export interface HistoryItem {
  ts: number;
  target: string;
  format: string;
  ok: boolean;
}

export interface Config {
  setupDone?: boolean;
  oauthToken?: string;
  username?: string;
  outdir?: string;
  /** Bitrate MP3 (legacy). */
  quality?: string;
  /** Formato de salida: mp3 | m4a | opus | flac | wav | vorbis | original */
  format?: string;
  bitrate?: string;
  filenameTemplate?: string;
  skipExisting?: boolean;
}

const configPath = () => path.join(SND_DIR, 'config.json');

export function loadConfig(): Config {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Config;
  } catch {
    return {};
  }
}

export function saveConfig(config: Config): void {
  fs.mkdirSync(SND_DIR, { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function writeCookiesFile(oauthToken: string): string {
  fs.mkdirSync(SND_DIR, { recursive: true });
  const content = [
    '# Netscape HTTP Cookie File',
    `.soundcloud.com\tTRUE\t/\tFALSE\t0\toauth_token\t${oauthToken}`,
    '',
  ].join('\n');
  fs.writeFileSync(COOKIES_FILE, content, { mode: 0o600 });
  return COOKIES_FILE;
}

export interface LikedTrack {
  id: string;
  title: string;
  url: string;
  uploader?: string;
  index: number;
}

const likesCachePath = (username: string) =>
  path.join(SND_DIR, `likes-${username.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);

export function saveLikesCache(username: string, tracks: LikedTrack[]): void {
  fs.mkdirSync(SND_DIR, { recursive: true });
  fs.writeFileSync(
    likesCachePath(username),
    JSON.stringify({ cachedAt: Date.now(), tracks }, null, 2),
    { mode: 0o600 },
  );
}

export function loadLikesCache(
  username: string,
): { cachedAt: number; tracks: LikedTrack[] } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(likesCachePath(username), 'utf8'));
    if (raw && Array.isArray(raw.tracks)) return raw;
    return null;
  } catch {
    return null;
  }
}

/** Ids de canciones ya descargadas según el archivo de sincronización. */
export function readArchiveIds(): Set<string> {
  const ids = new Set<string>();
  try {
    const text = fs.readFileSync(ARCHIVE_FILE, 'utf8');
    for (const line of text.split('\n')) {
      const id = line.trim().split(/\s+/).pop();
      if (id) ids.add(id);
    }
  } catch {
    // sin archivo todavía
  }
  return ids;
}

export function appendHistory(item: HistoryItem): void {
  try {
    fs.mkdirSync(SND_DIR, { recursive: true });
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(item) + '\n');
  } catch {
    // ignorar
  }
}

export function readHistory(limit = 30): HistoryItem[] {
  try {
    const text = fs.readFileSync(HISTORY_FILE, 'utf8');
    const items = text
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as HistoryItem;
        } catch {
          return null;
        }
      })
      .filter((x): x is HistoryItem => x !== null);
    return items.slice(-limit).reverse();
  } catch {
    return [];
  }
}
