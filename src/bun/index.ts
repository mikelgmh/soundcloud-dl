import {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  Updater,
  Utils,
} from "electrobun/bun";
import type { AppRPCSchema } from "../shared/types";
import { Service, type Emitter } from "./service";
import { loginWithElectrobunWindow } from "./login";
import { detectSystemLang, t } from "../shared/i18n";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Lengua efectiva para los mensajes de actualización emitidos desde el main.
const lang = detectSystemLang();

let service!: Service;

const rpc = BrowserView.defineRPC<AppRPCSchema>({
  // Las operaciones largas (login, descargas) no deben tener timeout.
  maxRequestTime: Infinity,
  handlers: {
    requests: {
      getStatus: async () => service.getStatus(),
      checkDeps: async () => service.checkDeps(),
      installDeps: async () => service.installDeps(),
      checkForUpdates: async () => service.checkForUpdates(),
      checkAppUpdate: async () => checkAppUpdate(),
      applyAppUpdate: async () => applyAppUpdate(),
      getConfig: async () => service.getConfig(),
      getAppInfo: async () => {
        const info = await Updater.getLocalInfo();
        return service.getAppInfo({ version: info.version, channel: info.channel });
      },
      openExternal: async ({ url }) => ({ ok: Utils.openExternal(url) }),
      saveConfig: async (patch) => service.saveConfig(patch),
      login: async () => service.login(),
      loginWithToken: async ({ token }) => service.loginWithToken(token),
      logout: async () => service.logout(),
      selectFolder: async () => service.selectFolder(),
      refreshLikes: async () => service.refreshLikes(),
      getLikesCache: async () => service.getLikesCache(),
      getSyncStats: async () => service.getSyncStats(),
      getDownloadedIds: async () => service.getDownloadedIds(),
      downloadUrl: async ({ url }) => service.downloadUrl(url),
      exportConfig: async () => service.exportConfig(),
      importConfig: async ({ json }) => service.importConfig(json),
      getHistory: async () => service.getHistory(),
      cleanupNonFavorites: async () => service.cleanupNonFavorites(),
      getPlaylists: async () => service.getPlaylists(),
      getPlaylistTracks: async ({ url }) => service.getPlaylistTracks(url),
      searchSoundcloud: async ({ query }) => service.searchSoundcloud(query),
      downloadUrls: async ({ urls }) => service.downloadUrls(urls),
      downloadAll: async () => service.downloadAll(),
      downloadTrack: async ({ url }) => service.downloadTrack(url),
      cancelDownload: async () => service.cancelDownload(),
      pauseDownload: async () => service.pauseDownload(),
      resumeDownload: async () => service.resumeDownload(),
    },
    messages: {},
  },
});

// Envía mensajes desde el proceso main hacia la UI.
const emit: Emitter = {
  log: (level, text) => rpc.send.log({ level, text }),
  status: (stage, message) => rpc.send.status({ stage, message }),
  progress: (p) => rpc.send.downloadProgress(p),
};

service = new Service(
  emit,
  loginWithElectrobunWindow,
  async () => {
    try {
      const paths = await Utils.openFileDialog({
        canChooseFiles: false,
        canChooseDirectory: true,
        allowsMultipleSelection: false,
      });
      return paths?.[0] ?? null;
    } catch {
      return null;
    }
  },
);

/** Auto-actualización de la app (solo en builds estables). Solo DETECTA si hay
 *  una versión nueva; la descarga/aplicación se hace al pulsar "Actualizar"
 *  (applyAppUpdate). Nunca reinicia sola. */
async function checkAppUpdate(): Promise<{
  updateAvailable: boolean;
  updateReady: boolean;
  version?: string;
}> {
  try {
    const info = await Updater.getLocalInfo();
    if (info.channel !== "stable") {
      return { updateAvailable: false, updateReady: false };
    }
    const res = await Updater.checkForUpdate();
    if (!res.updateAvailable) {
      return { updateAvailable: false, updateReady: false };
    }
    // Guard anti falso positivo: si la versión del servidor coincide con la
    // instalada, no hay actualización (el hash puede diferir entre builds del
    // mismo release, pero la versión ya está instalada).
    if (res.version && info.version && res.version === info.version) {
      return { updateAvailable: false, updateReady: false };
    }
    return { updateAvailable: true, updateReady: false, version: res.version };
  } catch {
    return { updateAvailable: false, updateReady: false };
  }
}

/** Descarga y aplica la actualización, reiniciando la app al terminar. */
async function applyAppUpdate(): Promise<{ ok: boolean }> {
  try {
    rpc.send.status({
      stage: "update",
      message: t(lang, "update.downloading"),
    });
    await Updater.downloadUpdate();
    const ready = Updater.updateInfo?.()?.updateReady ?? false;
    if (!ready) {
      rpc.send.status({
        stage: "update",
        message: t(lang, "update.downloadFailed"),
      });
      return { ok: false };
    }
    rpc.send.status({
      stage: "update",
      message: t(lang, "update.ready"),
    });
    // Da tiempo a que la UI muestre el aviso antes de reiniciar.
    await sleep(1500);
    await Updater.applyUpdate();
    return { ok: true };
  } catch (err) {
    rpc.send.status({
      stage: "update",
      message: t(lang, "update.applyFailed"),
    });
    return { ok: false };
  }
}

ApplicationMenu.setApplicationMenu([
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle" },
      { role: "delete" },
      { role: "selectAll" },
    ],
  },
]);

new BrowserWindow({
  title: "SoundCloud Downloader",
  url: "views://mainview/index.html",
  frame: { x: 180, y: 120, width: 1080, height: 760 },
  rpc,
});
