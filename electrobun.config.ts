import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "SoundCloud Downloader",
    identifier: "dev.soundcloud.downloader",
    version: "0.1.0",
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
  release: {
    // Los artefactos de actualización se suben a GitHub Releases; la URL
    // "latest" siempre resuelve a la última versión estable publicada.
    baseUrl: "https://github.com/mikelgmh/soundcloud-dl/releases/latest/download",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
      // Playwright no se empaqueta: necesita sus binarios nativos en
      // node_modules (se resuelve en runtime).
      external: ["playwright"],
    },
    views: {
      mainview: {
        entrypoint: "src/mainview/index.ts",
      },
    },
    copy: {
      "src/mainview/index.html": "views/mainview/index.html",
      "src/mainview/index.css": "views/mainview/index.css",
    },
    watch: ["src/mainview/input.css"],
  },
  scripts: {
    preBuild: "./scripts/prebuild.ts",
  },
} satisfies ElectrobunConfig;
