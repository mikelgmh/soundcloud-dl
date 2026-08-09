// Chequeo del ajuste "High quality streaming" de SoundCloud.
//
// SoundCloud entrega transcodings de calidad alta (AAC 256 kbps) marcadas con
// `quality: "hq"` SOLO si la cuenta tiene el streaming de alta calidad activado
// (requiere suscripción Go+ / Next Pro). Sin él, solo aparecen `lq` y `sq`.
// No hay endpoint documentado para cambiarlo vía API, así que solo se consulta.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

let cachedClientId: string | null = null;

/** Obtiene el client_id de la web de SoundCloud (igual que hace yt-dlp). */
async function fetchClientId(): Promise<string> {
  if (cachedClientId) return cachedClientId;
  const res = await fetch("https://soundcloud.com/", {
    headers: { "User-Agent": UA },
  });
  const html = await res.text();
  let cid = html.match(/client_id["']?\s*[:=]\s*["']([0-9a-zA-Z]{32})["']/)?.[1];
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
  return cid;
}

/** Comprueba si la cuenta autenticada recibe transcodings de alta calidad. */
export async function checkHighQualityStreaming(opts: {
  oauthToken: string;
  trackUrl: string;
}): Promise<boolean> {
  const cid = await fetchClientId();
  const url = `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(
    opts.trackUrl,
  )}&client_id=${cid}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Authorization: `OAuth ${opts.oauthToken}`,
    },
  });
  if (!res.ok) throw new Error(`SoundCloud API ${res.status}`);
  const track = await res.json();
  const transcodings = track?.media?.transcodings ?? [];
  return transcodings.some(
    (t: { quality?: string }) => t?.quality === "hq",
  );
}
