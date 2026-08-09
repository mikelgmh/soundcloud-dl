import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Emitter, LoginBrowserFn } from "./service";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Entorno aislado: directorio temporal para los datos (config, cookies, etc.).
const tmp = mkdtempSync(path.join(os.tmpdir(), "snd-svc-test-"));
process.env.SOUNDCLOUD_DOWNLOADER_DIR = tmp;

// --- Mocks ---
// login.ts importa electrobun/bun a nivel de módulo; lo sustituimos para que
// la importación no cuelgue (electrobun/bun requiere el runtime de la app).
let notifyImpl: () => void = () => {};
mock.module("electrobun/bun", () => ({
  BrowserWindow: class {},
  Session: {
    defaultSession: {
      cookies: { get: () => [] as never[], remove: () => {} },
    },
  },
  Utils: {
    showNotification: () => notifyImpl(),
    openFileDialog: async () => null,
  },
}));

const { Service } = await import("./service");

// --- runStream inyectado (DI) ---
const stream = {
  calls: 0,
  last: null as {
    args: string[];
    signal?: AbortSignal;
    controller?: { pause(): void; resume(): void };
  } | null,
  release: null as ((code: number) => void) | null,
  pause: 0,
  resume: 0,
  aborted: false,
};

const resetStream = () => {
  stream.calls = 0;
  stream.last = null;
  stream.release = null;
  stream.pause = 0;
  stream.resume = 0;
  stream.aborted = false;
};

const fakeRunStream = (
  args: string[],
  opts?: { signal?: AbortSignal; controller?: { pause(): void; resume(): void } },
): Promise<number> => {
  stream.calls++;
  stream.last = { args, signal: opts?.signal, controller: opts?.controller };
  if (opts?.controller) {
    const base = { ...opts.controller };
    opts.controller.pause = () => {
      stream.pause++;
      base.pause?.();
    };
    opts.controller.resume = () => {
      stream.resume++;
      base.resume?.();
    };
  }
  stream.aborted = false;
  opts?.signal?.addEventListener("abort", () => {
    stream.aborted = true;
  });
  return new Promise<number>((res) => {
    stream.release = res;
  });
};

// Utilidades del test
const outdir = path.join(tmp, "out");
const noopEmitter = () =>
  ({
    log: () => {},
    status: () => {},
    progress: () => {},
  }) as Emitter;

const makeService = (
  runner = fakeRunStream,
  loginBrowser: LoginBrowserFn = async () => ({ oauthToken: "tok-fake-123", username: "usuario" }),
) =>
  new Service(
    noopEmitter(),
    loginBrowser,
    async () => "/carpeta",
    runner,
    { ytdlp: "/fake/yt-dlp", ffmpegDir: null },
  );

const waitForStream = async (n = 1) => {
  const end = Date.now() + 2000;
  while (stream.calls < n && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(stream.calls).toBe(n);
};

// Los test files comparten proceso y módulo de store; limpiamos el estado
// persistido para que cada test parta de cero.
beforeEach(async () => {
  resetStream();
  const store = await import("../store");
  fs.rmSync(path.join(store.SND_DIR, "config.json"), { force: true });
  fs.rmSync(store.HISTORY_FILE, { force: true });
});

describe("Service: configuración", () => {
  it("getStatus devuelve el estado con valores por defecto", async () => {
    const s = makeService();
    const st = await s.getStatus();
    expect(st.config.format).toBe("mp3");
    expect(st.config.bitrate).toBe("320K");
    expect(st.config.theme).toBe("dark");
    expect(st.config.skipExisting).toBe(true);
    expect(st.config.hasToken).toBe(false);
    expect(st.likesCount).toBeNull();
  });

  it("saveConfig persiste y devuelve el payload", () => {
    const s = makeService();
    const p = s.saveConfig({ username: "x", format: "flac", bitrate: "192K" });
    expect(p.format).toBe("flac");
    expect(p.bitrate).toBe("192K");
    expect(s.getConfig().username).toBe("x");
  });

  it("saveConfig con oauthToken '' borra la sesión", () => {
    const s = makeService();
    s.saveConfig({ oauthToken: "tok-fake-123" });
    expect(s.getConfig().hasToken).toBe(true);
    s.saveConfig({ oauthToken: "" });
    expect(s.getConfig().hasToken).toBe(false);
  });

  it("migra la plantilla legacy al valor por defecto", () => {
    const s = makeService();
    s.saveConfig({ filenameTemplate: "%(uploader)s - %(title)s [%(id)s]" });
    expect(s.getConfig().filenameTemplate).toBe("%(title)s - %(artist)s");
  });
});

describe("Service: autenticación", () => {
  it("login guarda el token y el usuario", async () => {
    const s = makeService();
    const res = await s.login();
    expect(res.oauthToken).toBe("tok-fake-123");
    const saved = (await import("../store")).loadConfig();
    expect(saved.oauthToken).toBe("tok-fake-123");
    expect(saved.username).toBe("usuario");
  });

  it("loginWithToken valida la longitud mínima", async () => {
    const s = makeService();
    expect(() => s.loginWithToken("abc")).toThrow();
    await s.loginWithToken("un-token-muy-largo-12345");
    const saved = (await import("../store")).loadConfig();
    expect(saved.oauthToken).toBe("un-token-muy-largo-12345");
  });

  it("logout borra el token", async () => {
    const s = makeService();
    await s.login();
    expect(s.getConfig().hasToken).toBe(true);
    s.logout();
    expect(s.getConfig().hasToken).toBe(false);
  });

  it("exportConfig no incluye el token", async () => {
    const s = makeService();
    await s.login();
    const parsed = JSON.parse(s.exportConfig().json);
    expect(parsed.oauthToken).toBeUndefined();
    expect(parsed.username).toBe("usuario");
  });

  it("importConfig aplica la configuración sin el token", () => {
    const s = makeService();
    s.importConfig(JSON.stringify({ outdir: "/x", format: "wav" }));
    expect(s.getConfig().outdir).toBe("/x");
    expect(s.getConfig().format).toBe("wav");
    expect(() => s.importConfig("no-json")).toThrow();
  });
});

describe("Service: utilidades", () => {
  it("selectFolder devuelve la ruta elegida", async () => {
    const s = makeService();
    expect(await s.selectFolder()).toEqual({ path: "/carpeta" });
  });

  it("selectFolder devuelve null si el picker falla", async () => {
    const s = new Service(
      noopEmitter(),
      async () => ({ oauthToken: "tok", username: "u" }),
      async () => {
        throw new Error("cancelado");
      },
      fakeRunStream,
    );
    expect(await s.selectFolder()).toEqual({ path: null });
  });

  it("downloadUrl rechaza enlaces que no son de SoundCloud", async () => {
    const s = makeService();
    expect(() => s.downloadUrl("https://example.com/x")).toThrow();
  });

  it("getDownloadedIds refleja el archivo de sincronización", async () => {
    const store = await import("../store");
    fs.writeFileSync(store.ARCHIVE_FILE, "x soundcloud 42\n");
    const s = makeService();
    expect(s.getDownloadedIds().ids).toContain("42");
  });
});

describe("Service: descargas", () => {
  beforeEach(() => resetStream());

  const loggedInService = () => {
    const s = makeService();
    s.saveConfig({ username: "usuario", oauthToken: "tok-fake-123", outdir });
    return s;
  };

  it("pausa y reanuda la descarga en curso", async () => {
    const s = loggedInService();
    const p = s.downloadAll();
    await waitForStream();
    s.pauseDownload();
    s.resumeDownload();
    expect(stream.pause).toBe(1);
    expect(stream.resume).toBe(1);
    stream.release!(0);
    await p;
  });

  it("cancela la descarga (aborta la señal)", async () => {
    const s = loggedInService();
    const p = s.downloadAll();
    await waitForStream();
    s.cancelDownload();
    expect(stream.aborted).toBe(true);
    stream.release!(-1);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.code).toBe(-1);
  });

  it("serializa las descargas (una a la vez)", async () => {
    const s = loggedInService();
    const p1 = s.downloadAll();
    await waitForStream(1);
    const p2 = s.downloadAll();
    await new Promise((r) => setTimeout(r, 30));
    expect(stream.calls).toBe(1);
    stream.release!(0);
    await p1;
    await waitForStream(2);
    stream.release!(0);
    await p2;
  });

  it("registra el historial al completar (favoritos)", async () => {
    const s = loggedInService();
    const p = s.downloadAll();
    await waitForStream();
    stream.release!(0);
    const r = await p;
    expect(r.ok).toBe(true);
    const items = s.getHistory().items;
    expect(items[0]).toMatchObject({ target: "favoritos", ok: true, format: "mp3" });
  });

  it("muestra notificación al completar", async () => {
    let notified = false;
    notifyImpl = () => {
      notified = true;
    };
    const s = loggedInService();
    const p = s.downloadAll();
    await waitForStream();
    stream.release!(0);
    await p;
    expect(notified).toBe(true);
  });
});

describe("Service: colección", () => {
  it("getSyncStats cuenta descargadas y pendientes desde la caché", async () => {
    const store = await import("../store");
    const s = makeService();
    s.saveConfig({ username: "usuario", oauthToken: "tok-fake-123" });
    store.saveLikesCache("usuario", [
      { id: "111", title: "A", url: "u/a", index: 0 },
      { id: "222", title: "B", url: "u/b", index: 1 },
    ]);
    fs.writeFileSync(store.ARCHIVE_FILE, "x soundcloud 111\n");
    const st = await s.getSyncStats();
    expect(st.total).toBe(2);
    expect(st.downloaded).toBe(1);
    expect(st.missing).toBe(1);
  });

  it("cleanupNonFavorites borra solo archivos fuera de favoritos", async () => {
    const store = await import("../store");
    const s = makeService();
    s.saveConfig({ username: "usuario", oauthToken: "tok-fake-123", outdir });
    store.saveLikesCache("usuario", [{ id: "222", title: "B", url: "u/b", index: 0 }]);
    fs.writeFileSync(store.ARCHIVE_FILE, "x soundcloud 111\nx2 soundcloud 222\n");
    fs.mkdirSync(outdir, { recursive: true });
    fs.writeFileSync(path.join(outdir, "Song A [111].mp3"), "x");
    fs.writeFileSync(path.join(outdir, "Song B [222].mp3"), "x");
    const { removed } = await s.cleanupNonFavorites();
    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain("Song A [111].mp3");
    expect(fs.existsSync(path.join(outdir, "Song B [222].mp3"))).toBe(true);
  });
});
