import fs from 'node:fs';
import type { BrowserContext, Page } from 'playwright';
import { PROFILE_DIR } from './store';
import { run, sleep } from './util';

export interface LoginResult {
  oauthToken: string;
  username?: string;
}

// Playwright se carga de forma perezosa: en la app empaquetada (sin
// node_modules) el login por navegador no está disponible y se degrada a
// "pegar el token manualmente".
async function loadPlaywright(): Promise<typeof import('playwright')> {
  try {
    return await import('playwright');
  } catch {
    throw new Error(
      'El inicio de sesión por navegador no está disponible en esta versión de la app. Usa la opción de pegar el token.',
    );
  }
}

export async function ensureBrowser(onStatus: (msg: string) => void): Promise<void> {
  const { chromium } = await loadPlaywright();
  try {
    const exe = chromium.executablePath();
    if (exe && fs.existsSync(exe)) return;
  } catch {
    // continúa con la instalación
  }
  onStatus('Descargando Chromium para Playwright (primera vez, ~150 MB)...');
  const res = await run(['bun', 'x', 'playwright', 'install', 'chromium']);
  if (res.code !== 0) {
    throw new Error('No se pudo instalar Chromium (Playwright).');
  }
}

// Disfraza las señales típicas de automatización que usan anti-bots como
// Datadome (el que usa SoundCloud): navigator.webdriver, el objeto window.chrome,
// plugins, idiomas, permisos y tamaños de ventana.
async function applyStealth(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const w = globalThis as any;
    const nav = w.navigator as any;

    Object.defineProperty(nav, 'webdriver', { get: () => undefined });

    if (!w.chrome) w.chrome = {};
    if (!w.chrome.runtime) {
      try {
        Object.defineProperty(w.chrome, 'runtime', { get: () => ({}) });
      } catch {
        w.chrome.runtime = {};
      }
    }

    Object.defineProperty(nav, 'languages', {
      get: () => ['es-ES', 'es', 'en-US', 'en'],
    });

    const query = nav.permissions?.query;
    if (query) {
      nav.permissions.query = (p: { name: string }) =>
        p.name === 'notifications' && w.Notification
          ? Promise.resolve({ state: w.Notification.permission })
          : query(p);
    }

    Object.defineProperty(w, 'outerWidth', { get: () => w.innerWidth });
    Object.defineProperty(w, 'outerHeight', { get: () => w.innerHeight });
  });
}

async function launchStealthBrowser(): Promise<BrowserContext> {
  const { chromium } = await loadPlaywright();
  const base: Parameters<typeof chromium.launchPersistentContext>[1] = {
    headless: false,
    viewport: { width: 1280, height: 820 },
    locale: 'es-ES',
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  };
  // Si hay un Chrome real instalado, úsalo (más parecido a un usuario normal);
  // si no, usa el Chromium de Playwright.
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, {
      ...base,
      channel: 'chrome',
    });
  } catch {
    return await chromium.launchPersistentContext(PROFILE_DIR, base);
  }
}

async function readOAuthToken(context: BrowserContext, page: Page): Promise<string | null> {
  try {
    const cookies = await context.cookies();
    const found = cookies.find((c) => c.name === 'oauth_token');
    if (found?.value) return decodeURIComponent(found.value);
  } catch {
    // intentar localStorage
  }
  try {
    const raw = await page.evaluate(() =>
      (globalThis as any).localStorage?.getItem('soundcloud_session'),
    );
    if (raw) {
      const parsed = JSON.parse(raw) as { oauth_token?: string };
      if (parsed.oauth_token) return decodeURIComponent(parsed.oauth_token);
    }
  } catch {
    // sin token todavía
  }
  return null;
}

async function isBotChallenge(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    if (/captcha|datadome|areyouahuman/i.test(url)) return true;
    const text = await page
      .evaluate(() => (globalThis as any).document?.body?.innerText?.slice(0, 4000) || '')
      .catch(() => '');
    return /bot|robot|attention required|datadome|captcha|bloqueado|intrigado|human/i.test(text);
  } catch {
    return false;
  }
}

async function waitForOAuthToken(
  context: BrowserContext,
  page: Page,
  onStatus: (msg: string) => void,
): Promise<string> {
  const deadline = Date.now() + 5 * 60_000;
  let warnedChallenge = false;
  while (Date.now() < deadline) {
    const token = await readOAuthToken(context, page);
    if (token) return token;
    if (!warnedChallenge && (await isBotChallenge(page))) {
      warnedChallenge = true;
      onStatus(
        'Hay un reto anti-bot en la ventana. Resuélvelo (marca el captcha) y luego inicia sesión en SoundCloud...',
      );
    }
    await sleep(1200);
  }
  throw new Error(
    'Tiempo de espera agotado (5 min) esperando el inicio de sesión en SoundCloud.',
  );
}

async function extractUsername(page: Page): Promise<string | undefined> {
  try {
    await sleep(1500);
    await page.goto('https://soundcloud.com/you', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
  } catch {
    // continuar con la URL actual
  }
  for (let i = 0; i < 25; i++) {
    const url = page.url();
    if (!/soundcloud\.com\/(signin|you)/.test(url)) {
      const m = url.match(/soundcloud\.com\/([^/?#]+)/);
      if (m?.[1]) return m[1];
    }
    await sleep(400);
  }
  return undefined;
}

export async function loginWithBrowser(
  onStatus: (msg: string) => void,
): Promise<LoginResult> {
  await ensureBrowser(onStatus);
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  let context: BrowserContext | undefined;
  try {
    onStatus('Abriendo navegador...');
    context = await launchStealthBrowser();
    await applyStealth(context);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto('https://soundcloud.com', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    // Ritmo humano: no navegar "sobrehumano".
    await sleep(1500 + Math.floor(Math.random() * 2000));
    onStatus('Inicia sesión en la ventana del navegador (SoundCloud)...');
    const oauthToken = await waitForOAuthToken(context, page, onStatus);
    onStatus('Sesión iniciada. Obteniendo tu perfil...');
    const username = await extractUsername(page);
    return { oauthToken, username };
  } finally {
    await context?.close().catch(() => {});
  }
}
