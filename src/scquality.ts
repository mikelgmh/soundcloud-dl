// Chequeo de la calidad de descarga disponible de la cuenta de SoundCloud.
//
// SoundCloud entrega transcodings de alta calidad (AAC 256 kbps) marcadas con
// `quality: "hq"` SOLO si la cuenta tiene una suscripción que lo permite
// (Go+ / Next Pro). Una cuenta gratuita solo recibe `lq`/`sq`. Se consulta la
// pista de un favorito (o el primer favorito vía API) con la sesión del
// usuario para saber si puede descargar en alta calidad.

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { SND_DIR } from "./store";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const CLIENT_ID_CACHE = join(SND_DIR, "client_id.txt");

let cachedClientId: string | null = null;

function readCachedClientId(): string | null {
  try {
    const v = readFileSync(CLIENT_ID_CACHE, "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

function persistClientId(cid: string): void {
  try {
    mkdirSync(SND_DIR, { recursive: true });
    writeFileSync(CLIENT_ID_CACHE, cid, { mode: 0o600 });
  } catch {
    // no crítico
  }
}

/** Obtiene el client_id de la web de SoundCloud (igual que hace yt-dlp) y lo
 *  cachea en disco para no re-escanear cada vez. */
async function fetchClientId(): Promise<string> {
  if (cachedClientId) return cachedClientId;
  const fromDisk = readCachedClientId();
  if (fromDisk) {
    cachedClientId = fromDisk;
    return fromDisk;
  }

  const res = await fetch("https://soundcloud.com/", {
    headers: { "User-Agent": UA },
  });
  const html = await res.text();
  let cid =
    html.match(/client_id["']?\s*[:=]\s*["']([0-9a-zA-Z]{32})["']/)?.[1] ??
    null;
  if (!cid) {
    const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(
      (m) => m[1],
    );
    for (const src of scripts) {
      try {
        const u = src.startsWith("http")
          ? src
          : `https://soundcloud.com${src}`;
        const r = await fetch(u, { headers: { "User-Agent": UA } });
        const js = await r.text();
        const m = js.match(/client_id\s*:\s*"([0-9a-zA-Z]{32})"/);
        if (m) {
          cid = m[1];
          break;
        }
      } catch {
        // siguiente script
      }
    }
  }
  if (!cid) throw new Error("No se pudo obtener el client_id de SoundCloud");
  cachedClientId = cid;
  persistClientId(cid);
  return cid;
}

async function apiGet(
  path: string,
  oauthToken: string,
  clientId: string,
): Promise<any> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(
    `https://api-v2.soundcloud.com${path}${sep}client_id=${clientId}`,
    {
      headers: {
        "User-Agent": UA,
        Authorization: `OAuth ${oauthToken}`,
      },
    },
  );
  if (!res.ok) throw new Error(`SoundCloud API ${res.status}`);
  return res.json();
}

/** Comprueba si la cuenta autenticada puede descargar en alta calidad.
 *  Usa trackId si se pasa; si no, el trackUrl (resolve); si no, el primer
 *  favorito de la cuenta vía API. */
export async function checkHighQualityStreaming(opts: {
  oauthToken: string;
  trackId?: string | number;
  trackUrl?: string;
}): Promise<boolean> {
  const cid = await fetchClientId();

  let trackId = opts.trackId;
  if (trackId == null && opts.trackUrl) {
    const resolved = await apiGet(
      `/resolve?url=${encodeURIComponent(opts.trackUrl)}`,
      opts.oauthToken,
      cid,
    );
    trackId = resolved?.id;
  }
  if (trackId == null) {
    const me = await apiGet("/me", opts.oauthToken, cid);
    const likes = await apiGet(
      `/users/${me?.id}/likes?limit=1`,
      opts.oauthToken,
      cid,
    );
    const first = likes?.collection?.[0]?.track ?? likes?.collection?.[0];
    trackId = first?.id;
  }
  if (trackId == null) {
    throw new Error("No hay favoritos para comprobar la calidad");
  }

  const track = await apiGet(`/tracks/${trackId}`, opts.oauthToken, cid);
  const transcodings = track?.media?.transcodings ?? [];
  return transcodings.some(
    (t: { quality?: string }) => t?.quality === "hq",
  );
}
