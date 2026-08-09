import { Electroview } from "electrobun/view";
import type {
  AppRPCSchema,
  ConfigPayload,
  DepsStatus,
  DepVersionInfo,
  DownloadProgressPayload,
  HistoryItemPayload,
  LikedTrackPayload,
  LogLevel,
  StatusSnapshot,
} from "../shared/types";
import {
  LANG_LABELS,
  resolveLang,
  SUPPORTED_LANGS,
  t,
  type Lang,
  type Vars,
} from "../shared/i18n";

// ---- Internacionalización ----
let currentLang: Lang = resolveLang();
/** true cuando el usuario cambia el idioma a mano; evita que seedSettings lo
 *  revierta al idioma guardado en la config antes de pulsar "Guardar". */
let langUserSet = false;

/** Traduce con la lengua activa (shortcut). */
function T(key: string, vars?: Vars): string {
  return t(currentLang, key, vars);
}

/** Aplica las traducciones a los elementos estáticos del DOM. */
function applyStaticTranslations(): void {
  document.documentElement.lang = currentLang;
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    el.textContent = T(el.dataset.i18n!);
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-ph]")) {
    el.setAttribute("placeholder", T(el.dataset.i18nPh!));
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
    el.setAttribute("title", T(el.dataset.i18nTitle!));
  }
}

/** Cambia la lengua activa. Con reRender=true (solo cambio de usuario) se
 *  re-renderiza la interfaz dinámica. seedSettings la llama con false para
 *  evitar recursión con loadStatus. */
function setLang(lang: Lang, reRender = false): void {
  currentLang = lang;
  applyStaticTranslations();
  renderLanguageSelect();
  if (reRender && isApp) {
    loadStatus();
    renderSyncStats();
    renderHistory();
    renderQueue();
    renderStats();
    renderCollection();
    refreshDownloadedIds();
  }
}

let api: AppRPCSchema extends never ? never : any = null;

try {
  const rpc = Electroview.defineRPC<AppRPCSchema>({
    // Las operaciones largas (instalar deps, login, descargas) no deben
    // agotar el timeout por defecto de 1000ms.
    maxRequestTime: Infinity,
    handlers: {
      requests: {},
      messages: {
        log: ({ level, text }) => appendLog(level, text),
        status: ({ stage, message }) => updateStatus(stage, message),
        downloadProgress: (p) => updateProgress(p),
      },
    },
  });
  const eb = new Electroview({ rpc });
  api = eb.rpc;
} catch (err) {
  console.warn("Puente electrobun no disponible:", err);
}

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

// ---- Texto animado (efecto odómetro por dígito) ----
const ODOMETER_ANIM = 300;

/** Lee el texto lógico actual (textos + celdas de dígito). */
function getOdometerText(el: HTMLElement): string {
  let out = "";
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? "";
    } else if (node instanceof HTMLElement) {
      out += node.dataset.ch ?? node.textContent ?? "";
    }
  }
  return out;
}

/** Celda de un carácter: solo anima si cambia el carácter. */
function makeOdigitCell(oldChar: string, newChar: string): HTMLElement {
  const cell = document.createElement("span");
  cell.className = "odigit";
  cell.dataset.ch = newChar;

  if (!oldChar) {
    // Solo entra el carácter nuevo (desde abajo).
    const inner = document.createElement("span");
    inner.className = "slide-in-up";
    inner.textContent = newChar;
    cell.appendChild(inner);
    setTimeout(() => {
      inner.classList.remove("slide-in-up");
      inner.style.position = "relative";
    }, ODOMETER_ANIM);
    return cell;
  }

  // El anterior sale hacia arriba.
  const oldS = document.createElement("span");
  oldS.className = "slide-out-up";
  oldS.textContent = oldChar;
  cell.appendChild(oldS);

  if (newChar) {
    // El nuevo entra desde abajo.
    const newS = document.createElement("span");
    newS.className = "slide-in-up";
    newS.style.position = "absolute";
    newS.style.top = "0";
    newS.style.left = "0";
    newS.textContent = newChar;
    cell.appendChild(newS);
    setTimeout(() => {
      oldS.remove();
      newS.classList.remove("slide-in-up");
      newS.style.position = "relative";
    }, ODOMETER_ANIM);
  } else {
    setTimeout(() => cell.remove(), ODOMETER_ANIM);
  }
  return cell;
}

function setAnimatedText(el: HTMLElement, newText: string): void {
  const oldText = getOdometerText(el);
  if (oldText === newText) return;

  el.textContent = "";
  const len = Math.max(oldText.length, newText.length);
  for (let i = 0; i < len; i++) {
    const oc = oldText[i] ?? "";
    const nc = newText[i] ?? "";
    if (oc === nc) {
      // El carácter no cambia: texto estático, sin animación.
      el.appendChild(document.createTextNode(oc));
    } else {
      el.appendChild(makeOdigitCell(oc, nc));
    }
  }
}

const isApp = !!api;

// ---- Cola de descargas ----
interface QueueItem {
  id: string;
  url: string;
  title: string;
  status: "queued" | "downloading" | "done" | "error";
  percent: number;
  button: HTMLButtonElement | null;
}
let downloadQueue: QueueItem[] = [];
let processingQueue = false;
let currentQueueItem: QueueItem | null = null;

// Canciones ya descargadas (archivo de sincronización) y sus botones.
let downloadedIds = new Set<string>();
const downloadButtons = new Map<string, HTMLButtonElement>();

// ---- Toasts ----
function toast(
  message: string,
  level: LogLevel = "info",
  persistent = false,
  duration = 4200,
): void {
  const root = $<HTMLDivElement>("toast-root");
  const el = document.createElement("div");
  const accent =
    level === "error"
      ? "border-red-500/40"
      : level === "warn"
        ? "border-amber-400/40"
        : level === "success"
          ? "border-emerald-400/40"
          : "border-ink-700";
  const iconColor =
    level === "error"
      ? "text-red-400"
      : level === "warn"
        ? "text-amber-300"
        : level === "success"
          ? "text-emerald-400"
          : "text-brand-400";
  const icon =
    level === "error"
      ? "M12 9v4m0 3h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
      : level === "warn"
        ? "M12 9v4m0 3h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
        : level === "success"
          ? "m5 13 4 4L19 7"
          : "M13 2 4.5 13.5H11L9.5 22 19 10.5h-6.5L13 2Z";

  el.className = `toast pointer-events-auto flex items-start gap-3 rounded-xl border ${accent} bg-ink-900/95 backdrop-blur px-4 py-3 shadow-xl shadow-black/40`;
  el.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${iconColor} mt-0.5 shrink-0">
      <path d="${icon}" />
    </svg>
    <p class="text-sm text-ink-100 leading-snug">${escapeHtml(message)}</p>`;
  root.appendChild(el);
  if (!persistent) {
    setTimeout(() => {
      el.style.transition = "opacity .2s";
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 220);
    }, duration);
  }
}

function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function appendLog(level: string, text: string): void {
  if (level === "error") toast(text, "error", true);
  const log = $<HTMLDivElement>("dev-log");
  if (log.firstChild?.textContent?.includes("yt-dlp")) {
    log.textContent = "";
  }
  const line = document.createElement("div");
  const color =
    level === "error"
      ? "text-red-400"
      : level === "warn"
        ? "text-amber-300"
        : level === "success"
          ? "text-emerald-400"
          : "text-ink-300";
  line.className = color;
  line.textContent = text;
  log.appendChild(line);
  while (log.childNodes.length > 400) log.removeChild(log.firstChild!);
  log.scrollTop = log.scrollHeight;
}

function updateStatus(stage: string, message: string): void {
  if (stage === "download") {
    setAnimatedText($<HTMLParagraphElement>("dl-stage"), message);
    const done = /completada|código|erro/i.test(message);
    if (done) {
      // La cola de descargas no resetea la vista ni lanza un toast por canción.
      if (!processingQueue) {
        setDownloading(false);
        resetDownloadUI();
        if (/completada/i.test(message)) {
          toast(message, "success");
        } else {
          toast(message, "warn");
        }
      }
    } else {
      setDownloading(true);
      showDlControls();
      if (!processingQueue) toast(message, "info", false, 3000);
    }
  } else if (stage === "likes" || stage === "login") {
    toast(message, "info");
  } else if (stage === "update") {
    if (updateModalOpen) {
      setUpdateModalStatus(message);
    } else {
      toast(message, "info", false, 8000);
    }
  } else if (stage === "deps") {
    if (depsModalOpen) {
      setDepsModalStatus(message);
    } else {
      toast(message, "info");
    }
  }
}

// ---- Modal de dependencias ----
let depsModalOpen = false;

function showDepsModal(): void {
  depsModalOpen = true;
  $<HTMLElement>("deps-modal").classList.remove("hidden");
  $<HTMLElement>("deps-spinner").hidden = false;
  $<HTMLElement>("deps-modal-error").classList.add("hidden");
  $<HTMLElement>("deps-modal-actions").classList.add("hidden");
  setDepsModalStatus(T("depsModal.checking"));
}

function hideDepsModal(): void {
  depsModalOpen = false;
  $<HTMLElement>("deps-modal").classList.add("hidden");
}

function setDepsModalStatus(msg: string): void {
  $<HTMLElement>("deps-modal-status").textContent = msg;
}

function showDepsModalError(msg: string): void {
  depsModalOpen = true;
  $<HTMLElement>("deps-spinner").hidden = true;
  const err = $<HTMLElement>("deps-modal-error");
  err.textContent = msg;
  err.classList.remove("hidden");
  $<HTMLElement>("deps-modal-actions").classList.remove("hidden");
  setDepsModalStatus("");
}

async function runDepsInstall(): Promise<void> {
  if (!isApp) return;
  showDepsModal();
  try {
    await api.request.installDeps({});
    hideDepsModal();
    toast(T("toast.depsReady"), "success");
    await loadStatus();
  } catch (err) {
    showDepsModalError(err instanceof Error ? err.message : String(err));
  }
}

$<HTMLButtonElement>("deps-close").addEventListener("click", hideDepsModal);
$<HTMLButtonElement>("deps-retry").addEventListener("click", () =>
  runDepsInstall(),
);

// ---- Modal de actualización de la app ----
let updateModalOpen = false;

function showUpdateModal(version?: string): void {
  updateModalOpen = true;
  $<HTMLElement>("update-modal").classList.remove("hidden");
  $<HTMLElement>("update-version").textContent = version ? `v${version}` : "";
  $<HTMLElement>("update-status").textContent = "";
  $<HTMLElement>("update-spinner").hidden = true;
  $<HTMLElement>("update-icon").hidden = false;
  const btn = $<HTMLButtonElement>("btn-apply-update");
  btn.disabled = false;
  btn.textContent = T("update.apply");
}

function setUpdateModalStatus(msg: string): void {
  $<HTMLElement>("update-status").textContent = msg;
  $<HTMLElement>("update-spinner").hidden = false;
  $<HTMLElement>("update-icon").hidden = true;
  $<HTMLButtonElement>("btn-apply-update").disabled = true;
}

$<HTMLButtonElement>("btn-apply-update").addEventListener("click", async () => {
  if (!isApp) return;
  setUpdateModalStatus(T("update.downloadingShort"));
  const r = await api.request.applyAppUpdate({});
  if (!r.ok) {
    $<HTMLElement>("update-spinner").hidden = true;
    $<HTMLElement>("update-icon").hidden = false;
    const btn = $<HTMLButtonElement>("btn-apply-update");
    btn.disabled = false;
    btn.textContent = T("update.retry");
  }
});

// Comprobación manual desde la pantalla "Acerca de".
$<HTMLButtonElement>("btn-check-update").addEventListener("click", async () => {
  if (!isApp) return;
  try {
    const r = await api.request.checkAppUpdate({});
    if (r.updateAvailable) {
      showUpdateModal(r.version);
    } else {
      toast(T("update.upToDate"), "success");
    }
  } catch {
    toast(T("update.checkFailed"), "warn");
  }
});

function updateProgress(p: DownloadProgressPayload): void {
  trackCurrent = p.current || 0;
  trackTotal = p.total || 0;
  setDownloading(true);

  if (currentQueueItem) {
    currentQueueItem.percent = p.percent;
    renderQueueItem(currentQueueItem);
  }

  $<HTMLParagraphElement>("dl-title").textContent =
    p.title || T("dl.prepare");
  setAnimatedText($<HTMLSpanElement>("dl-meta"), p.eta ? T("dl.eta", { eta: p.eta }) : "");
  $<HTMLDivElement>("dl-bar").style.width = `${Math.min(100, p.percent)}%`;
  setAnimatedText($<HTMLSpanElement>("dl-percent"), `${Math.round(p.percent)}%`);
  const total = p.total || 0;
  setAnimatedText($<HTMLParagraphElement>("dl-count"), total
    ? T("dl.trackOf", { current: p.current || 0, total })
    : p.percent > 0
      ? T("dl.downloading")
      : T("dl.prepare"));
  showDlControls();
}

// ---- Estado de descarga ----
let downloading = false;
let trackCurrent = 0;
let trackTotal = 0;

function setDownloading(value: boolean): void {
  downloading = value;
  const el = $<HTMLElement>("sidebar-download");
  const text = $<HTMLElement>("sidebar-download-text");
  if (value) {
    el.classList.remove("hidden");
    setAnimatedText(text,
      trackTotal > 0
        ? T("dl.downloadingTracks", { current: trackCurrent, total: trackTotal })
        : T("dl.downloadingGeneric"));
  } else {
    el.classList.add("hidden");
    trackCurrent = 0;
    trackTotal = 0;
  }
}

function resetDownloadUI(): void {
  $<HTMLDivElement>("dl-bar").style.width = "0%";
  setAnimatedText($<HTMLSpanElement>("dl-percent"), "0%");
  setAnimatedText($<HTMLParagraphElement>("dl-count"), T("downloads.idle"));
  $<HTMLParagraphElement>("dl-title").textContent = "—";
  setAnimatedText($<HTMLSpanElement>("dl-meta"), "");
  hideDlControls();
}

function showDlControls(): void {
  const controls = $<HTMLElement>("dl-controls");
  controls.classList.remove("hidden");
  controls.classList.add("flex");
}

function hideDlControls(): void {
  const controls = $<HTMLElement>("dl-controls");
  controls.classList.add("hidden");
  controls.classList.remove("flex");
  downloadPaused = false;
  $<HTMLButtonElement>("btn-pause").textContent = T("dl.pause");
}

// ---- Cola: botones con estado ----
const DL_BTN_BASE =
  "inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-xs font-semibold text-white active:scale-[0.98] transition-all shrink-0";

function circularLoaderSVG(percent: number): string {
  const r = 9;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - Math.min(100, Math.max(0, percent)) / 100);
  return `<svg width="14" height="14" viewBox="0 0 24 24" class="inline-block align-middle">
    <circle cx="12" cy="12" r="${r}" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="2.5"/>
    <circle cx="12" cy="12" r="${r}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"
      stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" transform="rotate(-90 12 12)"/>
  </svg>`;
}

function renderQueueItem(item: QueueItem): void {
  if (!item.button) return;
  const btn = item.button;
  if (item.status === "queued") {
    btn.disabled = true;
    btn.className = DL_BTN_BASE + " opacity-60 cursor-default";
    btn.textContent = T("dl.queued");
  } else if (item.status === "downloading") {
    btn.disabled = true;
    btn.className = DL_BTN_BASE + " cursor-default";
    btn.innerHTML =
      `${circularLoaderSVG(item.percent)}<span>${Math.round(item.percent)}%</span>`;
  } else if (item.status === "done") {
    if (downloadedIds.has(item.id)) {
      setDownloadedButtonState(btn, true);
    } else {
      btn.disabled = false;
      btn.className = DL_BTN_BASE;
      btn.textContent = T("dl.single");
    }
  } else {
    btn.disabled = false;
    btn.className = DL_BTN_BASE;
    btn.textContent = T("dl.single");
  }
  updateQueueRowStatus(item);
}

function setDownloadedButtonState(
  btn: HTMLButtonElement,
  downloaded: boolean,
): void {
  if (downloaded) {
    btn.disabled = true;
    btn.className = DL_BTN_BASE + " opacity-50 cursor-default";
    btn.innerHTML =
      `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="inline-block align-middle"><path d="m5 13 4 4L19 7"/></svg>` +
      `<span>${T("dl.downloaded")}</span>`;
  } else {
    btn.disabled = false;
    btn.className = DL_BTN_BASE;
    btn.textContent = T("dl.single");
  }
}

async function refreshDownloadedIds(): Promise<void> {
  if (!isApp) return;
  try {
    const res = await api.request.getDownloadedIds({});
    downloadedIds = new Set(res.ids);
  } catch {
    downloadedIds = new Set();
  }
  updateAllDownloadButtons();
}

function updateAllDownloadButtons(): void {
  for (const [id, btn] of downloadButtons) {
    if (!btn.isConnected) {
      downloadButtons.delete(id);
      continue;
    }
    // No sobrescribir el estado de la cola (en cola / descargando).
    const inQueue = downloadQueue.some(
      (q) =>
        q.id === id &&
        (q.status === "queued" || q.status === "downloading"),
    );
    if (inQueue) continue;
    setDownloadedButtonState(btn, downloadedIds.has(id));
  }
}

function enqueueDownload(
  id: string,
  url: string,
  title: string,
  btn: HTMLButtonElement,
): void {
  if (!guard()) return;
  const existing = downloadQueue.find((q) => q.url === url);
  if (
    existing &&
    (existing.status === "queued" || existing.status === "downloading")
  ) {
    toast(T("dl.alreadyQueued"), "warn");
    return;
  }
  const item: QueueItem = { id, url, title, status: "queued", percent: 0, button: btn };
  if (existing) {
    existing.status = "queued";
    existing.percent = 0;
    existing.button = btn;
    renderQueueItem(existing);
  } else {
    downloadQueue.push(item);
    renderQueueItem(item);
  }
  toast(T("dl.enqueued", { title }), "info", false, 2200);
  renderQueue();
  if (!processingQueue) processQueue();
}

async function processQueue(): Promise<void> {
  if (processingQueue) return;
  processingQueue = true;
  try {
    while (true) {
      currentQueueItem =
        downloadQueue.find((q) => q.status === "queued") ?? null;
      if (!currentQueueItem) break;
      currentQueueItem.status = "downloading";
      renderQueueItem(currentQueueItem);
      try {
        await api.request.downloadTrack({ url: currentQueueItem.url });
        // currentQueueItem puede ser null si se pulsó "Detener" mientras
        // la descarga estaba en curso (clearQueue lo resetea).
        if (currentQueueItem) {
          currentQueueItem.status = "done";
          currentQueueItem.percent = 100;
        }
      } catch (err) {
        if (currentQueueItem) {
          currentQueueItem.status = "error";
          toast((err as Error).message, "error", true);
        }
      }
      if (currentQueueItem) renderQueueItem(currentQueueItem);
      await refreshDownloadedIds();
      await renderSyncStats();
      await renderHistory();
    }
  } finally {
    processingQueue = false;
    currentQueueItem = null;
    setDownloading(false);
    resetDownloadUI();
  }
}

function makeDownloadButton(t: {
  id: string;
  url: string;
  title: string;
}): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = DL_BTN_BASE;
  btn.textContent = T("dl.single");
  downloadButtons.set(t.id, btn);
  if (downloadedIds.has(t.id)) setDownloadedButtonState(btn, true);
  btn.addEventListener("click", () =>
    enqueueDownload(t.id, t.url, t.title, btn),
  );
  return btn;
}

// ---- Lista de la cola (con paginación) ----
const QUEUE_PAGE_SIZE = 15;
let queuePage = 0;
const queueStatusEls = new Map<string, HTMLElement>();

function renderQueue(): void {
  const list = $<HTMLElement>("queue-list");
  const total = downloadQueue.length;
  setAnimatedText($<HTMLElement>("queue-count"), T("queue.count", { total }));
  const pages = Math.max(1, Math.ceil(total / QUEUE_PAGE_SIZE));
  if (queuePage >= pages) queuePage = pages - 1;
  const start = queuePage * QUEUE_PAGE_SIZE;
  const slice = downloadQueue.slice(start, start + QUEUE_PAGE_SIZE);

  queueStatusEls.clear();
  list.textContent = "";
  if (!slice.length) {
    const p = document.createElement("p");
    p.className = "text-xs text-ink-500";
    p.textContent = T("queue.empty");
    list.appendChild(p);
  }
  slice.forEach((item, i) => list.appendChild(queueRow(item, start + i + 1)));

  $<HTMLButtonElement>("queue-prev").disabled = queuePage === 0;
  $<HTMLButtonElement>("queue-next").disabled = queuePage >= pages - 1;
  setAnimatedText($<HTMLElement>("queue-page"), T("queue.page", { page: queuePage + 1, pages }));
}

function queueRow(item: QueueItem, index: number): HTMLElement {
  const row = document.createElement("div");
  row.className =
    "flex items-center gap-3 rounded-lg border border-ink-800 bg-ink-850/60 px-3 py-2";
  const num = document.createElement("span");
  num.className = "w-6 shrink-0 text-xs text-ink-500 tabular-nums text-right";
  num.textContent = String(index);
  const title = document.createElement("p");
  title.className = "flex-1 min-w-0 text-sm text-ink-100 truncate";
  title.textContent = item.title;
  const status = document.createElement("span");
  status.className = "shrink-0 flex items-center gap-1 text-xs";
  queueStatusEls.set(item.url, status);
  row.appendChild(num);
  row.appendChild(title);
  row.appendChild(status);
  updateQueueRowStatus(item);
  return row;
}

function updateQueueRowStatus(item: QueueItem): void {
  const status = queueStatusEls.get(item.url);
  if (!status) return;
  status.className = "shrink-0 flex items-center gap-1 text-xs";
  if (item.status === "queued") {
    status.className += " text-ink-400";
    status.textContent = T("dl.queued");
  } else if (item.status === "downloading") {
    status.className += " text-brand-300";
    status.innerHTML =
      `${circularLoaderSVG(item.percent)}<span>${Math.round(item.percent)}%</span>`;
  } else if (item.status === "done") {
    status.className += " text-emerald-400";
    status.innerHTML = "";
    const tick = document.createElement("span");
    tick.textContent = "✓";
    const folderBtn = document.createElement("button");
    folderBtn.type = "button";
    folderBtn.className =
      "inline-flex items-center justify-center w-6 h-6 rounded-md text-ink-300 hover:text-white hover:bg-ink-800 transition-colors";
    folderBtn.title = T("queue.openFolder");
    folderBtn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>';
    folderBtn.addEventListener("click", async () => {
      if (!isApp) return;
      try {
        const r = await api.request.showDownloadedItem({
          id: item.id,
          title: item.title,
        });
        if (!r.ok) toast(T("queue.fileNotFound"), "warn");
      } catch {
        toast(T("queue.fileNotFound"), "warn");
      }
    });
    status.appendChild(tick);
    status.appendChild(folderBtn);
  } else {
    status.className += " text-red-400";
    status.textContent = T("dl.error");
  }
}

$<HTMLButtonElement>("queue-prev").addEventListener("click", () => {
  if (queuePage > 0) {
    queuePage--;
    renderQueue();
  }
});
$<HTMLButtonElement>("queue-next").addEventListener("click", () => {
  const pages = Math.max(1, Math.ceil(downloadQueue.length / QUEUE_PAGE_SIZE));
  if (queuePage < pages - 1) {
    queuePage++;
    renderQueue();
  }
});

// ---- Navegación ----
const views = ["status", "download", "search", "collection", "settings", "developer", "about"];

function showView(name: string): void {
  document.querySelector<HTMLElement>("main")?.scrollTo(0, 0);
  for (const v of views) {
    $<HTMLElement>(`view-${v}`).classList.toggle("hidden", v !== name);
  }
  document.querySelectorAll<HTMLButtonElement>(".nav-btn").forEach((b) => {
    const active = b.dataset.view === name;
    b.classList.toggle("bg-brand-500/15", active);
    b.classList.toggle("text-brand-300", active);
    b.classList.toggle("font-medium", active);
  });
  if (name === "download") {
    renderSyncStats();
    renderHistory();
    renderQueue();
  }
  if (name === "developer") {
    renderStats();
  }
  if (name === "collection") {
    renderCollection();
  }
}

document.querySelectorAll<HTMLButtonElement>(".nav-btn").forEach((b) => {
  b.addEventListener("click", () => showView(b.dataset.view!));
});

// ---- Sincronización ----
async function renderSyncStats(): Promise<void> {
  if (!isApp) return;
  try {
    const s = await api.request.getSyncStats({});
    $<HTMLElement>("sync-bar").style.width = s.total
      ? `${Math.min(100, (s.downloaded / s.total) * 100)}%`
      : "0%";
    setAnimatedText($<HTMLElement>("sync-count"),
      T("sync.count", { downloaded: s.downloaded, total: s.total }));
    const btn = $<HTMLButtonElement>("btn-sync-missing");
    if (s.missing > 0) {
      setAnimatedText($<HTMLElement>("sync-text"),
        T("sync.missing", { missing: s.missing }));
      btn.textContent = T("sync.downloadMissingN", { missing: s.missing });
      btn.classList.remove("opacity-50", "pointer-events-none");
    } else {
      setAnimatedText($<HTMLElement>("sync-text"),
        T("sync.allDone"));
      btn.textContent = T("sync.synced");
      btn.classList.add("opacity-50", "pointer-events-none");
    }
  } catch {
    // sin red
  }
}

$<HTMLButtonElement>("btn-sync-missing").addEventListener("click", () =>
  withBusy("btn-sync-missing", async () => {
    if (!guard()) return;
    $<HTMLDivElement>("dev-log").textContent = "";
    await api.request.downloadMissing({});
    await refreshDownloadedIds();
    await renderSyncStats();
  }),
);
$<HTMLButtonElement>("btn-sync-all").addEventListener("click", () =>
  withBusy("btn-sync-all", async () => {
    if (!guard()) return;
    $<HTMLDivElement>("dev-log").textContent = "";
    await api.request.downloadAll({});
    await refreshDownloadedIds();
    await renderSyncStats();
    await renderHistory();
  }),
);

// ---- Historial ----
async function renderHistory(): Promise<void> {
  if (!isApp) return;
  try {
    const res = await api.request.getHistory({});
    const list = $<HTMLElement>("history-list");
    list.textContent = "";
    if (!res.items.length) {
      const p = document.createElement("p");
      p.className = "text-xs text-ink-500";
      p.textContent = T("history.empty");
      list.appendChild(p);
      return;
    }
    for (const it of res.items) {
      const row = document.createElement("div");
      row.className = "flex items-center justify-between gap-3 text-xs py-1";
      const label = document.createElement("span");
      label.className = "text-ink-300 truncate";
      label.textContent =
        it.target === "favoritos" ? T("history.favoritesSync") : it.target;
      const meta = document.createElement("span");
      meta.className = "text-ink-500 shrink-0 tabular-nums";
      const d = new Date(it.ts);
      meta.textContent = `${it.format} · ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      row.appendChild(label);
      row.appendChild(meta);
      list.appendChild(row);
    }
  } catch {
    // sin red
  }
}

// ---- Render de estado ----
function renderVersionLine(
  el: HTMLElement,
  v: DepVersionInfo,
): void {
  el.textContent = "";
  if (v.current) {
    const s = document.createElement("span");
    s.className = "text-ink-400 tabular-nums";
    s.textContent = `v${v.current}`;
    el.appendChild(s);
  }
  if (v.hasUpdate && v.latest) {
    const b = document.createElement("span");
    b.className =
      "px-1.5 py-0.5 rounded-md bg-brand-500/15 text-brand-300 text-[10px] font-semibold tabular-nums";
    b.textContent = `${T("version.new")} v${v.latest}`;
    el.appendChild(b);
  }
}

function renderDeps(d: DepsStatus): void {
  const ytIcon = $<HTMLElement>("deps-ytdlp-icon");
  const ytSub = $<HTMLElement>("deps-ytdlp-sub");
  ytIcon.textContent = d.ytdlpPresent ? "✓" : "!";
  ytIcon.className = d.ytdlpPresent
    ? "text-base leading-none text-emerald-400"
    : "text-base leading-none text-amber-400";
  ytSub.textContent = d.ytdlpPath ?? (d.ytdlpPresent ? T("tools.ready") : T("tools.notInstalled"));
  $<HTMLElement>("deps-ytdlp").classList.toggle(
    "border-amber-600/40",
    !d.ytdlpPresent,
  );
  renderVersionLine($<HTMLElement>("deps-ytdlp-version"), d.ytdlpVersion);

  const ffIcon = $<HTMLElement>("deps-ffmpeg-icon");
  const ffSub = $<HTMLElement>("deps-ffmpeg-sub");
  ffIcon.textContent = d.ffmpegPresent ? "✓" : "!";
  ffIcon.className = d.ffmpegPresent
    ? "text-base leading-none text-emerald-400"
    : "text-base leading-none text-amber-400";
  ffSub.textContent = d.ffmpegDir
    ? T("tools.ownBinary")
    : d.ffmpegPresent
      ? T("tools.systemBinary")
      : T("tools.notInstalled");
  $<HTMLElement>("deps-ffmpeg").classList.toggle(
    "border-amber-600/40",
    !d.ffmpegPresent,
  );
  renderVersionLine($<HTMLElement>("deps-ffmpeg-version"), d.ffmpegVersion);

  $<HTMLButtonElement>("btn-install-deps").classList.toggle("hidden", d.ready);
}

function renderAccount(c: ConfigPayload): void {
  const logged = c.hasToken;
  const avatar = $<HTMLElement>("account-avatar");
  avatar.textContent = (c.username?.[0] ?? "?").toUpperCase();
  avatar.className = logged
    ? "w-11 h-11 rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center font-display font-semibold text-white shrink-0 shadow-lg shadow-brand-600/25"
    : "w-11 h-11 rounded-xl bg-ink-800 border border-ink-700 flex items-center justify-center font-display font-semibold text-ink-400 shrink-0";

  $<HTMLElement>("account-text").textContent = logged
    ? c.username || T("account.loggedIn")
    : T("account.notLogged");
  $<HTMLElement>("account-user").textContent = logged
    ? T("account.readyPrompt")
    : T("account.loginPrompt");
  const chip = $<HTMLElement>("account-chip");
  chip.textContent = logged ? T("account.sessionChip") : T("account.noSessionChip");
  chip.className = logged
    ? "text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-brand-500/15 text-brand-300"
    : "text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-ink-800 text-ink-400";

  // Con sesión: se ocultan iniciar sesión y pegar token; solo cerrar sesión.
  $<HTMLButtonElement>("btn-login").classList.toggle("hidden", logged);
  $<HTMLButtonElement>("btn-token").classList.toggle("hidden", logged);
  $<HTMLButtonElement>("btn-logout").classList.toggle("hidden", !logged);
}

function renderLikes(count: number | null): void {
  const el = $<HTMLElement>("likes-count");
  if (count == null) {
    el.textContent = "—";
  } else {
    el.textContent = String(count);
    el.classList.add("text-white");
  }
}

function setSidebar(ok: boolean, text: string): void {
  const dot = $<HTMLElement>("sidebar-dot");
  dot.className = `w-2 h-2 rounded-full ${
    ok ? "bg-emerald-400" : "bg-amber-400"
  }`;
  $<HTMLElement>("sidebar-text").textContent = text;
}

function applyTheme(theme: string): void {
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
}

async function loadStatus(): Promise<StatusSnapshot | null> {
  if (!isApp) {
    setSidebar(false, T("sidebar.preview"));
    return null;
  }
  try {
    const s: StatusSnapshot = await api.request.getStatus({});
    renderDeps(s.deps);
    renderAccount(s.config);
    renderLikes(s.likesCount);
    seedSettings(s.config);
    if (!s.deps.ready) setSidebar(false, T("sidebar.installDeps"));
    else if (!s.config.hasToken) setSidebar(false, T("sidebar.login"));
    else setSidebar(true, T("sidebar.ready", { count: s.likesCount ?? "?" }));
    return s;
  } catch (err) {
    toast(T("toast.statusError", { message: (err as Error).message }), "error", true);
    return null;
  }
}

// ---- Acciones ----
async function withBusy(
  btnId: string,
  fn: () => Promise<void>,
): Promise<void> {
  const btn = document.getElementById(btnId) as HTMLButtonElement | null;
  let spinner: HTMLSpanElement | null = null;
  if (btn) {
    btn.disabled = true;
    btn.classList.add("opacity-70", "pointer-events-none");
    spinner = document.createElement("span");
    spinner.className = "spinner mr-2 align-middle";
    btn.prepend(spinner);
  }
  try {
    await fn();
  } catch (err) {
    toast((err as Error).message, "error", true);
  } finally {
    spinner?.remove();
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("opacity-70", "pointer-events-none");
    }
  }
}

const guard = (): boolean => {
  if (isApp) return true;
  toast(T("toast.notConnected"), "error", true);
  return false;
};

$<HTMLButtonElement>("btn-install-deps").addEventListener("click", () =>
  runDepsInstall(),
);

$<HTMLButtonElement>("btn-login").addEventListener("click", () =>
  withBusy("btn-login", async () => {
    if (!guard()) return;
    toast(T("toast.loginBrowser"));
    try {
      await api.request.login({});
      toast(T("toast.sessionStarted"), "success");
      await loadStatus();
    } catch (err) {
      toast((err as Error).message, "error", true);
      openTokenModal();
    }
  }),
);

function openTokenModal(): void {
  const modal = $<HTMLElement>("token-modal");
  modal.classList.remove("hidden");
  $<HTMLInputElement>("token-input").value = "";
  $<HTMLInputElement>("token-input").focus();
}

$<HTMLButtonElement>("btn-token").addEventListener("click", () => {
  if (!guard()) return;
  openTokenModal();
});

const closeTokenModal = () => {
  $<HTMLElement>("token-modal").classList.add("hidden");
};
$<HTMLButtonElement>("token-cancel").addEventListener("click", closeTokenModal);
document
  .querySelectorAll<HTMLElement>("[data-close-token]")
  .forEach((el) => el.addEventListener("click", closeTokenModal));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeTokenModal();
    closeConfigModal();
  }
});
$<HTMLButtonElement>("token-confirm").addEventListener("click", () =>
  withBusy("token-confirm", async () => {
    if (!guard()) return;
    const token = $<HTMLInputElement>("token-input").value.trim();
    if (!token) {
      toast(T("toast.pasteTokenFirst"), "warn");
      return;
    }
    await api.request.loginWithToken({ token });
    closeTokenModal();
    toast(T("toast.tokenSaved"), "success");
    await loadStatus();
  }),
);

$<HTMLButtonElement>("btn-logout").addEventListener("click", () =>
  withBusy("btn-logout", async () => {
    if (!guard()) return;
    await api.request.logout({});
    toast(T("toast.loggedOut"), "success");
    await loadStatus();
  }),
);

$<HTMLButtonElement>("btn-refresh-likes").addEventListener("click", () =>
  withBusy("btn-refresh-likes", async () => {
    if (!guard()) return;
    const res = await api.request.refreshLikes({});
    renderLikes(res.count);
    setSidebar(true, T("sidebar.ready", { count: res.count }));
    toast(T("toast.likesUpdated", { count: res.count }), "success");
  }),
);

$<HTMLButtonElement>("btn-download-all").addEventListener("click", () =>
  withBusy("btn-download-all", async () => {
    if (!guard()) return;
    showView("download");
    $<HTMLDivElement>("dev-log").textContent = "";
    await api.request.downloadAll({});
    await refreshDownloadedIds();
    await renderSyncStats();
  }),
);

// ---- Control de descargas: pausar / reanudar / detener ----
let downloadPaused = false;

$<HTMLButtonElement>("btn-pause").addEventListener("click", () => {
  if (!guard()) return;
  const btn = $<HTMLButtonElement>("btn-pause");
  if (downloadPaused) {
    api.request.resumeDownload({});
    btn.textContent = T("dl.pause");
    downloadPaused = false;
  } else {
    api.request.pauseDownload({});
    btn.textContent = T("dl.resume");
    downloadPaused = true;
  }
});

$<HTMLButtonElement>("btn-stop").addEventListener("click", () => {
  if (!guard()) return;
  clearQueue();
  setDownloading(false);
  resetDownloadUI();
  api.request.cancelDownload({});
});

function clearQueue(): void {
  downloadQueue = [];
  currentQueueItem = null;
  queuePage = 0;
  renderQueue();
}

// ---- Búsqueda ----
function renderSearchEmpty(title: string, detail: string): void {
  const results = $<HTMLElement>("search-results");
  results.textContent = "";
  const box = document.createElement("div");
  box.className =
    "flex flex-col items-center justify-center rounded-2xl border border-dashed border-ink-700 py-14 px-6 text-center";
  box.innerHTML = `
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.5" stroke-linecap="round" class="text-ink-600 mb-3">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 4.5 4.5" />
    </svg>
    <p class="text-sm font-medium text-ink-200">${escapeHtml(title)}</p>
    <p class="text-xs text-ink-500 mt-1 max-w-xs">${escapeHtml(detail)}</p>`;
  results.appendChild(box);
}

async function doSearch(): Promise<void> {
  if (!guard()) return;
  const input = $<HTMLInputElement>("search-input");
  const query = input.value.trim();
  const results = $<HTMLElement>("search-results");

  if (!query) {
    renderSearchEmpty(
      T("search.typeSomething"),
      T("search.typeDetail"),
    );
    return;
  }

  results.textContent = "";
  results.appendChild(
    loadingState(T("search.searching", { query })),
  );

  try {
    const res = await api.request.searchSoundcloud({ query });
    results.textContent = "";
    if (!res.tracks.length) {
      renderSearchEmpty(
        T("search.noResults", { query }),
        T("search.noResultsDetail"),
      );
      return;
    }
    for (const t of res.tracks) results.appendChild(trackCard(t));
  } catch (err) {
    results.textContent = "";
    renderSearchEmpty(T("search.failed"), (err as Error).message);
  }
}

function trackCard(t: LikedTrackPayload): HTMLElement {
  const card = document.createElement("div");
  card.className =
    "flex items-center gap-4 rounded-xl border border-ink-800 bg-ink-900/70 px-4 py-3 hover:border-ink-700 hover:bg-ink-850/70 transition-colors";

  const thumb = document.createElement("div");
  thumb.className =
    "w-10 h-10 shrink-0 rounded-lg bg-ink-800 flex items-center justify-center text-ink-500";
  thumb.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>`;

  const info = document.createElement("div");
  info.className = "flex-1 min-w-0";
  const title = document.createElement("p");
  title.className = "text-sm font-medium text-ink-100 truncate";
  title.textContent = t.title;
  const sub = document.createElement("p");
  sub.className = "text-xs text-ink-400 truncate";
  sub.textContent = t.uploader ?? "SoundCloud";
  info.appendChild(title);
  info.appendChild(sub);

  const actions = document.createElement("div");
  actions.className = "flex items-center gap-2 shrink-0";

  const btn = makeDownloadButton(t);

  actions.appendChild(btn);

  card.appendChild(thumb);
  card.appendChild(info);
  card.appendChild(actions);
  return card;
}

$<HTMLButtonElement>("btn-search").addEventListener("click", () =>
  withBusy("btn-search", doSearch),
);
$<HTMLInputElement>("search-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") withBusy("btn-search", doSearch);
});

// Descargar por enlace
$<HTMLButtonElement>("btn-download-url").addEventListener("click", () =>
  withBusy("btn-download-url", async () => {
    if (!guard()) return;
    const url = $<HTMLInputElement>("url-input").value.trim();
    if (!url) {
      toast(T("toast.urlEmpty"), "warn");
      return;
    }
    showView("download");
    $<HTMLDivElement>("dev-log").textContent = "";
    $<HTMLParagraphElement>("dl-title").textContent = url;
    showDlControls();
    await api.request.downloadUrl({ url });
    await refreshDownloadedIds();
    await renderSyncStats();
    await renderHistory();
  }),
);
$<HTMLInputElement>("url-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $<HTMLButtonElement>("btn-download-url").click();
});

// ---- Editor de plantilla de nombre (chips) ----
const VAR_KEYS: Record<string, string> = {
  title: "var.title",
  uploader: "var.uploader",
  artist: "var.artist",
  album: "var.album",
  id: "var.id",
  playlist_index: "var.playlist_index",
  ext: "var.ext",
};

const TEMPLATE_EXAMPLES: Record<string, string> = {
  title: "Mi canción",
  uploader: "MiArtista",
  artist: "Artista",
  album: "Álbum",
  id: "123456",
  playlist_index: "3",
  ext: "mp3",
};

function makeChip(variable: string): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.contentEditable = "false";
  chip.setAttribute("data-var", variable);
  chip.textContent = VAR_KEYS[variable] ? T(VAR_KEYS[variable]) : `%(${variable})s`;
  chip.title = `%(${variable})s`;
  return chip;
}

function renderTemplateToEditor(template: string): void {
  const editor = $<HTMLElement>("template-editor");
  editor.textContent = "";
  const re = /%\(([^)]+)\)s/g;
  const frag = document.createDocumentFragment();
  let m: RegExpExecArray | null;
  let lastIndex = 0;
  while ((m = re.exec(template))) {
    if (m.index > lastIndex) {
      frag.appendChild(document.createTextNode(template.slice(lastIndex, m.index)));
    }
    frag.appendChild(makeChip(m[1]));
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < template.length) {
    frag.appendChild(document.createTextNode(template.slice(lastIndex)));
  }
  editor.appendChild(frag);
}

function serializeEditor(): string {
  const editor = $<HTMLElement>("template-editor");
  let out = "";
  for (const node of editor.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? "";
    } else if (node instanceof HTMLElement && node.dataset.var) {
      out += `%(${node.dataset.var})s`;
    } else {
      out += (node as HTMLElement).textContent ?? "";
    }
  }
  return out;
}

function appendVariableToEditor(variable: string): void {
  const editor = $<HTMLElement>("template-editor");
  const chip = makeChip(variable);
  const sel = window.getSelection();
  if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(chip);
    range.setStartAfter(chip);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    editor.appendChild(chip);
  }
  editor.focus();
  updateTemplatePreview();
}

function updateTemplatePreview(): void {
  const tpl = serializeEditor();
  const preview = tpl.replace(
    /%\(([^)]+)\)s/g,
    (_m, v: string) => TEMPLATE_EXAMPLES[v] ?? `[${v}]`,
  );
  $<HTMLElement>("template-preview").textContent =
    preview ? T("settings.preview", { name: preview }) : "";
}

document
  .querySelectorAll<HTMLButtonElement>("#template-chips .chip-btn")
  .forEach((btn) => {
    btn.addEventListener("click", () => {
      appendVariableToEditor(btn.dataset.var ?? "");
    });
  });
$<HTMLElement>("template-editor").addEventListener("input", updateTemplatePreview);
$<HTMLElement>("template-editor").addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
    e.preventDefault();
  }
});

function seedSettings(c: ConfigPayload): void {
  $<HTMLInputElement>("set-outdir").value = c.outdir ?? "";
  $<HTMLSelectElement>("set-format").value = c.format ?? "mp3";
  $<HTMLSelectElement>("set-bitrate").value = c.bitrate ?? c.quality ?? "320K";
  $<HTMLSelectElement>("set-theme").value = c.theme ?? "dark";
  if (!langUserSet) {
    setLang(resolveLang(c.lang));
  }
  renderTemplateToEditor(c.filenameTemplate ?? "%(title)s - %(artist)s");
  updateTemplatePreview();
  $<HTMLInputElement>("set-skip").checked = c.skipExisting ?? true;
  applyTheme(c.theme ?? "dark");
  updateBitrateState();
}

/** Mantiene el selector de idioma sincronizado con la lengua activa. */
function renderLanguageSelect(): void {
  $<HTMLSelectElement>("set-lang").value = currentLang;
}

$<HTMLSelectElement>("set-lang").addEventListener("change", () => {
  langUserSet = true;
  setLang(resolveLang($<HTMLSelectElement>("set-lang").value), true);
});

$<HTMLSelectElement>("set-theme").addEventListener("change", () => {
  applyTheme($<HTMLSelectElement>("set-theme").value);
});

const LOSSLESS_ORIGINAL = ["flac", "wav", "alac", "original"];

function updateBitrateState(): void {
  const format = $<HTMLSelectElement>("set-format").value;
  const disabled = LOSSLESS_ORIGINAL.includes(format);
  $<HTMLSelectElement>("set-bitrate").disabled = disabled;
  $<HTMLElement>("set-bitrate").classList.toggle("opacity-40", disabled);
}

$<HTMLSelectElement>("set-format").addEventListener("change", updateBitrateState);

$<HTMLButtonElement>("btn-pick-folder").addEventListener("click", () =>
  withBusy("btn-pick-folder", async () => {
    if (!guard()) return;
    const res = await api.request.selectFolder({});
    if (res.path) {
      $<HTMLInputElement>("set-outdir").value = res.path;
    }
  }),
);

$<HTMLButtonElement>("btn-save-settings").addEventListener("click", () =>
  withBusy("btn-save-settings", async () => {
    if (!guard()) return;
    const template = serializeEditor().trim();
    if (!template) {
      toast(T("settings.templateEmpty"), "warn");
      return;
    }
    if (!/\([^)]+\)/.test(template)) {
      toast(T("settings.templateNoVar"), "warn");
      return;
    }
    await api.request.saveConfig({
      outdir: $<HTMLInputElement>("set-outdir").value.trim(),
      format: $<HTMLSelectElement>("set-format").value,
      bitrate: $<HTMLSelectElement>("set-bitrate").value,
      filenameTemplate: template,
      theme: $<HTMLSelectElement>("set-theme").value,
      lang: currentLang,
      skipExisting: $<HTMLInputElement>("set-skip").checked,
    });
    toast(T("settings.saved"), "success");
    await loadStatus();
  }),
);

// ---- Exportar / importar configuración ----
function openConfigModal(mode: "export" | "import", text = ""): void {
  const modal = $<HTMLElement>("config-modal");
  modal.classList.remove("hidden");
  $<HTMLElement>("config-modal-title").textContent =
    mode === "export" ? T("configModal.export") : T("configModal.import");
  const ta = $<HTMLTextAreaElement>("config-text");
  ta.value = text;
  ta.readOnly = mode === "export";
  $<HTMLButtonElement>("config-apply").classList.toggle("hidden", mode !== "import");
  $<HTMLButtonElement>("config-copy").classList.toggle("hidden", mode !== "export");
}
const closeConfigModal = () => $<HTMLElement>("config-modal").classList.add("hidden");
document
  .querySelectorAll<HTMLElement>("[data-close-config]")
  .forEach((el) => el.addEventListener("click", closeConfigModal));
$<HTMLButtonElement>("config-cancel").addEventListener("click", closeConfigModal);

$<HTMLButtonElement>("btn-export-config").addEventListener("click", () =>
  withBusy("btn-export-config", async () => {
    if (!guard()) return;
    const res = await api.request.exportConfig({});
    openConfigModal("export", res.json);
  }),
);
$<HTMLButtonElement>("config-copy").addEventListener("click", async () => {
  const text = $<HTMLTextAreaElement>("config-text").value;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    $<HTMLTextAreaElement>("config-text").select();
    document.execCommand("copy");
  }
  toast(T("configModal.copied"), "success");
});
$<HTMLButtonElement>("btn-import-config").addEventListener("click", () =>
  openConfigModal("import"),
);
$<HTMLButtonElement>("config-apply").addEventListener("click", () =>
  withBusy("config-apply", async () => {
    if (!guard()) return;
    await api.request.importConfig({
      json: $<HTMLTextAreaElement>("config-text").value,
    });
    closeConfigModal();
    toast(T("configModal.imported"), "success");
    await loadStatus();
  }),
);


// ---- Estadísticas (vista desarrollador) ----
async function renderStats(): Promise<void> {
  if (!isApp) return;
  try {
    const res = await api.request.getHistory({});
    const items = (res.items as HistoryItemPayload[]).filter((it) => it.ok);
    const byFormat: Record<string, number> = {};
    let last7 = 0;
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
    for (const it of items) {
      byFormat[it.format] = (byFormat[it.format] ?? 0) + 1;
      if (it.ts >= weekAgo) last7++;
    }
    const grid = $<HTMLElement>("stats-grid");
    grid.textContent = "";
    const cells: [string, string][] = [
      [T("stats.total"), String(items.length)],
      [T("stats.last7"), String(last7)],
      [T("stats.formats"), Object.entries(byFormat).map(([f, n]) => `${f} ×${n}`).join(" · ") || "—"],
    ];
    for (const [label, value] of cells) {
      const cell = document.createElement("div");
      cell.className =
        "rounded-xl border border-ink-800 bg-ink-850/60 px-3 py-2.5";
      const l = document.createElement("p");
      l.className = "text-[11px] text-ink-400";
      l.textContent = label;
      const v = document.createElement("p");
      v.className = "text-sm font-semibold text-ink-100 mt-0.5 tabular-nums";
      v.textContent = value;
      cell.appendChild(l);
      cell.appendChild(v);
      grid.appendChild(cell);
    }
  } catch {
    // sin red
  }
}

// ---- Limpieza de no favoritos ----
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function openCleanupModal(count: number): void {
  $<HTMLElement>("cleanup-modal").classList.remove("hidden");
  $<HTMLElement>("cleanup-count").textContent = String(count);
  const btn = $<HTMLButtonElement>("cleanup-confirm");
  btn.disabled = true;
  let remaining = 3;
  btn.textContent = T("cleanup.confirmN", { n: remaining });
  cleanupTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      if (cleanupTimer) clearInterval(cleanupTimer);
      cleanupTimer = null;
      btn.disabled = false;
      btn.textContent = T("cleanup.confirm", { count });
    } else {
      btn.textContent = T("cleanup.confirmN", { n: remaining });
    }
  }, 1000);
}

function closeCleanupModal(): void {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = null;
  $<HTMLElement>("cleanup-modal").classList.add("hidden");
}

$<HTMLButtonElement>("btn-cleanup").addEventListener("click", () =>
  withBusy("btn-cleanup", async () => {
    if (!guard()) return;
    const res = await api.request.cleanupPreview({});
    if (res.count === 0) {
      toast(T("toast.cleanupNone"), "info");
      return;
    }
    openCleanupModal(res.count);
  }),
);

$<HTMLButtonElement>("cleanup-cancel").addEventListener("click", closeCleanupModal);
document
  .querySelectorAll<HTMLElement>("[data-close-cleanup]")
  .forEach((el) => el.addEventListener("click", closeCleanupModal));

$<HTMLButtonElement>("cleanup-confirm").addEventListener("click", () =>
  withBusy("cleanup-confirm", async () => {
    if (!guard()) return;
    const res = await api.request.cleanupNonFavorites({});
    closeCleanupModal();
    if (res.removed.length) {
      toast(T("toast.cleanupRemoved", { count: res.removed.length }), "success");
    } else {
      toast(T("toast.cleanupNone"), "info");
    }
    await refreshDownloadedIds();
    await renderSyncStats();
  }),
);

// ---- Colección (favoritos / playlists) ----
const collectionState = {
  source: "favorites" as "favorites" | "playlists",
  playlistUrl: null as string | null,
  query: "",
  playlistsCache: null as { id: string; title: string; url: string }[] | null,
  playlistTracksCache: null as { url: string; tracks: LikedTrackPayload[] } | null,
};

function filterByQuery(tracks: LikedTrackPayload[]): LikedTrackPayload[] {
  const q = collectionState.query.trim().toLowerCase();
  if (!q) return tracks;
  return tracks.filter(
    (t) =>
      t.title.toLowerCase().includes(q) ||
      (t.uploader ?? "").toLowerCase().includes(q),
  );
}

function setSourceTab(active: "favorites" | "playlists"): void {
  for (const name of ["favorites", "playlists"] as const) {
    const btn = $<HTMLButtonElement>(`src-${name}`);
    const on = name === active;
    btn.classList.toggle("bg-brand-600", on);
    btn.classList.toggle("text-white", on);
    btn.classList.toggle("hover:bg-brand-500", on);
  }
}

async function renderCollection(): Promise<void> {
  setSourceTab(collectionState.source);
  const content = $<HTMLElement>("collection-content");
  content.textContent = "";

  // El buscador solo aplica a listas de canciones.
  const showSearch =
    collectionState.source === "favorites" || !!collectionState.playlistUrl;
  $<HTMLElement>("collection-search-wrap").classList.toggle(
    "hidden",
    !showSearch,
  );
  if (showSearch) {
    $<HTMLInputElement>("collection-search").value = collectionState.query;
  }

  if (collectionState.source === "favorites") {
    await renderCollectionFavorites();
  } else if (collectionState.playlistUrl) {
    await renderCollectionPlaylistTracks();
  } else {
    await renderCollectionPlaylists();
  }
}

$<HTMLInputElement>("collection-search").addEventListener("input", () => {
  collectionState.query = $<HTMLInputElement>("collection-search").value;
  renderCollection();
});

function collectionTrackRow(t: LikedTrackPayload): HTMLElement {
  const row = document.createElement("div");
  row.className =
    "flex items-center gap-3 rounded-xl border border-ink-800 bg-ink-900/70 px-3 py-2 hover:bg-ink-850/70 transition-colors";
  const info = document.createElement("div");
  info.className = "flex-1 min-w-0";
  const title = document.createElement("p");
  title.className = "text-sm text-ink-100 truncate";
  title.textContent = t.title;
  const sub = document.createElement("p");
  sub.className = "text-xs text-ink-400 truncate";
  sub.textContent = t.uploader ?? "SoundCloud";
  info.appendChild(title);
  info.appendChild(sub);

  const btn = makeDownloadButton(t);

  row.appendChild(info);
  row.appendChild(btn);
  return row;
}

function startDownloadView(label: string): void {
  showView("download");
  $<HTMLDivElement>("dev-log").textContent = "";
  resetDownloadUI();
  $<HTMLParagraphElement>("dl-title").textContent = label;
  setAnimatedText($<HTMLParagraphElement>("dl-count"), "Preparando...");
  showDlControls();
  setDownloading(true);
}

async function renderCollectionFavorites(): Promise<void> {
  const content = $<HTMLElement>("collection-content");
  if (!isApp) return;

  let tracks: LikedTrackPayload[] = [];
  try {
    const cache = await api.request.getLikesCache({});
    if (cache.tracks.length) {
      tracks = cache.tracks;
    } else {
      const res = await api.request.refreshLikes({});
      tracks = res.tracks;
    }
  } catch {
    tracks = [];
  }

  const filtered = filterByQuery(tracks);
  if (!filtered.length) {
    content.appendChild(
      emptyState(
        T("collection.noResults"),
        collectionState.query
          ? T("collection.noFavMatch", { query: collectionState.query })
          : T("collection.noFavs"),
      ),
    );
    return;
  }

  const header = document.createElement("div");
  header.className = "flex items-center justify-between gap-3 flex-wrap";
  const h = document.createElement("p");
  h.className = "text-sm text-ink-300";
  h.textContent = collectionState.query
    ? T("collection.countOf", { filtered: filtered.length, total: tracks.length })
    : T("collection.count", { total: tracks.length });
  const dl = document.createElement("button");
  dl.className =
    "px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-sm font-semibold text-white active:scale-[0.98] transition-all";
  dl.textContent = T("collection.downloadAll");
  dl.addEventListener("click", () =>
    withBusy("", async () => {
      if (!guard()) return;
      startDownloadView(T("collection.yourFavs"));
      await api.request.downloadAll({});
    await refreshDownloadedIds();
      await renderSyncStats();
      await renderHistory();
    }),
  );
  header.appendChild(h);
  header.appendChild(dl);

  const list = document.createElement("div");
  list.className = "space-y-1.5 max-h-[60vh] overflow-y-auto pr-1";
  for (const t of filtered) list.appendChild(collectionTrackRow(t));

  content.appendChild(header);
  content.appendChild(list);
}

async function renderCollectionPlaylists(): Promise<void> {
  const content = $<HTMLElement>("collection-content");
  if (!isApp) return;

  if (!collectionState.playlistsCache) {
    content.appendChild(loadingState(T("collection.loadingPlaylists")));
    try {
      const res = await api.request.getPlaylists({});
      collectionState.playlistsCache = res.playlists;
    } catch (err) {
      content.appendChild(emptyState(T("collection.playlistsFailed"), (err as Error).message));
      return;
    }
  }

  const playlists = collectionState.playlistsCache;
  if (!playlists?.length) {
    content.appendChild(emptyState(T("collection.noPlaylists"), T("collection.noPlaylistsDetail")));
    return;
  }

  const list = document.createElement("div");
  list.className = "space-y-1.5";
  for (const pl of playlists) {
    const row = document.createElement("button");
    row.className =
      "w-full flex items-center gap-3 rounded-xl border border-ink-800 bg-ink-900/70 px-4 py-3 text-left hover:bg-ink-850/70 hover:border-ink-700 transition-colors";
    const icon = document.createElement("span");
    icon.className =
      "w-9 h-9 shrink-0 rounded-lg bg-ink-800 flex items-center justify-center text-ink-500";
    icon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>`;
    const label = document.createElement("span");
    label.className = "flex-1 min-w-0 text-sm font-medium text-ink-100 truncate";
    label.textContent = pl.title;
    const arrow = document.createElement("span");
    arrow.className = "text-ink-500";
    arrow.textContent = "›";
    row.appendChild(icon);
    row.appendChild(label);
    row.appendChild(arrow);
    row.addEventListener("click", () => {
      collectionState.playlistUrl = pl.url;
      renderCollection();
    });
    list.appendChild(row);
  }
  content.appendChild(list);
}

async function renderCollectionPlaylistTracks(): Promise<void> {
  const content = $<HTMLElement>("collection-content");
  if (!isApp) return;
  const url = collectionState.playlistUrl!;

  if (
    !collectionState.playlistTracksCache ||
    collectionState.playlistTracksCache.url !== url
  ) {
    content.appendChild(loadingState(T("collection.loadingTracks")));
    try {
      const res = await api.request.getPlaylistTracks({ url });
      collectionState.playlistTracksCache = { url, tracks: res.tracks };
    } catch (err) {
      content.appendChild(emptyState(T("collection.tracksFailed"), (err as Error).message));
      return;
    }
  }

  const tracks = collectionState.playlistTracksCache!.tracks;
  const filtered = filterByQuery(tracks);

  const top = document.createElement("div");
  top.className = "flex items-center justify-between gap-3 flex-wrap";
  const left = document.createElement("div");
  left.className = "flex items-center gap-2";
  const back = document.createElement("button");
  back.className =
    "px-3 py-1.5 rounded-lg border border-ink-700 text-sm text-ink-200 hover:bg-ink-800 transition-colors";
  back.textContent = T("collection.back");
  back.addEventListener("click", () => {
    collectionState.playlistUrl = null;
    collectionState.query = "";
    renderCollection();
  });
  const count = document.createElement("p");
  count.className = "text-sm text-ink-300";
  count.textContent = collectionState.query
    ? T("collection.countOf", { filtered: filtered.length, total: tracks.length })
    : T("collection.count", { total: tracks.length });
  left.appendChild(back);
  left.appendChild(count);

  const dl = document.createElement("button");
  dl.className =
    "px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-sm font-semibold text-white active:scale-[0.98] transition-all";
  dl.textContent = T("collection.downloadAll");
  dl.disabled = tracks.length === 0;
  if (tracks.length === 0) dl.classList.add("opacity-50", "pointer-events-none");
  dl.addEventListener("click", () =>
    withBusy("", async () => {
      if (!guard()) return;
      startDownloadView(T("collection.fullPlaylist"));
      await api.request.downloadUrls({ urls: tracks.map((t) => t.url) });
    await refreshDownloadedIds();
      await renderSyncStats();
      await renderHistory();
    }),
  );
  top.appendChild(left);
  top.appendChild(dl);

  content.appendChild(top);

  if (!filtered.length) {
    content.appendChild(
      emptyState(
        T("collection.noResults"),
        collectionState.query
          ? T("collection.noTrackMatch", { query: collectionState.query })
          : T("collection.playlistEmpty"),
      ),
    );
    return;
  }
  const list = document.createElement("div");
  list.className = "space-y-1.5 max-h-[60vh] overflow-y-auto pr-1";
  for (const t of filtered) list.appendChild(collectionTrackRow(t));
  content.appendChild(list);
}

function emptyState(title: string, detail: string): HTMLElement {
  const box = document.createElement("div");
  box.className =
    "flex flex-col items-center justify-center rounded-2xl border border-dashed border-ink-700 py-14 px-6 text-center";
  const t = document.createElement("p");
  t.className = "text-sm font-medium text-ink-200";
  t.textContent = title;
  box.appendChild(t);
  if (detail) {
    const d = document.createElement("p");
    d.className = "text-xs text-ink-500 mt-1 max-w-xs";
    d.textContent = detail;
    box.appendChild(d);
  }
  return box;
}

function loadingState(text: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "flex items-center gap-2 text-sm text-ink-400 py-6";
  box.innerHTML = `<span class="spinner spinner-accent"></span> ${text}`;
  return box;
}

$<HTMLButtonElement>("src-favorites").addEventListener("click", () => {
  collectionState.source = "favorites";
  collectionState.playlistUrl = null;
  collectionState.query = "";
  renderCollection();
});
$<HTMLButtonElement>("src-playlists").addEventListener("click", () => {
  collectionState.source = "playlists";
  collectionState.playlistUrl = null;
  collectionState.query = "";
  renderCollection();
});

// ---- Acerca de ----

// Abre enlaces externos (repo, licencia) en el navegador del sistema.
document.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement | null)?.closest?.("[data-open-url]");
  if (!el || !isApp) return;
  e.preventDefault();
  const url = (el as HTMLElement).dataset.openUrl;
  if (url) api.request.openExternal({ url }).catch(() => {});
});

async function initAbout(): Promise<void> {
  if (!isApp) return;
  try {
    const info = await api.request.getAppInfo({});
    $<HTMLElement>("about-version").textContent = `v${info.version}`;
    $<HTMLElement>("about-repo").dataset.openUrl = info.repo;
    $<HTMLElement>("about-license").dataset.openUrl = info.licenseUrl;
  } catch {
    // Sin puente (dev) o fallo: se dejan los valores por defecto del HTML.
  }
}

// ---- Arranque ----
applyStaticTranslations();
resetDownloadUI();
showView("status");
refreshDownloadedIds();
initAbout();
(async () => {
  let s = await loadStatus();
  if (s && !s.deps.ready) {
    await runDepsInstall();
    s = await loadStatus();
  }
  if (s?.deps.ready) {
    // Comprobación de versiones de dependencias en segundo plano (sin modal).
    checkForUpdatesBackground();
  }
  // Comprobación de actualización de la propia app (solo en builds estables).
  checkAppUpdateBackground();
})();

async function checkAppUpdateBackground(): Promise<void> {
  if (!isApp) return;
  try {
    const r = await api.request.checkAppUpdate({});
    if (r.updateAvailable) {
      showUpdateModal(r.version);
    }
  } catch {
    // Sin red: se ignora.
  }
}

async function checkForUpdatesBackground(): Promise<void> {
  if (!isApp) return;
  try {
    const r = await api.request.checkForUpdates({});
    await loadStatus();
    if (r.updated.length) {
      toast(
        T("toast.depsUpdated", { list: r.updated.join(", ") }),
        "success",
        false,
        6000,
      );
    }
  } catch {
    // Sin red u otro fallo: se ignora, no es crítico.
  }
}
