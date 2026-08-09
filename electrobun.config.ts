import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "SoundCloud Downloader",
    identifier: "dev.soundcloud.downloader",
    version: "0.7.1",
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
    },
    views: {
      mainview: {
        entrypoint: "src/mainview/index.ts",
      },
    },
    copy: {
      "src/mainview/index.html": "views/mainview/index.html",
      "src/mainview/index.css": "views/mainview/index.css",
      "src/connecting/index.html": "views/connecting/index.html",
    },
    watch: ["src/mainview/input.css"],
  },
  scripts: {
    preBuild: "./scripts/prebuild.ts",
  },
} satisfies ElectrobunConfig;
