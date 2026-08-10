import path from 'node:path';
import fs from 'node:fs';
import { run, runStream } from './util';
import type { LikedTrack } from './store';
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
  return findFileByTrackId(outDir, track.id);
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
