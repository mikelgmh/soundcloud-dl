import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  note,
  outro,
  select,
  spinner,
  text,
} from '@clack/prompts';
import { loginWithBrowser } from './auth';
import { ensureDeps } from './deps';
import {
  buildDownloadArgs,
  downloadLikes,
  fetchLikes,
} from './download';
import {
  loadConfig,
  loadLikesCache,
  saveConfig,
  saveLikesCache,
  writeCookiesFile,
  type Config,
  type LikedTrack,
} from './store';

const HELP = `
SoundCloud Downloader — descarga tus favoritos de SoundCloud como MP3.

Uso:
  bun index.ts                          Asistente (setup) + descarga
  bun index.ts --setup                  Re-ejecutar el asistente de configuración
  bun index.ts --search "término"       Busca y descarga una canción de tus favoritos
  bun index.ts --yes --token <t> --username <u> --outdir <dir>   No interactivo
  bun index.ts --dry-run                Muestra el comando yt-dlp sin descargar
  bun index.ts --help                   Muestra esta ayuda

Opciones:
  --setup                  Vuelve a preguntar todo (asistente)
  --token <oauth_token>    Token oauth_token (si no, se obtiene del navegador)
  --username <usuario>     Nombre de usuario de SoundCloud
  --outdir <directorio>    Carpeta de destino (por defecto ~/Music/SoundCloud)
  --quality <K>            Bitrate MP3: 320K (por defecto), 256K, 192K, 128K
  --no-skip-existing       Redescargar canciones aunque ya existan
  --search <texto>         Buscar entre tus favoritos y descargar la canción
  --yes                    Modo no interactivo (sin preguntas)

La primera vez se abre un asistente que lo pregunta todo:
cuenta (iniciando sesión en el navegador), usuario, carpeta, calidad y
opciones. La configuración se guarda en .snd/ y se reutiliza después.

La lista de favoritos se cachea en .snd/likes-<usuario>.json (se refresca en
cada arranque), para que --search sea rápido y no vuelva a descargar la lista.
`;

const SECURITY_NOTE = [
  'La sesión se guarda en .snd/ y se reutiliza en las siguientes ejecuciones.',
  'Descarga secuencial, una canción a la vez, con pausas aleatorias (anti-baneo).',
  'Las canciones ya descargadas en la carpeta de destino se omiten.',
];

const QUALITY_OPTIONS = [
  { value: '320K', label: 'MP3 320 kbps', hint: 'máxima calidad (recomendado)' },
  { value: '256K', label: 'MP3 256 kbps', hint: 'alta calidad, algo más ligero' },
  { value: '192K', label: 'MP3 192 kbps', hint: 'calidad media' },
  { value: '128K', label: 'MP3 128 kbps', hint: 'más ligero' },
];

interface CliArgs {
  help: boolean;
  dryRun: boolean;
  yes: boolean;
  setup: boolean;
  token?: string;
  username?: string;
  outdir?: string;
  quality?: string;
  skipExisting: boolean;
  search?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    help: false,
    dryRun: false,
    yes: false,
    setup: false,
    skipExisting: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const name = eq >= 0 ? a.slice(0, eq) : a;
    const inlineVal = eq >= 0 ? a.slice(eq + 1) : undefined;
    const val = () => inlineVal ?? (i + 1 < argv.length ? argv[++i] : undefined);
    switch (name) {
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--dry-run':
        out.dryRun = true;
        break;
      case '--yes':
        out.yes = true;
        break;
      case '--setup':
        out.setup = true;
        break;
      case '--token':
        out.token = val();
        break;
      case '--username':
        out.username = val();
        break;
      case '--outdir':
        out.outdir = val();
        break;
      case '--quality':
        out.quality = val();
        break;
      case '--no-skip-existing':
        out.skipExisting = false;
        break;
      case '--search':
        out.search = val() ?? '';
        break;
      default:
        break;
    }
  }
  return out;
}

function exitCancel(): never {
  cancel('Operación cancelada.');
  process.exit(1);
}

/** Inicia sesión por navegador (con sigilo anti-bot) o pidiendo el token a mano. */
async function interactiveLogin(ctx: {
  setMsg: (m: string) => void;
  spStart: (m: string) => void;
  spStop: () => void;
}): Promise<{ oauthToken: string; username?: string }> {
  const method = await select({
    message: '¿Cómo quieres iniciar sesión en SoundCloud?',
    options: [
      { value: 'browser', label: 'Abrir el navegador', hint: 'recomendado' },
      {
        value: 'token',
        label: 'Pegar el token manualmente',
        hint: 'oauth_token (cookies de soundcloud.com)',
      },
    ],
  });
  if (isCancel(method)) exitCancel();

  if (method === 'token') {
    return { oauthToken: await askForToken() };
  }

  ctx.spStart('Abriendo navegador para iniciar sesión...');
  try {
    const res = await loginWithBrowser(ctx.setMsg);
    ctx.spStop();
    return res;
  } catch (err) {
    ctx.spStop();
    log.warn(err instanceof Error ? err.message : String(err));
    log.warn(
      'Si SoundCloud muestra un reto anti-bot, resuélvelo en la ventana del navegador. Si no lo superas, puedes pegar el token manualmente.',
    );
    const manual = await confirm({
      message: '¿Pegar el token manualmente?',
      initialValue: true,
    });
    if (isCancel(manual)) exitCancel();
    if (manual) return { oauthToken: await askForToken() };
    cancel('Operación cancelada.');
    process.exit(1);
  }
}

async function askForToken(): Promise<string> {
  const pasted = await text({
    message: 'Pega tu token oauth_token:',
    validate: (v) =>
      v && v.trim().length > 10 ? undefined : 'Ese token no parece válido',
  });
  if (isCancel(pasted)) exitCancel();
  return pasted.trim();
}

export async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }
  const dryRun = opts.dryRun;
  const interactive = !opts.yes;

  intro('SoundCloud Downloader');

  const sp = spinner();
  let spActive = false;
  const spStart = (m: string) => {
    if (!interactive) {
      log.info(m);
      return;
    }
    try {
      if (!spActive) {
        sp.start(m);
        spActive = true;
      } else {
        sp.message(m);
      }
    } catch {
      // spinner no disponible
    }
  };
  const spStop = () => {
    if (!interactive) return;
    try {
      if (spActive) sp.stop();
    } catch {
      // ignore
    }
    spActive = false;
  };
  const setMsg = (m: string) => spStart(m);

  const deps = await ensureDeps({
    onStatus: (m) => spStart(m),
    askInstall: async (tool, suggestion) => {
      if (!interactive) return true;
      spStop();
      const ok = await confirm({
        message: `${tool} no está instalado y es necesario. ¿Instalarlo automáticamente (${suggestion})?`,
        initialValue: true,
      });
      if (isCancel(ok)) exitCancel();
      return ok;
    },
  });
  spStop();

  const hasFfmpeg =
    deps.ffmpegDir !== null || !!(Bun.which('ffmpeg') && Bun.which('ffprobe'));
  if (!hasFfmpeg) {
    cancel(
      'No se pudo instalar ffmpeg. Instálalo manualmente con: brew install ffmpeg',
    );
    process.exit(1);
  }
  log.success(`yt-dlp: ${deps.ytdlp}`);
  log.success(`ffmpeg: ${deps.ffmpegDir ?? 'del sistema (PATH)'}`);

  const stored = loadConfig();

  // Asistente de configuración: primera vez o con --setup
  let config: Config;
  const needsSetup =
    opts.setup ||
    !stored.setupDone ||
    !stored.oauthToken ||
    !stored.username ||
    !stored.outdir;

  if (interactive && needsSetup) {
    config = await runWizard({ setMsg, spStart, spStop });
    saveConfig(config);
    log.success('Configuración guardada.');
  } else {
    config = {
      ...stored,
      ...(opts.token ? { oauthToken: opts.token } : {}),
      ...(opts.username ? { username: opts.username } : {}),
      ...(opts.outdir ? { outdir: opts.outdir } : {}),
      ...(opts.quality ? { quality: opts.quality } : {}),
      skipExisting: opts.skipExisting,
    };
    if (!config.oauthToken || !config.username) {
      cancel(
        'Falta configuración. Ejecuta la CLI sin --yes para abrir el asistente, o pasa --token y --username.',
      );
      process.exit(1);
    }
  }

  note(SECURITY_NOTE.join('\n'), 'Sesión y modo seguro');

  // Modo búsqueda: buscar una canción entre los favoritos y descargarla
  if (opts.search !== undefined) {
    await runSearch({
      opts,
      deps,
      config,
      interactive,
      setMsg,
      spStart,
      spStop,
    });
    outro('Búsqueda finalizada.');
    return;
  }

  // Validar sesión y contar favoritos (además refresca la caché de likes)
  const cookiesFile = writeCookiesFile(config.oauthToken!);
  const username = config.username!;
  let count = -1;
  spStart('Validando la sesión y contando favoritos...');
  try {
    const result = await fetchLikes({
      ytdlp: deps.ytdlp,
      ffmpegDir: deps.ffmpegDir,
      cookiesFile,
      username,
    });
    spStop();
    saveLikesCache(username, result.tracks);
    count = result.tracks.length;
    if (result.tokenInvalid) {
      log.warn('El token guardado parece no ser válido (¿sesión caducada?).');
      if (interactive) {
        const retry = await confirm({
          message: '¿Quieres iniciar sesión de nuevo?',
          initialValue: true,
        });
        if (isCancel(retry)) exitCancel();
        if (retry) {
          const res = await interactiveLogin({ setMsg, spStart, spStop });
          config.oauthToken = res.oauthToken;
          config.username = res.username ?? config.username;
          saveConfig(config);
          log.success('Sesión renovada.');
        }
      } else {
        log.warn('Modo no interactivo: continúo con los likes públicos.');
      }
    } else {
      log.info(`Se encontraron ${count} canciones en tus favoritos.`);
    }
  } catch (err) {
    spStop();
    log.warn(err instanceof Error ? err.message : String(err));
    const cont = interactive
      ? await confirm({
          message: 'No se pudo enumerar los favoritos. ¿Continuar de todos modos?',
          initialValue: false,
        })
      : true;
    if (isCancel(cont)) exitCancel();
    if (!cont) {
      cancel('Cancelado.');
      process.exit(1);
    }
  }

  const outDir = config.outdir!;
  fs.mkdirSync(outDir, { recursive: true });

  const proceed = interactive
    ? await confirm({
        message:
          count >= 0
            ? `¿Descargar ${count} favoritos como MP3 ${config.quality ?? '320K'}?`
            : `¿Descargar los favoritos como MP3 ${config.quality ?? '320K'}?`,
        initialValue: true,
      })
    : true;
  if (isCancel(proceed)) exitCancel();
  if (!proceed) {
    cancel('No se descargó nada.');
    process.exit(0);
  }

  const session = { cookiesFile: writeCookiesFile(config.oauthToken!), username };
  const cmd = buildDownloadArgs({
    ytdlp: deps.ytdlp,
    ffmpegDir: deps.ffmpegDir,
    outDir,
    quality: config.quality,
    skipExisting: config.skipExisting,
    ...session,
  });

  if (dryRun) {
    note(cmd.join(' \\\n  '), 'Comando yt-dlp (dry-run)');
    outro('Dry-run completado: no se ha descargado nada.');
    return;
  }

  log.info(`Descargando desde https://soundcloud.com/${username}/likes`);
  const res = await downloadLikes({
    ytdlp: deps.ytdlp,
    ffmpegDir: deps.ffmpegDir,
    outDir,
    quality: config.quality,
    skipExisting: config.skipExisting,
    ...session,
  });
  if (res.code !== 0) {
    cancel(`yt-dlp terminó con código ${res.code}. Revisa la salida anterior.`);
    process.exit(1);
  }

  outro(`Descarga completada en ${outDir}`);
}

// Tiempo máximo que se considera "fresca" la caché de favoritos (1 hora).
const LIKES_CACHE_TTL = 60 * 60 * 1000;

function freshLikesTracks(username: string): LikedTrack[] | null {
  const cached = loadLikesCache(username);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > LIKES_CACHE_TTL) return null;
  return cached.tracks;
}

/** Busca una canción entre los favoritos y la descarga. */
async function runSearch(ctx: {
  opts: CliArgs;
  deps: { ytdlp: string; ffmpegDir: string | null };
  config: Config;
  interactive: boolean;
  setMsg: (m: string) => void;
  spStart: (m: string) => void;
  spStop: () => void;
}): Promise<void> {
  const { opts, deps, config, interactive, setMsg, spStart, spStop } = ctx;
  const username = config.username!;
  const dryRun = opts.dryRun;

  let query = (opts.search ?? '').trim();
  if (!query) {
    if (!interactive) {
      cancel('Para buscar necesitas un término: --search "texto"');
      process.exit(1);
    }
    const ans = await text({
      message: '¿Qué canción buscas entre tus favoritos?',
      validate: (v) => (v && v.trim() ? undefined : 'Escribe un término de búsqueda'),
    });
    if (isCancel(ans)) exitCancel();
    query = ans.trim();
  }

  // Lista de favoritos: caché reciente, o la refrescamos
  spStart('Obteniendo tus favoritos...');
  let tracks = freshLikesTracks(username);
  if (!tracks) {
    try {
      const result = await fetchLikes({
        ytdlp: deps.ytdlp,
        ffmpegDir: deps.ffmpegDir,
        cookiesFile: writeCookiesFile(config.oauthToken!),
        username,
      });
      tracks = result.tracks;
      saveLikesCache(username, result.tracks);
      if (result.tokenInvalid) {
        log.warn('El token parece no ser válido; solo verás los likes públicos.');
      }
    } catch (err) {
      spStop();
      cancel(
        `No se pudieron obtener los favoritos: ${err instanceof Error ? err.message : err}`,
      );
      process.exit(1);
    }
  }
  spStop();
  log.info(`Tienes ${tracks.length} favoritos en total.`);

  const q = query.toLowerCase();
  const matches = tracks.filter(
    (t) =>
      t.title.toLowerCase().includes(q) ||
      (t.uploader ?? '').toLowerCase().includes(q),
  );
  if (matches.length === 0) {
    log.warn(`No se encontraron canciones que contengan "${query}".`);
    return;
  }

  let selected: LikedTrack;
  if (matches.length === 1) {
    selected = matches[0];
  } else if (interactive) {
    const shown = matches.slice(0, 20);
    if (matches.length > shown.length) {
      log.info(`Hay ${matches.length} coincidencias; muestro las primeras ${shown.length}.`);
    }
    const pick = await select({
      message: `Coincidencias (${matches.length}): elige una para descargar`,
      options: shown.map((t) => ({
        value: t,
        label: [t.uploader, t.title].filter(Boolean).join(' - '),
      })),
    });
    if (isCancel(pick)) exitCancel();
    selected = pick;
  } else {
    selected = matches[0];
    if (matches.length > 1) {
      log.warn(
        `Hay ${matches.length} coincidencias; descargo la primera ("${selected.title}").`,
      );
    }
  }

  const proceed = interactive
    ? await confirm({
        message: `¿Descargar "${selected.title}" como MP3 ${config.quality ?? '320K'}?`,
        initialValue: true,
      })
    : true;
  if (isCancel(proceed)) exitCancel();
  if (!proceed) return;

  const session = { cookiesFile: writeCookiesFile(config.oauthToken!), username };
  const downloadOpts = {
    ytdlp: deps.ytdlp,
    ffmpegDir: deps.ffmpegDir,
    outDir: config.outdir!,
    quality: config.quality,
    skipExisting: config.skipExisting,
    ...session,
    url: selected.url,
  };

  if (dryRun) {
    note(buildDownloadArgs(downloadOpts).join(' \\\n  '), 'Comando yt-dlp (dry-run)');
    return;
  }

  fs.mkdirSync(config.outdir!, { recursive: true });
  log.info(`Descargando "${selected.title}"...`);
  const res = await downloadLikes(downloadOpts);
  if (res.code !== 0) {
    cancel(`yt-dlp terminó con código ${res.code}. Revisa la salida anterior.`);
    process.exit(1);
  }
}

/** Asistente de configuración: pregunta todo lo necesario una sola vez. */
async function runWizard(ctx: {
  setMsg: (m: string) => void;
  spStart: (m: string) => void;
  spStop: () => void;
}): Promise<Config> {
  const config: Config = {};
  const stored = loadConfig();

  note(
    'Voy a pedirte lo necesario para empezar. Solo hay que hacerlo una vez; después solo descargarás.',
    'Asistente de configuración',
  );

  // Paso 1 · Cuenta de SoundCloud
  log.step('Paso 1 de 5 · Cuenta de SoundCloud');
  let token = stored.oauthToken;
  if (token) {
    const reuse = await confirm({
      message: 'Hay una sesión de SoundCloud guardada. ¿Usarla?',
      initialValue: true,
    });
    if (isCancel(reuse)) exitCancel();
    if (!reuse) token = undefined;
  }
  if (!token) {
    const res = await interactiveLogin(ctx);
    token = res.oauthToken;
    if (res.username) config.username = res.username;
  }
  config.oauthToken = token!;

  // Paso 2 · Nombre de usuario
  log.step('Paso 2 de 5 · Nombre de usuario de SoundCloud');
  let username = config.username ?? stored.username;
  if (username) {
    const ok = await confirm({
      message: `Tu usuario parece ser "${username}". ¿Es correcto?`,
      initialValue: true,
    });
    if (isCancel(ok)) exitCancel();
    if (!ok) username = undefined;
  }
  if (!username) {
    const ans = await text({
      message: '¿Cuál es tu nombre de usuario de SoundCloud?',
      placeholder: 'mi-usuario',
      validate: (v) => (v && v.trim() ? undefined : 'Es obligatorio'),
    });
    if (isCancel(ans)) exitCancel();
    username = ans.trim();
  }
  config.username = username!;

  // Paso 3 · Carpeta de descargas
  log.step('Paso 3 de 5 · Carpeta de descargas');
  const home = os.homedir();
  const outdir = await text({
    message: '¿Dónde quieres guardar las canciones?',
    initialValue: stored.outdir ?? path.join(home, 'Music', 'SoundCloud'),
  });
  if (isCancel(outdir)) exitCancel();
  config.outdir = outdir;

  // Paso 4 · Calidad
  log.step('Paso 4 de 5 · Calidad de audio');
  const quality = await select({
    message: '¿Qué calidad quieres al convertir a MP3?',
    options: QUALITY_OPTIONS,
    initialValue: '320K',
  });
  if (isCancel(quality)) exitCancel();
  config.quality = quality as string;

  // Paso 5 · Omitir descargadas
  log.step('Paso 5 de 5 · Canciones ya descargadas');
  const skipExisting = await confirm({
    message: '¿Omitir las canciones que ya existan en la carpeta?',
    initialValue: true,
  });
  if (isCancel(skipExisting)) exitCancel();
  config.skipExisting = skipExisting;

  config.setupDone = true;
  return config;
}
