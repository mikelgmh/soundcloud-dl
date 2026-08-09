import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// store.ts calcula las rutas al importarse; apuntamos a un directorio temporal
// antes de importarlo para no tocar datos reales.
const tmp = mkdtempSync(path.join(os.tmpdir(), "snd-store-test-"));
process.env.SOUNDCLOUD_DOWNLOADER_DIR = tmp;

const store = await import("./store");

describe("rutas", () => {
  it("usa un directorio de datos temporal (env var)", () => {
    expect(store.DATA_ROOT.startsWith(os.tmpdir())).toBe(true);
    expect(store.SND_DIR).toBe(path.join(store.DATA_ROOT, ".snd"));
  });
});

describe("config", () => {
  it("loadConfig devuelve {} si no existe", () => {
    expect(store.loadConfig()).toEqual({});
  });

  it("guarda y carga la configuración", () => {
    store.saveConfig({ username: "pepe", format: "mp3", bitrate: "192K" });
    const c = store.loadConfig();
    expect(c.username).toBe("pepe");
    expect(c.format).toBe("mp3");
    expect(c.bitrate).toBe("192K");
  });

  it("sobrescribe campos en saveConfig", () => {
    store.saveConfig({ username: "pepe", theme: "light" });
    expect(store.loadConfig()).toMatchObject({
      username: "pepe",
      theme: "light",
    });
  });
});

describe("writeCookiesFile", () => {
  it("escribe el archivo de cookies Netscape con el token", () => {
    const p = store.writeCookiesFile("tok123");
    expect(p).toBe(store.COOKIES_FILE);
    const text = fs.readFileSync(p, "utf8");
    expect(text).toContain("# Netscape HTTP Cookie File");
    expect(text).toContain(".soundcloud.com");
    expect(text).toContain("oauth_token\ttok123");
  });

  it("guarda el archivo con permisos 0600", () => {
    const mode = fs.statSync(store.COOKIES_FILE).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("caché de likes", () => {
  it("guarda y recupera por usuario", () => {
    const tracks = [
      { id: "1", title: "A", url: "https://soundcloud.com/u/a", index: 0 },
      { id: "2", title: "B", url: "https://soundcloud.com/u/b", index: 1 },
    ];
    store.saveLikesCache("miusuario", tracks);
    const cached = store.loadLikesCache("miusuario");
    expect(cached?.tracks).toHaveLength(2);
    expect(cached?.tracks[0].id).toBe("1");
    expect(cached?.cachedAt).toBeGreaterThan(0);
  });

  it("sanea el nombre de usuario para el nombre de archivo", () => {
    store.saveLikesCache("usuario raro/", [{ id: "3", title: "C", url: "u", index: 0 }]);
    expect(store.loadLikesCache("usuario raro/")?.tracks).toHaveLength(1);
  });

  it("devuelve null si no hay caché", () => {
    expect(store.loadLikesCache("no-existe")).toBeNull();
  });

  it("devuelve null si el JSON está corrupto o tracks no es lista", () => {
    const corrupt = path.join(store.SND_DIR, "likes-corrupto.json");
    fs.writeFileSync(corrupt, "{no es json");
    const mal = path.join(store.SND_DIR, "likes-mal.json");
    fs.writeFileSync(mal, JSON.stringify({ cachedAt: 1, tracks: "nope" }));
    expect(store.loadLikesCache("corrupto")).toBeNull();
    expect(store.loadLikesCache("mal")).toBeNull();
  });
});

describe("readArchiveIds", () => {
  it("devuelve set vacío si no hay archivo", () => {
    expect(store.readArchiveIds().size).toBe(0);
  });

  it("extrae el id como último token de cada línea", () => {
    fs.writeFileSync(
      store.ARCHIVE_FILE,
      "https://soundcloud.com/a/b soundcloud 12345\nhttps://soundcloud.com/c/d soundcloud 67890\n",
    );
    const ids = store.readArchiveIds();
    expect(ids.has("12345")).toBe(true);
    expect(ids.has("67890")).toBe(true);
    expect(ids.has("9999")).toBe(false);
  });
});

describe("historial", () => {
  it("appendHistory y readHistory devuelven lo último primero", () => {
    store.appendHistory({ ts: 1, target: "a", format: "mp3", ok: true });
    store.appendHistory({ ts: 2, target: "b", format: "mp3", ok: false });
    const items = store.readHistory();
    expect(items).toHaveLength(2);
    expect(items[0].target).toBe("b");
    expect(items[1].target).toBe("a");
  });

  it("respeta el límite", () => {
    store.appendHistory({ ts: 3, target: "c", format: "mp3", ok: true });
    store.appendHistory({ ts: 4, target: "d", format: "mp3", ok: true });
    store.appendHistory({ ts: 5, target: "e", format: "mp3", ok: true });
    const items = store.readHistory(2);
    expect(items).toHaveLength(2);
    expect(items[0].target).toBe("e");
  });

  it("ignora líneas corruptas", () => {
    fs.appendFileSync(store.HISTORY_FILE, "no es json\n");
    const items = store.readHistory();
    expect(items.every((i) => typeof i.ok === "boolean")).toBe(true);
  });
});
