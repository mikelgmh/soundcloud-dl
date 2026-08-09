import path from 'node:path';
import { run, runStream } from './util';
import type { LikedTrack } from './store';

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
    throw new Error(`yt-dlp no pudo obtener la lista:\n${tail}`);
  }

  const entries: LikedTrack[] = [];
  stdout
    .split('\n')
    .filter((l) => l.trim() !== '')
    .forEach((line, i) => {
      try {
        const j = JSON.parse(line);
        if (j && (j.url || j.webpage_url)) {
          // En modo completo la URL es el stream; la página es webpage_url.
          const pageUrl = mode === 'full'
            ? (j.webpage_url ?? j.url)
            : (j.url ?? j.webpage_url);
          const m = String(pageUrl).match(/soundcloud\.com\/([^/]+)\//);
          entries.push({
            id: String(j.id ?? i),
            title: j.title ?? `Elemento ${i}`,
            url: pageUrl,
            uploader:
              mode === 'full' ? (j.uploader ?? m?.[1]) : (m?.[1]),
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
  const format = opts.format ?? 'mp3';
  const bitrate = opts.bitrate ?? opts.quality ?? '320K';
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
    if (!lossless) args.push('--audio-quality', bitrate);
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
