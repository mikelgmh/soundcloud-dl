import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BIN_DIR, SND_DIR } from './store';
import { run } from './util';
import { resolveLang, t, type Lang } from './shared/i18n';

export interface Deps {
  ytdlp: string;
  /** null = ffmpeg del sistema (PATH). Si es string, es el directorio con
   *  los binarios descargados (se pasa con --ffmpeg-location). */
  ffmpegDir: string | null;
}

export interface EnsureDepsOpts {
  onStatus: (msg: string) => void;
  /** Devuelve true si el usuario autoriza instalar la herramienta faltante. */
  askInstall: (tool: 'yt-dlp' | 'ffmpeg', suggestion: string) => Promise<boolean>;
  /** Lengua de los mensajes de estado. */
  lang?: Lang;
}

/** Versión actual y última disponible de una herramienta. */
export interface ToolVersion {
  current: string | null;
  latest: string | null;
  hasUpdate: boolean;
}

const YTDLP_SOURCES = [
  'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_macos',
  'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
];

const FFMPEG_MACOS = {
  ffmpeg: 'https://evermeet.cx/ffmpeg/getrelease/zip',
  ffprobe: 'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip',
};

// ---- Marca de verificación de yt-dlp ----
// El binario tarda ~10s en arrancar, así que guardamos una marca para no
// volver a comprobarlo en cada ejecución salvo que el binario cambie.
const VERIFIED_MARKER = path.join(SND_DIR, '.ytdlp-verified.json');

interface VerifiedMarker {
  path: string;
  size: number;
  mtimeMs: number;
  version?: string;
}

function loadMarker(): VerifiedMarker | null {
  try {
    return JSON.parse(fs.readFileSync(VERIFIED_MARKER, 'utf8')) as VerifiedMarker;
  } catch {
    return null;
  }
}

function markerMatches(cand: string, marker: VerifiedMarker | null): boolean {
  if (!marker || marker.path !== cand) return false;
  try {
    const st = fs.statSync(cand);
    return marker.size === st.size && marker.mtimeMs === st.mtimeMs;
  } catch {
    return false;
  }
}

export async function readYtDlpVersion(cand: string): Promise<string | null> {
  const r = await run([cand, '--version'], { capture: true });
  if (r.code !== 0) return null;
  return r.stdout.trim().split('\n')[0]?.trim() || null;
}

/** Versión de yt-dlp guardada en la marca (rápido, sin arrancar el binario). */
export function getStoredYtDlpVersion(ytdlpPath: string): string | null {
  const marker = loadMarker();
  return markerMatches(ytdlpPath, marker) ? (marker?.version ?? null) : null;
}

async function markVerified(cand: string, version?: string): Promise<void> {
  try {
    const st = fs.statSync(cand);
    fs.mkdirSync(SND_DIR, { recursive: true });
    fs.writeFileSync(
      VERIFIED_MARKER,
      JSON.stringify({ path: cand, size: st.size, mtimeMs: st.mtimeMs, version }),
    );
  } catch {
    // no bloquea el flujo
  }
}

async function verifyCandidate(cand: string): Promise<{ ok: boolean; version?: string }> {
  const marker = loadMarker();
  if (markerMatches(cand, marker)) {
    return { ok: true, version: marker?.version };
  }
  const version = await readYtDlpVersion(cand);
  if (version) {
    await markVerified(cand, version);
    return { ok: true, version };
  }
  return { ok: false };
}

async function downloadYtDlp(url: string, dest: string): Promise<string | null> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  await fs.promises.writeFile(dest, new Uint8Array(buf));
  await fs.promises.chmod(dest, 0o755);
  return readYtDlpVersion(dest);
}

// ---- Versiones ----

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = b.split(/[^0-9]+/).filter(Boolean).map(Number);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** Construye la información de versión calculando si hay actualización. */
export function makeToolVersion(current: string | null, latest: string | null): ToolVersion {
  return {
    current,
    latest,
    hasUpdate: !!(current && latest && compareVersions(latest, current) > 0),
  };
}

async function fetchYtDlpLatest(): Promise<{ tag: string; url: string } | null> {
  try {
    const res = await fetch(
      'https://api.github.com/repos/yt-dlp/yt-dlp-nightly-builds/releases/latest',
      { headers: { 'User-Agent': 'soundcloud-downloader' } },
    );
    if (!res.ok) return null;
    const j = (await res.json()) as {
      tag_name?: string;
      assets?: { name: string; browser_download_url: string }[];
    };
    const asset = j.assets?.find((a) => a.name === 'yt-dlp_macos');
    if (!j.tag_name || !asset) return null;
    return { tag: j.tag_name, url: asset.browser_download_url };
  } catch {
    return null;
  }
}

async function fetchEvermeetLatest(): Promise<string | null> {
  try {
    const res = await fetch('https://evermeet.cx/ffmpeg/info/ffmpeg/release');
    if (!res.ok) return null;
    const j = (await res.json()) as { version?: string };
    return j.version ?? null;
  } catch {
    return null;
  }
}

async function brewOutdatedFfmpeg(): Promise<{ current: string; newest: string } | null> {
  if (!Bun.which('brew')) return null;
  process.env.HOMEBREW_NO_AUTO_UPDATE = '1';
  const r = await run(['brew', 'outdated', '--json=v2', 'ffmpeg'], { capture: true });
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.stdout) as {
      formulae?: { name: string; installed_versions?: string[]; newest_version?: string }[];
    };
    const f = j.formulae?.find((x) => x.name === 'ffmpeg');
    if (!f || !f.newest_version) return null;
    return { current: f.installed_versions?.[0] ?? '', newest: f.newest_version };
  } catch {
    return null;
  }
}

/** Última versión de ffmpeg disponible (estática o Homebrew). */
export async function fetchFfmpegLatest(ffmpegDir: string | null): Promise<string | null> {
  if (ffmpegDir) return fetchEvermeetLatest();
  const out = await brewOutdatedFfmpeg();
  return out?.newest ?? null;
}

/** Versión actual de ffmpeg (ffmpegDir = null usa el del PATH). */
export async function getFfmpegVersion(ffmpegDir: string | null): Promise<string | null> {
  const bin = ffmpegDir ? path.join(ffmpegDir, 'ffmpeg') : Bun.which('ffmpeg');
  if (!bin) return null;
  const r = await run([bin, '-version'], { capture: true });
  const m = r.stdout.match(/ffmpeg version\s+([0-9.]+)/i);
  return m?.[1] ?? null;
}

export async function fetchLatestVersions(deps: Deps): Promise<{
  ytdlp: { tag: string; url: string } | null;
  ffmpeg: string | null;
}> {
  const [yt, ff] = await Promise.all([
    fetchYtDlpLatest(),
    fetchFfmpegLatest(deps.ffmpegDir),
  ]);
  return { ytdlp: yt, ffmpeg: ff };
}

/** Versiones actuales + últimas disponibles para las dependencias dadas. */
export async function computeVersions(
  deps: Deps,
  latest?: { ytdlp: { tag: string; url: string } | null; ffmpeg: string | null },
): Promise<{ ytdlp: ToolVersion; ffmpeg: ToolVersion }> {
  const l = latest ?? (await fetchLatestVersions(deps));
  const ytCurrent =
    getStoredYtDlpVersion(deps.ytdlp) ?? (await readYtDlpVersion(deps.ytdlp));
  const ffCurrent = await getFfmpegVersion(deps.ffmpegDir);
  return {
    ytdlp: makeToolVersion(ytCurrent, l.ytdlp?.tag ?? null),
    ffmpeg: makeToolVersion(ffCurrent, l.ffmpeg),
  };
}

/** Actualiza yt-dlp si hay una versión nightly más nueva (solo binarios propios). */
export async function checkYtDlpUpdate(
  ytdlpPath: string,
  onStatus?: (m: string) => void,
  latest?: { tag: string; url: string } | null,
  lang: Lang = resolveLang(),
): Promise<boolean> {
  if (!path.dirname(ytdlpPath).startsWith(BIN_DIR)) return false;
  const l = latest ?? (await fetchYtDlpLatest());
  if (!l) return false;
  const current = getStoredYtDlpVersion(ytdlpPath) ?? (await readYtDlpVersion(ytdlpPath));
  if (!current || compareVersions(l.tag, current) <= 0) return false;
  onStatus?.(t(lang, "deps.updatingYtdlp", { version: l.tag }));
  try {
    const version = await downloadYtDlp(l.url, ytdlpPath);
    if (!version) return false;
    await markVerified(ytdlpPath, version);
    return true;
  } catch {
    return false;
  }
}

/** Actualiza ffmpeg si hay una versión más nueva (estática o Homebrew). */
export async function checkFfmpegUpdate(
  ffmpegDir: string | null,
  onStatus?: (m: string) => void,
  latestVersion?: string | null,
  lang: Lang = resolveLang(),
): Promise<boolean> {
  if (ffmpegDir) {
    const latest = latestVersion ?? (await fetchEvermeetLatest());
    if (!latest) return false;
    const current = await getFfmpegVersion(ffmpegDir);
    if (!current || compareVersions(latest, current) <= 0) return false;
    onStatus?.(t(lang, "deps.updatingFfmpeg", { version: latest }));
    const dir = await downloadFfmpegStatic(onStatus ?? (() => {}), true, lang);
    return dir !== null;
  }

  // Homebrew: latestVersion solo es no-nulo si brew outdated lo marca obsoleto.
  if (latestVersion == null) return false;
  const current = await getFfmpegVersion(null);
  if (!current || compareVersions(latestVersion, current) <= 0) return false;
  onStatus?.(t(lang, "deps.updatingFfmpegBrew"));
  const upgrade = await run(['brew', 'upgrade', 'ffmpeg'], { capture: true });
  return upgrade.code === 0;
}

// ---- Instalación ----

export async function ensureYtDlp(
  onStatus: (msg: string) => void,
  ask: () => Promise<boolean>,
  lang: Lang = resolveLang(),
): Promise<string> {
  const binPath = path.join(BIN_DIR, 'yt-dlp');
  const candidates = [Bun.which('yt-dlp'), fs.existsSync(binPath) ? binPath : null];
  for (const cand of candidates) {
    if (!cand) continue;
    const v = await verifyCandidate(cand);
    if (v.ok) return cand;
  }

  const ok = await ask();
  if (!ok) {
    throw new Error(t(lang, 'deps.installYtdlpManual'));
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  for (const url of YTDLP_SOURCES) {
    const channel = url.includes('nightly') ? 'nightly' : 'stable';
    onStatus(t(lang, 'deps.downloadingYtdlp', { channel }));
    try {
      const version = await downloadYtDlp(url, binPath);
      if (version) {
        await markVerified(binPath, version);
        return binPath;
      }
    } catch {
      // intentar la siguiente fuente
    }
  }
  throw new Error(t(lang, 'deps.installYtdlpFailed'));
}

function installFfmpegViaBrew(
  onStatus: (msg: string) => void,
  lang: Lang = resolveLang(),
): Promise<boolean> {
  onStatus(t(lang, 'deps.installingFfmpegBrew'));
  return run(['brew', 'install', 'ffmpeg']).then(
    (r) => r.code === 0 && !!(Bun.which('ffmpeg') && Bun.which('ffprobe')),
  );
}

async function downloadFfmpegStatic(
  onStatus: (m: string) => void,
  force = false,
  lang: Lang = resolveLang(),
): Promise<string | null> {
  const dir = path.join(BIN_DIR, 'ffmpeg');
  fs.mkdirSync(dir, { recursive: true });
  try {
    for (const [name, url] of Object.entries(FFMPEG_MACOS)) {
      const dest = path.join(dir, name);
      if (fs.existsSync(dest) && !force) continue;
      onStatus(t(lang, 'deps.downloadingTool', { name }));
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status} (${name})`);
      const zipPath = path.join(dir, `${name}.zip`);
      await fs.promises.writeFile(zipPath, new Uint8Array(await res.arrayBuffer()));
      const unzip = await run(['unzip', '-o', zipPath, '-d', dir]);
      await fs.promises.rm(zipPath, { force: true });
      if (unzip.code !== 0) throw new Error(`unzip falló (${name})`);
      await fs.promises.chmod(dest, 0o755);
    }
    const check = await run([path.join(dir, 'ffmpeg'), '-version'], { capture: true });
    return check.code === 0 ? dir : null;
  } catch {
    return null;
  }
}

export async function ensureFfmpeg(
  onStatus: (msg: string) => void,
  ask: (suggestion: string) => Promise<boolean>,
  lang: Lang = resolveLang(),
): Promise<string | null> {
  onStatus(t(lang, 'deps.checkingFfmpeg'));
  const system = Bun.which('ffmpeg') && Bun.which('ffprobe');
  if (system) return null;

  onStatus(t(lang, 'deps.ffmpegNotFound'));
  const hasBrew = !!Bun.which('brew');
  const suggestion = hasBrew
    ? t(lang, 'deps.suggestionOfficial')
    : t(lang, 'deps.suggestionStatic');
  const ok = await ask(suggestion);
  if (!ok) return null;

  if (hasBrew) {
    return (await installFfmpegViaBrew(onStatus, lang)) ? null : null;
  }

  if (os.platform() !== 'darwin') {
    onStatus(t(lang, 'deps.ffmpegManual'));
    return null;
  }
  return downloadFfmpegStatic(onStatus, false, lang);
}

export async function ensureDeps(opts: EnsureDepsOpts): Promise<Deps> {
  const lang = opts.lang ?? resolveLang();
  const ytdlp = await ensureYtDlp(opts.onStatus, () =>
    opts.askInstall('yt-dlp', t(lang, 'deps.suggestionOfficial')),
    lang,
  );
  const ffmpegDir = await ensureFfmpeg(opts.onStatus, (suggestion) =>
    opts.askInstall('ffmpeg', suggestion),
    lang,
  );
  return { ytdlp, ffmpegDir };
}
