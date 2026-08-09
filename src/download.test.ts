import { describe, expect, it } from "bun:test";
import type { DownloadOptions } from "./download";

const { buildDownloadArgs, parseEntriesOutput } = await import("./download");

const base: DownloadOptions = {
  ytdlp: "/usr/bin/yt-dlp",
  cookiesFile: "/cookies.txt",
  username: "usuario",
  outDir: "/out",
};

function argsOf(o: Partial<DownloadOptions> = {}): string[] {
  return buildDownloadArgs({ ...base, ...o });
}

describe("buildDownloadArgs", () => {
  it("usa m4a 320K por defecto y el enlace de favoritos", () => {
    const a = argsOf();
    expect(a).toEqual(expect.arrayContaining(["-f", "bestaudio/best"]));
    expect(a).toEqual(expect.arrayContaining(["-x", "--audio-format", "m4a"]));
    expect(a).toEqual(expect.arrayContaining(["--audio-quality", "320K"]));
    expect(a).toEqual(expect.arrayContaining(["--no-overwrites"]));
    expect(a[a.length - 1]).toBe("https://soundcloud.com/usuario/likes");
  });

  it("incluye las medidas anti-baneo", () => {
    const a = argsOf();
    expect(a).toEqual(
      expect.arrayContaining([
        "--impersonate",
        "chrome",
        "--concurrent-fragments",
        "1",
        "--retries",
        "3",
        "--sleep-interval",
        "3",
        "--max-sleep-interval",
        "7",
      ]),
    );
  });

  it("pasa el archivo de cookies y -o con la plantilla", () => {
    const a = argsOf();
    expect(a).toEqual(expect.arrayContaining(["--cookies", "/cookies.txt"]));
    expect(a[a.indexOf("-o") + 1]).toBe("/out/%(title)s - %(artist)s.%(ext)s");
  });

  it("el formato 'original' no convierte", () => {
    const a = argsOf({ format: "original" });
    expect(a).not.toContain("-x");
    expect(a).not.toContain("--audio-format");
  });

  it("los formatos sin pérdida no llevan --audio-quality", () => {
    for (const f of ["flac", "wav"]) {
      const a = argsOf({ format: f });
      expect(a).toContain("--audio-format");
      expect(a).not.toContain("--audio-quality");
    }
  });

  it("usa el bitrate configurado", () => {
    const a = argsOf({ format: "mp3", bitrate: "192K" });
    expect(a).toEqual(expect.arrayContaining(["--audio-quality", "192K"]));
  });

  it("usa el quality legacy como bitrate", () => {
    const a = argsOf({ format: "mp3", quality: "128K" });
    expect(a).toEqual(expect.arrayContaining(["--audio-quality", "128K"]));
  });

  it("aplica una plantilla de nombre personalizada", () => {
    const a = argsOf({ filenameTemplate: "%(id)s - %(title)s" });
    expect(a[a.indexOf("-o") + 1]).toBe("/out/%(id)s - %(title)s.%(ext)s");
  });

  it("pasa urls en lugar de los favoritos", () => {
    const a = argsOf({ urls: ["https://soundcloud.com/a/b"] });
    expect(a[a.length - 1]).toBe("https://soundcloud.com/a/b");
  });

  it("pasa una url concreta en lugar de los favoritos", () => {
    const a = argsOf({ url: "https://soundcloud.com/x/y" });
    expect(a[a.length - 1]).toBe("https://soundcloud.com/x/y");
  });

  it("añade --download-archive si se indica", () => {
    const a = argsOf({ archiveFile: "/archive.txt" });
    expect(a).toEqual(
      expect.arrayContaining(["--download-archive", "/archive.txt"]),
    );
  });

  it("omitir skipExisting quita --no-overwrites", () => {
    const a = argsOf({ skipExisting: false });
    expect(a).not.toContain("--no-overwrites");
  });

  it("incluye --ffmpeg-location si se indica el directorio", () => {
    const a = argsOf({ ffmpegDir: "/ff" });
    expect(a).toEqual(expect.arrayContaining(["--ffmpeg-location", "/ff"]));
  });
});

describe("parseEntriesOutput", () => {
  it("parsea líneas JSON y extrae url y subidor", () => {
    const stdout = [
      JSON.stringify({ id: "1", title: "Canción A", webpage_url: "https://soundcloud.com/subidor/cancion-a", uploader: "subidor" }),
      JSON.stringify({ id: "2", title: "Canción B", url: "https://soundcloud.com/otro/cancion-b" }),
    ].join("\n");
    const { entries, tokenInvalid } = parseEntriesOutput(stdout, "");
    expect(entries).toHaveLength(2);
    expect(entries[0].uploader).toBe("subidor");
    // Sin uploader, lo saca del webpage_url.
    expect(entries[1].uploader).toBe("otro");
    expect(tokenInvalid).toBe(false);
  });

  it("detecta token inválido en stderr", () => {
    const { tokenInvalid } = parseEntriesOutput("", "ERROR: unable to login: invalid");
    expect(tokenInvalid).toBe(true);
  });

  it("ignora entradas sin url y JSON inválidos", () => {
    const stdout = [
      JSON.stringify({ id: "1", title: "ok", url: "https://soundcloud.com/a/b" }),
      JSON.stringify({ id: "2", title: "sin url" }),
      "no-json",
    ].join("\n");
    const { entries } = parseEntriesOutput(stdout, "");
    expect(entries).toHaveLength(1);
  });

  it("devuelve lista vacía con salida vacía", () => {
    expect(parseEntriesOutput("", "").entries).toEqual([]);
  });
});
