import { BrowserWindow, Session } from "electrobun/bun";
import { sleep } from "../util";
import type { LoginResultPayload } from "../shared/types";

// Login con la webview nativa del sistema (WKWebView): sin Playwright, sin
// señales de automatización. Se abre una ventana con SoundCloud, el usuario
// inicia sesión y se lee la cookie oauth_token de la sesión.
//
// IMPORTANTE: SoundCloud pone una cookie oauth_token incluso sin iniciar
// sesión (token de invitado). Por eso no basta con ver la cookie: se verifica
// contra la API /me y solo se acepta si el token es válido.
const LOGIN_URL = "https://soundcloud.com";
const CONNECTING_URL = "views://connecting/index.html";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_MS = 700;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

let cachedClientId: string | null = null;

async function getClientId(): Promise<string | null> {
  if (cachedClientId) return cachedClientId;
  try {
    const home = await fetch("https://soundcloud.com/", {
      headers: { "User-Agent": UA },
    });
    if (!home.ok) return null;
    const html = await home.text();
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
      .map((m) => m[1])
      .reverse();
    for (const src of srcs) {
      try {
        const url = src.startsWith("http") ? src : `https:${src}`;
        const res = await fetch(url, { headers: { "User-Agent": UA } });
        if (!res.ok) continue;
        const js = await res.text();
        const m = js.match(/client_id\s*[:=]\s*"([0-9a-zA-Z]{32})"/);
        if (m) {
          cachedClientId = m[1];
          return m[1];
        }
      } catch {
        // siguiente script
      }
    }
  } catch {
    // sin red
  }
  return null;
}

/** Verifica si un token es una sesión real de SoundCloud. */
export async function verifyToken(token: string): Promise<{
  valid: boolean;
  username?: string;
}> {
  try {
    const clientId = await getClientId();
    if (!clientId) return { valid: false };
    const res = await fetch(
      `https://api-v2.soundcloud.com/me?client_id=${clientId}`,
      { headers: { "User-Agent": UA, Authorization: `OAuth ${token}` } },
    );
    if (res.status === 200) {
      const j = (await res.json()) as { permalink?: string; username?: string };
      return { valid: true, username: j.permalink ?? j.username };
    }
    return { valid: false };
  } catch {
    return { valid: false };
  }
}

function readOAuthToken(): string | null {
  try {
    const cookies = Session.defaultSession.cookies.get({
      name: "oauth_token",
    });
    const found = cookies.find((c) =>
      (c.domain ?? "").includes("soundcloud.com"),
    );
    return found?.value ? decodeURIComponent(found.value) : null;
  } catch {
    return null;
  }
}

/** Cierra la sesión de SoundCloud guardada en la webview. */
export function clearSoundCloudSession(): void {
  try {
    const session = Session.defaultSession;
    const cookies = session.cookies.get();
    for (const c of cookies) {
      if ((c.domain ?? "").includes("soundcloud.com")) {
        try {
          const domain = (c.domain ?? "").replace(/^\./, "");
          session.cookies.remove(`https://${domain}`, c.name);
        } catch {
          // seguir con el resto
        }
      }
    }
  } catch {
    // ignorar
  }
}

export async function loginWithElectrobunWindow(
  onStatus: (msg: string) => void,
): Promise<LoginResultPayload> {
  let closed = false;
  let checkNow = true;

  const win = new BrowserWindow({
    title: "Inicia sesión en SoundCloud",
    url: LOGIN_URL,
    frame: { width: 980, height: 780, x: 150, y: 100 },
  });

  win.webview.on("did-navigate", (event: unknown) => {
    // Al navegar (p.ej. tras iniciar sesión) se re-comprueba de inmediato.
    const e = event as { data?: { detail?: string } };
    const url = e?.data?.detail ?? "";
    if (url.includes("soundcloud.com")) checkNow = true;
  });
  win.on("close", () => {
    closed = true;
  });

  onStatus(
    "Inicia sesión en la ventana de SoundCloud. Si aparece un captcha, resuélvelo.",
  );

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let lastInvalid: string | null = null;

  while (Date.now() < deadline) {
    if (closed) {
      win.close();
      throw new Error("Ventana de inicio de sesión cerrada.");
    }

    const token = readOAuthToken();
    if (token && token !== lastInvalid) {
      const v = await verifyToken(token);
      if (v.valid) {
        onStatus("Sesión verificada. Conectando con la app...");
        // Muestra un aviso encima antes de cerrar la ventana.
        win.webview.loadURL(CONNECTING_URL);
        await sleep(1200);
        win.close();
        return { oauthToken: token, username: v.username };
      }
      // Token de invitado/caducado: no es una sesión real, se sigue esperando.
      lastInvalid = token;
    }

    if (checkNow) {
      checkNow = false;
      await sleep(100);
    } else {
      await sleep(POLL_MS);
    }
  }

  win.close();
  throw new Error(
    "Tiempo de espera agotado (5 min) esperando el inicio de sesión.",
  );
}
