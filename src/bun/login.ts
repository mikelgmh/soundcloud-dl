import { BrowserWindow, Session } from "electrobun/bun";
import { sleep } from "../util";
import type { LoginResultPayload } from "../shared/types";

// Login con la webview nativa del sistema (WKWebView): sin Playwright, sin
// señales de automatización. Se abre una ventana con SoundCloud, el usuario
// inicia sesión y se lee la cookie oauth_token de la sesión.
//
// La verificación se hace dentro de la propia webview (navegando a /you y
// comprobando si redirige a un perfil), porque la API de SoundCloud bloquea
// peticiones externas (Datadome) y un token válido parecería inválido.
const LOGIN_URL = "https://soundcloud.com";
const CONNECTING_URL = "views://connecting/index.html";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_MS = 800;
const CHECK_TIMEOUT_MS = 15 * 1000;

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
  let currentUrl = LOGIN_URL;

  const win = new BrowserWindow({
    title: "Inicia sesión en SoundCloud",
    url: LOGIN_URL,
    frame: { width: 980, height: 780, x: 150, y: 100 },
  });

  win.webview.on("did-navigate", (event: unknown) => {
    const e = event as { data?: { detail?: string } };
    const d = e?.data?.detail;
    if (d && d.includes("soundcloud.com")) currentUrl = d;
  });
  win.on("close", () => {
    closed = true;
  });

  onStatus(
    "Inicia sesión en la ventana de SoundCloud. Si aparece un captcha, resuélvelo.",
  );

  // Comprueba si la sesión actual es real navegando a /you (que redirige a tu
  // perfil si estás logueado, o a /signin si no). Usa la webview real.
  async function checkLoggedIn(): Promise<{
    loggedIn: boolean;
    username?: string;
  }> {
    currentUrl = "";
    win.webview.loadURL("https://soundcloud.com/you");
    const end = Date.now() + CHECK_TIMEOUT_MS;
    while (Date.now() < end) {
      if (closed) break;
      const m = currentUrl.match(/soundcloud\.com\/([^/?#]+)/);
      if (m && !/^(signin|you|stream|feed|home|discover)$/.test(m[1])) {
        return { loggedIn: true, username: m[1] };
      }
      if (m && m[1] === "signin") break;
      await sleep(250);
    }
    // Volver a la home para que el usuario continúe si no estaba logueado.
    win.webview.loadURL(LOGIN_URL);
    return { loggedIn: false };
  }

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let lastCheckedToken: string | null = null;
  let checkedInitial = false;

  while (Date.now() < deadline) {
    if (closed) {
      win.close();
      throw new Error("Ventana de inicio de sesión cerrada.");
    }

    const token = readOAuthToken();
    // La primera comprobación cubre el caso de sesión ya iniciada (persistida).
    // Las siguientes solo se lanzan si el valor de la cookie cambia (login real).
    if (token && (!checkedInitial || token !== lastCheckedToken)) {
      const v = await checkLoggedIn();
      checkedInitial = true;
      if (v.loggedIn) {
        onStatus("Sesión verificada. Conectando con la app...");
        win.webview.loadURL(CONNECTING_URL);
        await sleep(1200);
        win.close();
        return { oauthToken: token, username: v.username };
      }
      lastCheckedToken = token;
    }
    await sleep(POLL_MS);
  }

  win.close();
  throw new Error(
    "Tiempo de espera agotado (5 min) esperando el inicio de sesión.",
  );
}
