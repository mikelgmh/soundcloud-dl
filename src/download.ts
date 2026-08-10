import path from 'node:path';
import fs from 'node:fs';
import { run, runStream } from './util';
import type { LikedTrack } from './store';
import { SND_DIR } from './store';
import { resolveLang, t, type Lang } from './shared/i18n';

export interface Session {
  cookiesFile: string;
  username: string;
}

export interface CountOptions extends Session {
  ytdlp: string;
  ffmpegDir?: string | null;
}

export interface DownloadOptions extends Session {
  ytdlp: string;
  ffmpegDir?: string | null;
  outDir: string;
  /** Formato de salida: mp3 | m4a | opus | flac | wav | vorbis | original */
  format?: string;
  /** Bitrate para formatos con pérdida (320K, 192K...). */
  bitrate?: string;
  /** Bitrate MP3 (legacy). */
  quality?: string;
  /** Plantilla del nombre de archivo (sin extensión). */
  filenameTemplate?: string;
  skipExisting?: boolean;
  /** URL concreta a descargar (si no, la lista de favoritos). */
  url?: string;
  /** Varias URLs (p.ej. una colección). */
  urls?: string[];
  /** Archivo de sincronización de yt-dlp (registra las ya descargadas). */
  archiveFile?: string;
}

export const DEFAULT_FILENAME_TEMPLATE = '%(title)s - %(artist)s';

const LOSSLESS_FORMATS = ['flac', 'wav', 'alac'];

// Bitrate por defecto según el formato. AAC/Opus/Vorbis no superan lo que
// aporta la fuente (AAC 256k); MP3 es menos eficiente y necesita ~320k para
// igualar esa calidad.
const DEFAULT_BITRATE: Record<string, string> = {
  m4a: '256K',
  mp3: '320K',
  opus: '128K',
  vorbis: '192K',
};

export interface FetchResult {
  tracks: LikedTrack[];
  tokenInvalid: boolean;
}

const likesUrl = (username: string) => `https://soundcloud.com/${username}/likes`;

// Autenticación vía archivo de cookies (no se expone el token en `ps`).
function authArgs(opts: Session): string[] {
  return ['--cookies', opts.cookiesFile];
}

function ffmpegLocationArgs(opts: { ffmpegDir?: string | null }): string[] {
  return opts.ffmpegDir ? ['--ffmpeg-location', opts.ffmpegDir] : [];
}

// Medidas anti-baneo: descarga estrictamente secuencial (1 fragmento a la vez),
// pausas aleatorias entre canciones, pocos reintentos y con impersonación de
// Chrome. Con skipExisting se omiten las canciones ya descargadas.
function safetyArgs(opts: { skipExisting?: boolean }): string[] {
  const args = [
    '--impersonate', 'chrome',
    '--continue',
    '--ignore-errors',
    '--retries', '3',
    '--retry-sleep', '5',
    '--concurrent-fragments', '1',
    '--sleep-interval', '3',
    '--max-sleep-interval', '7',
  ];
  if (opts.skipExisting !== false) args.push('--no-overwrites');
  return args;
}

export async function fetchLikes(opts: CountOptions): Promise<FetchResult> {
  const res = await fetchFlatEntries(likesUrl(opts.username), opts);
  return { tracks: res.entries, tokenInvalid: res.tokenInvalid };
}

// ---- Likes vía API v2 (trae portadas reales) ----

export const API_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

let apiClientId: string | null = null;
// Respaldo si el scraping falla (client_ids rotan pero duran bastante).
const FALLBACK_CLIENT_ID = 'TwElDfIgW9RpAzLMUSy9g1VvI2Kao7my';
const CLIENT_ID_FILE = path.join(SND_DIR, 'client_id.txt');

function persistClientId(cid: string): void {
  try {
    fs.mkdirSync(SND_DIR, { recursive: true });
    fs.writeFileSync(CLIENT_ID_FILE, cid, { mode: 0o600 });
  } catch {
    // no crítico
  }
}

/** Obtiene el client_id de SoundCloud: caché en disco, luego scraping web. */
export async function fetchSoundCloudClientId(): Promise<string> {
  if (apiClientId) return apiClientId;
  try {
    const cached = fs.readFileSync(CLIENT_ID_FILE, 'utf8').trim();
    if (cached) {
      apiClientId = cached;
      return cached;
    }
  } catch {
    // sin caché todavía
  }
  try {
    const res = await fetch('https://soundcloud.com/', { headers: { 'User-Agent': API_UA } });
    const html = await res.text();
    let cid = html.match(/client_id["']?\s*[:=]\s*["']([0-9a-zA-Z]{32})["']/)?.[1] ?? null;
    if (!cid) {
      const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
      for (const src of scripts) {
        try {
          const u = src.startsWith('http') ? src : `https://soundcloud.com${src}`;
          const r = await fetch(u, { headers: { 'User-Agent': API_UA } });
          const m = (await r.text()).match(/client_id\s*:\s*"([0-9a-zA-Z]{32})"/);
          if (m) {
            cid = m[1];
            break;
          }
        } catch {
          // siguiente script
        }
      }
    }
    if (cid) {
      apiClientId = cid;
      persistClientId(cid);
      return cid;
    }
  } catch {
    // se cae al respaldo
  }
  apiClientId = FALLBACK_CLIENT_ID;
  return FALLBACK_CLIENT_ID;
}

/** Obtiene los favoritos con portada real (artwork_url) vía la API v2. */
/** Resuelve el id de un usuario de SoundCloud desde su permalink. */
export async function resolveUserId(
  username: string,
  cid: string,
  headers: Record<string, string>,
): Promise<string | null> {
  const url = `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(
    `https://soundcloud.com/${username}`,
  )}&client_id=${cid}`;
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  const j = await res.json();
  return j?.id ? String(j.id) : null;
}

export async function fetchLikesViaApi(opts: {
  username: string;
}): Promise<LikedTrack[]> {
  const cid = await fetchSoundCloudClientId();
  // No se envía el token de OAuth: el capturado en el login puede no ser
  // válido para la API v2 (401) e invalidaría la petición entera. Los
  // favoritos de un usuario son públicos: basta con el id + client_id.
  const headers: Record<string, string> = {
    'User-Agent': API_UA,
  };
  const uid = await resolveUserId(opts.username, cid, headers);
  if (!uid) throw new Error('SoundCloud API sin usuario');

  const tracks: LikedTrack[] = [];
  let url = `https://api-v2.soundcloud.com/users/${uid}/likes?limit=200&client_id=${cid}`;
  while (url) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`SoundCloud API ${res.status}`);
    const j = await res.json();
    const items: any[] = (j?.collection ?? []).map((c: any) => c?.track || c);
    for (const t of items) {
      if (!t || t.id == null) continue;
      tracks.push({
        id: String(t.id),
        title: t.title ?? '',
        url: t.permalink_url ?? t.uri ?? '',
        uploader: t.user?.username,
        artist: t.user?.username,
        thumbnail: t.artwork_url,
        index: tracks.length,
      });
    }
    url = j?.next_href
      ? String(j.next_href) + (String(j.next_href).includes('client_id') ? '' : `&client_id=${cid}`)
      : '';
  }
  return tracks;
}

/** Busca canciones en la API v2 de SoundCloud (con portadas reales). */
export async function searchTracksViaApi(
  query: string,
  oauthToken?: string,
): Promise<LikedTrack[]> {
  const cid = await fetchSoundCloudClientId();
  const headers: Record<string, string> = { 'User-Agent': API_UA };
  if (oauthToken) headers.Authorization = `OAuth ${oauthToken}`;
  const url = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(
    query,
  )}&limit=20&client_id=${cid}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`SoundCloud API ${res.status}`);
  const j = await res.json();
  const items: any[] = j?.collection ?? [];
  return items
    .filter((t: any) => t?.id != null && t.kind === 'track')
    .map((t: any, i: number) => ({
      id: String(t.id),
      title: t.title ?? '',
      url: t.permalink_url ?? t.uri ?? '',
      uploader: t.user?.username,
      artist: t.user?.username,
      thumbnail: t.artwork_url,
      index: i,
    }));
}

/** Lista las playlists/sets públicos del usuario vía API v2, con portada
 * (la propia o, si no tiene, la de su primera canción, como hace SC). */
export async function fetchPlaylistsViaApi(opts: {
  username: string;
}): Promise<
  { id: string; title: string; url: string; uploader?: string; count?: number; thumbnail?: string }[]
> {
  const cid = await fetchSoundCloudClientId();
  const headers: Record<string, string> = {
    'User-Agent': API_UA,
  };
  const uid = await resolveUserId(opts.username, cid, headers);
  if (!uid) throw new Error('SoundCloud API sin usuario');

  const out: {
    id: string;
    title: string;
    url: string;
    uploader?: string;
    count?: number;
    thumbnail?: string;
  }[] = [];
  let url = `https://api-v2.soundcloud.com/users/${uid}/playlists?limit=200&client_id=${cid}`;
  while (url) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`SoundCloud API ${res.status}`);
    const j = await res.json();
    for (const p of j?.collection ?? []) {
      if (!p || p.kind !== 'playlist' || p.id == null) continue;
      const firstTrack = (p.tracks ?? []).find((t: any) => t?.artwork_url);
      out.push({
        id: String(p.id),
        title: p.title ?? '',
        url: p.permalink_url ?? p.uri ?? '',
        uploader: p.user?.username,
        count: p.track_count ?? p.tracks?.length,
        thumbnail: p.artwork_url ?? firstTrack?.artwork_url,
      });
    }
    url = j?.next_href
      ? String(j.next_href) + (String(j.next_href).includes('client_id') ? '' : `&client_id=${cid}`)
      : '';
  }
  return out;
}

/** Lista las entradas planas (favoritos, sets o canciones de una playlist). */
export async function fetchFlatEntries(
  url: string,
  opts: CountOptions,
  mode: 'flat' | 'full' = 'flat',
): Promise<{ entries: LikedTrack[]; tokenInvalid: boolean }> {
  const args = [
    opts.ytdlp,
    ...authArgs(opts),
    ...ffmpegLocationArgs(opts),
    '--impersonate', 'chrome',
    // En modo 'full' se resuelve cada canción (necesario para obtener el
    // título en los sets; en modo plano yt-dlp lo descarta).
    ...(mode === 'flat' ? ['--flat-playlist'] : []),
    '--dump-json',
    url,
  ];
  const { code, stdout, stderr } = await run(args, { capture: true });
  if (code !== 0) {
    const tail = stderr.split('\n').slice(-6).join('\n');
    throw new Error(t(resolveLang(), 'dl.listFailed', { tail }));
  }

  const { entries, tokenInvalid } = parseEntriesOutput(stdout, stderr);
  return { entries, tokenInvalid };
}

/** Parsea la salida JSON de yt-dlp (--dump-json) en entradas planas. */
export function parseEntriesOutput(
  stdout: string,
  stderr: string,
): { entries: LikedTrack[]; tokenInvalid: boolean } {
  const entries: LikedTrack[] = [];
  stdout
    .split('\n')
    .filter((l) => l.trim() !== '')
    .forEach((line, i) => {
      try {
        const j = JSON.parse(line);
        if (j && (j.url || j.webpage_url)) {
          // Preferimos la página (webpage_url) a la URL del stream/API.
          const pageUrl = j.webpage_url ?? j.url;
          const m = String(pageUrl).match(/soundcloud\.com\/([^/]+)\//);
          entries.push({
            id: String(j.id ?? i),
            title: j.title ?? `Elemento ${i}`,
            url: pageUrl,
            uploader: j.uploader ?? m?.[1],
            artist: j.artist ?? j.artists?.[0],
            thumbnail: j.thumbnail ?? j.artwork_url,
            index: i,
          });
        }
      } catch {
        // entrada no válida, se ignora
      }
    });

  const tokenInvalid = /invalid|unable to login/i.test(stderr);
  return { entries, tokenInvalid };
}

export function buildDownloadArgs(opts: DownloadOptions): string[] {
  const format = opts.format ?? 'm4a';
  const bitrate = opts.bitrate ?? opts.quality ?? DEFAULT_BITRATE[format] ?? '256K';
  const lossless = LOSSLESS_FORMATS.includes(format);
  const template = opts.filenameTemplate ?? DEFAULT_FILENAME_TEMPLATE;

  const args = [
    opts.ytdlp,
    ...authArgs(opts),
    ...ffmpegLocationArgs(opts),
    ...safetyArgs({ skipExisting: opts.skipExisting }),
  ];

  if (opts.archiveFile) {
    args.push('--download-archive', opts.archiveFile);
  }

  args.push('-f', 'bestaudio/best');

  // 'original' descarga el mejor audio sin convertir.
  if (format !== 'original') {
    args.push('-x', '--audio-format', format);
    if (!lossless) {
      // A máxima calidad (256K) en M4A el stream ya es AAC 256k: se copia tal
      // cual sin re-codificar (evita pérdida y trabajo inútil). Solo se
      // re-codifica si se pide un bitrate inferior para ahorrar espacio.
      const keepSource = format === 'm4a' && bitrate === '256K';
      if (!keepSource) args.push('--audio-quality', bitrate);
    }
  }

  args.push(
    '--embed-metadata',
    '--embed-thumbnail',
    '--windows-filenames',
    '-o', path.join(opts.outDir, `${template}.%(ext)s`),
  );
  if (opts.urls && opts.urls.length) {
    args.push(...opts.urls);
  } else {
    args.push(opts.url ?? likesUrl(opts.username));
  }
  return args;
}

export async function downloadLikes(opts: DownloadOptions) {
  return run(buildDownloadArgs(opts));
}

/** Igual que downloadLikes pero emite cada línea de salida (para la GUI). */
export async function downloadLikesStream(
  opts: DownloadOptions,
  onLine: (line: string) => void,
  signal?: AbortSignal,
) {
  return runStream(buildDownloadArgs(opts), {
    onStdout: onLine,
    onStderr: onLine,
    signal,
  });
}

// ---- Detección de archivos descargados (sincronización bidireccional) ----

const COMMON_AUDIO_EXTS = [
  'mp3', 'm4a', 'opus', 'ogg', 'flac', 'wav', 'aac', 'm4b', 'm4p', 'webm', 'wma',
];

/** Sustituye las variables de la plantilla y saneza cada segmento de ruta
 *  igual que yt-dlp (--windows-filenames), para comparar con el disco. */
export function renderFilenameTemplate(
  template: string,
  track: { id: string; title: string; uploader?: string; artist?: string; index?: number },
): string {
  const vars: Record<string, string> = {
    title: track.title ?? '',
    uploader: track.uploader ?? '',
    artist: track.artist ?? track.uploader ?? '',
    id: String(track.id ?? ''),
    album: '',
    ext: '',
    playlist_index: String(track.index ?? 0),
  };
  const rendered = template.replace(
    /%(?:\(([^)]+)\))?s/g,
    (_m, key: string) => vars[key] ?? '',
  );
  return rendered
    .split('/')
    .map((seg) =>
      seg.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[.\s]+$/g, '').trim(),
    )
    .join('/')
    .replace(/^[.\s]+/, '');
}

/** Escanea la carpeta de salida y devuelve los "stems" (ruta relativa sin
 *  extensión) de los ficheros de audio, normalizados con '/'. */
export function scanAudioStems(outDir: string): Set<string> {
  return scanDownloadedAudio(outDir).stems;
}

/** Escanea la carpeta de salida y devuelve los stems de los ficheros de audio
 *  y los ids de pista que aparecen en sus nombres ([<id>]). */
export function scanDownloadedAudio(outDir: string): {
  stems: Set<string>;
  ids: Set<string>;
} {
  const stems = new Set<string>();
  const ids = new Set<string>();
  const walk = (dir: string, rel = ''): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, relPath);
      else if (e.isFile()) {
        const ext = path.extname(e.name).slice(1).toLowerCase();
        if (COMMON_AUDIO_EXTS.includes(ext)) {
          stems.add(relPath.slice(0, -(ext.length + 1)));
          const idm = e.name.match(/\[(\d+)\]/);
          if (idm) ids.add(idm[1]);
        }
      }
    }
  };
  walk(outDir);
  return { stems, ids };
}

/** ¿Hay un fichero en disco que corresponda a la pista? Estrategias:
 *  1. el id aparece en el nombre ([<id>]);
 *  2. el stem coincide con la plantilla renderizada;
 *  3. un fichero empieza por el título de la pista (cubre plantillas antiguas
 *     sin id y con artist != uploader). */
export function trackHasDownloadedFile(
  stems: Set<string>,
  ids: Set<string>,
  template: string,
  track: {
    id: string;
    title: string;
    uploader?: string;
    artist?: string;
    index?: number;
  },
): boolean {
  if (ids.has(track.id)) return true;
  if (stems.has(renderFilenameTemplate(template, track))) return true;
  const title = track.title?.trim();
  if (title) {
    for (const s of stems) {
      if (s === title) return true;
      const next = s.charAt(title.length);
      if (
        s.startsWith(title) &&
        (next === '-' || next === '_' || next === ' ' || next === '')
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Busca el fichero real de una pista según la plantilla o su id; devuelve la
 *  ruta completa o null si no existe. */
export function findTrackFile(
  outDir: string,
  template: string,
  track: { id: string; title: string; uploader?: string; artist?: string; index?: number },
): string | null {
  const base = renderFilenameTemplate(template, track);
  for (const ext of COMMON_AUDIO_EXTS) {
    const p = path.join(outDir, `${base}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  // Fallback por id en el nombre del fichero (plantillas sin id).
  const byId = findFileByTrackId(outDir, track.id);
  if (byId) return byId;
  // Fallback por prefijo del título (cubre plantillas antiguas sin id y
  // artist != uploader).
  const title = track.title?.trim();
  if (title) {
    const files = scanDownloadedAudioWithPaths(outDir);
    for (const f of files) {
      const stem = f.slice(0, -(path.extname(f).length));
      const base = path.basename(stem);
      if (base === title || base.startsWith(`${title} - `) || base.startsWith(`${title}-`)) {
        return f;
      }
    }
  }
  return null;
}

/** Busca un fichero de audio cuyo nombre contenga [<trackId>]. */
export function findFileByTrackId(outDir: string, trackId: string): string | null {
  const found = scanDownloadedAudioWithPaths(outDir).find((p) =>
    p.includes(`[${trackId}]`),
  );
  return found ?? null;
}

function scanDownloadedAudioWithPaths(outDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        const ext = path.extname(e.name).slice(1).toLowerCase();
        if (COMMON_AUDIO_EXTS.includes(ext)) files.push(full);
      }
    }
  };
  walk(outDir);
  return files;
}
