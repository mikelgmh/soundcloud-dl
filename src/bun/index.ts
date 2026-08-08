import { ApplicationMenu, BrowserView, BrowserWindow, Updater } from "electrobun/bun";
import type { AppRPCSchema } from "../shared/types";
import { Service, type Emitter } from "./service";
import { loginWithElectrobunWindow } from "./login";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
      getConfig: async () => service.getConfig(),
      saveConfig: async (patch) => service.saveConfig(patch),
      login: async () => service.login(),
      loginWithToken: async ({ token }) => service.loginWithToken(token),
      refreshLikes: async () => service.refreshLikes(),
      getLikesCache: async () => service.getLikesCache(),
      downloadAll: async () => service.downloadAll(),
      downloadTrack: async ({ url }) => service.downloadTrack(url),
      cancelDownload: async () => service.cancelDownload(),
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

service = new Service(emit, loginWithElectrobunWindow);

/** Auto-actualización de la app (solo en builds estables). */
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
    rpc.send.status({
      stage: "update",
      message: `Nueva versión ${res.version}. Descargando actualización...`,
    });
    await Updater.downloadUpdate();
    const ready = Updater.updateInfo?.()?.updateReady ?? false;
    if (ready) {
      rpc.send.status({
        stage: "update",
        message: "Actualización lista. La app se reiniciará automáticamente.",
      });
      // Da tiempo a que la UI muestre el aviso antes de reiniciar.
      await sleep(2500);
      await Updater.applyUpdate();
    }
    return { updateAvailable: true, updateReady: ready, version: res.version };
  } catch (err) {
    rpc.send.status({
      stage: "update",
      message: "No se pudo comprobar si hay actualizaciones.",
    });
    return { updateAvailable: false, updateReady: false };
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
