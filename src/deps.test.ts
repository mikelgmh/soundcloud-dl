import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// apunta las rutas de datos a un directorio temporal antes de importar ./deps.
const tmp = mkdtempSync(path.join(os.tmpdir(), "snd-deps-test-"));
process.env.SOUNDCLOUD_DOWNLOADER_DIR = tmp;

const store = await import("./store");
const deps = await import("./deps");

const mkexe = (dir: string, name: string, script: string): string => {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, script, { mode: 0o755 });
  return p;
};

describe("makeToolVersion", () => {
  it("sin versiones actuales ni latest no hay update", () => {
    const v = deps.makeToolVersion(null, null);
    expect(v).toEqual({ current: null, latest: null, hasUpdate: false });
  });

  it("hay update si latest > current", () => {
    expect(deps.makeToolVersion("2024.01.01", "2025.02.03").hasUpdate).toBe(true);
  });

  it("no hay update si latest <= current", () => {
    expect(deps.makeToolVersion("2025.02.03", "2025.02.03").hasUpdate).toBe(false);
    expect(deps.makeToolVersion("2025.02.03", "2024.01.01").hasUpdate).toBe(false);
  });

  it("no hay update si falta alguna de las dos", () => {
    expect(deps.makeToolVersion(null, "2025.02.03").hasUpdate).toBe(false);
    expect(deps.makeToolVersion("2024.01.01", null).hasUpdate).toBe(false);
  });
});

describe("getStoredYtDlpVersion", () => {
  it("devuelve null sin marca", () => {
    expect(deps.getStoredYtDlpVersion("/nada/yt-dlp")).toBeNull();
  });

  it("devuelve la versión de la marca si el binario no cambió", () => {
    const bin = mkexe(path.join(tmp, "b1"), "yt-dlp", "#!/bin/sh\nexit 0\n");
    const st = fs.statSync(bin);
    const marker = path.join(store.SND_DIR, ".ytdlp-verified.json");
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(
      marker,
      JSON.stringify({ path: bin, size: st.size, mtimeMs: st.mtimeMs, version: "2025.03.10" }),
    );
    expect(deps.getStoredYtDlpVersion(bin)).toBe("2025.03.10");
  });

  it("devuelve null si el binario cambió (tamaño distinto)", () => {
    const bin = mkexe(path.join(tmp, "b2"), "yt-dlp", "#!/bin/sh\nexit 0\n");
    const marker = path.join(store.SND_DIR, ".ytdlp-verified.json");
    fs.writeFileSync(
      marker,
      JSON.stringify({ path: bin, size: 999, mtimeMs: 1, version: "2025.03.10" }),
    );
    expect(deps.getStoredYtDlpVersion(bin)).toBeNull();
  });
});

describe("readYtDlpVersion", () => {
  it("lee la versión de un binario que responde a --version", async () => {
    const bin = mkexe(path.join(tmp, "b3"), "yt-dlp", "#!/bin/sh\necho '2025.03.10'\n");
    expect(await deps.readYtDlpVersion(bin)).toBe("2025.03.10");
  });

  it("devuelve null si el binario falla", async () => {
    const bin = mkexe(path.join(tmp, "b4"), "yt-dlp", "#!/bin/sh\nexit 1\n");
    expect(await deps.readYtDlpVersion(bin)).toBeNull();
  });
});

describe("getFfmpegVersion", () => {
  it("extrae la versión de ffmpeg -version", async () => {
    const dir = path.join(tmp, "ff");
    mkexe(
      dir,
      "ffmpeg",
      "#!/bin/sh\necho 'ffmpeg version 7.1.4 Copyright (c) 2000-2024'\n",
    );
    expect(await deps.getFfmpegVersion(dir)).toBe("7.1.4");
  });

  it("devuelve null si no hay binario", async () => {
    expect(await deps.getFfmpegVersion(path.join(tmp, "nope"))).toBeNull();
  });
});

describe("checkYtDlpUpdate", () => {
  it("no actualiza si el binario no es de la app (fuera de BIN_DIR)", async () => {
    const ok = await deps.checkYtDlpUpdate(
      "/usr/local/bin/yt-dlp",
      undefined,
      { tag: "2025.99.99", url: "https://example.com/yt-dlp" },
    );
    expect(ok).toBe(false);
  });

  it("no actualiza si latest <= current", async () => {
    const bin = mkexe(store.BIN_DIR, "yt-dlp", "#!/bin/sh\necho '2025.01.01'\n");
    const ok = await deps.checkYtDlpUpdate(
      bin,
      undefined,
      { tag: "2025.01.01", url: "https://example.com/yt-dlp" },
    );
    expect(ok).toBe(false);
  });
});
