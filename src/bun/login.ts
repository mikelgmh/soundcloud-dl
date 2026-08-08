import { BrowserWindow, Session } from "electrobun/bun";
import { sleep } from "../util";
import type { LoginResultPayload } from "../shared/types";

// Login con la webview nativa del sistema (WKWebView): sin Playwright, sin
// señales de automatización. Se abre una ventana con SoundCloud, el usuario
// inicia sesión y se lee la cookie oauth_token de la sesión.
const LOGIN_URL = "https://soundcloud.com";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const USERNAME_TIMEOUT_MS = 30 * 1000;

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
    currentUrl = e?.data?.detail ?? currentUrl;
  });
  win.on("close", () => {
    closed = true;
  });

  onStatus(
    "Inicia sesión en la ventana de SoundCloud. Si aparece un captcha, resuélvelo.",
  );

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let token: string | null = null;
  while (Date.now() < deadline) {
    if (closed) {
      win.close();
      throw new Error("Ventana de inicio de sesión cerrada.");
    }
    token = readOAuthToken();
    if (token) break;
    await sleep(1500);
  }
  if (!token) {
    win.close();
    throw new Error(
      "Tiempo de espera agotado (5 min) esperando el inicio de sesión.",
    );
  }

  onStatus("Sesión iniciada. Obteniendo tu perfil...");

  // Navega a /you para descubrir el nombre de usuario.
  currentUrl = "";
  win.webview.loadURL("https://soundcloud.com/you");
  let username: string | undefined;
  const unDeadline = Date.now() + USERNAME_TIMEOUT_MS;
  while (Date.now() < unDeadline) {
    const m = currentUrl.match(/soundcloud\.com\/([^/?#]+)/);
    if (m && !/^(signin|you|stream|feed|home|discover)$/.test(m[1])) {
      username = m[1];
      break;
    }
    if (closed) break;
    await sleep(400);
  }

  win.close();
  return { oauthToken: token, username };
}
