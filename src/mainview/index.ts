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

// ---- Texto animado (efecto odómetro) ----
const odometerAnimating = new WeakSet<HTMLElement>();
const ODOMETER_ANIM = 300;

function setAnimatedText(el: HTMLElement, newText: string): void {
  if (!el.classList.contains("odometer-wrapper")) {
    el.classList.add("odometer-wrapper");
    const span = document.createElement("span");
    span.className = "inline-block whitespace-nowrap";
    span.textContent = el.textContent ?? "";
    el.textContent = "";
    el.appendChild(span);
  }
  const currentSpan = el.querySelector<HTMLElement>("span");
  if (!currentSpan) return;
  if (currentSpan.textContent === newText) return;
  if (newText === "" || odometerAnimating.has(el)) {
    currentSpan.textContent = newText;
    return;
  }

  const outClass = "slide-out-up";
  const inClass = "slide-in-up";

  const nextSpan = document.createElement("span");
  nextSpan.textContent = newText;
  nextSpan.className = `inline-block whitespace-nowrap ${inClass}`;
  nextSpan.style.position = "absolute";
  nextSpan.style.visibility = "hidden";
  nextSpan.style.whiteSpace = "nowrap";
  el.appendChild(nextSpan);

  const endWidth = nextSpan.getBoundingClientRect().width;
  const startWidth = el.getBoundingClientRect().width;

  nextSpan.style.visibility = "visible";
  nextSpan.style.top = "0";
  nextSpan.style.left = "0";
  nextSpan.style.width = "100%";
  nextSpan.style.textAlign = "center";

  el.style.width = `${startWidth}px`;
  void el.offsetWidth;
  el.style.transition = `width ${ODOMETER_ANIM}ms cubic-bezier(0.65, 0, 0.35, 1)`;
  el.style.width = `${endWidth}px`;

  currentSpan.className = `inline-block whitespace-nowrap ${outClass}`;
  currentSpan.style.width = "100%";
  currentSpan.style.textAlign = "center";

  odometerAnimating.add(el);
  setTimeout(() => {
    currentSpan.remove();
    nextSpan.className = "inline-block whitespace-nowrap";
    nextSpan.style.position = "relative";
    nextSpan.style.top = "";
    nextSpan.style.left = "";
    nextSpan.style.width = "";
    nextSpan.style.textAlign = "";
    nextSpan.style.visibility = "";
    el.style.width = "";
    el.style.transition = "";
    odometerAnimating.delete(el);
  }, ODOMETER_ANIM);
}

const isApp = !!api;

// ---- Cola de descargas ----
interface QueueItem {
  url: string;
  title: string;
  status: "queued" | "downloading" | "done" | "error";
  percent: number;
  button: HTMLButtonElement | null;
}
let downloadQueue: QueueItem[] = [];
let processingQueue = false;
let currentQueueItem: QueueItem | null = null;

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
  if (log.firstChild?.textContent?.includes("El registro de yt-dlp")) {
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
    toast(message, "info", false, 8000);
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
  $<HTMLElement>("deps-spinner").classList.remove("hidden");
  $<HTMLElement>("deps-modal-error").classList.add("hidden");
  $<HTMLElement>("deps-modal-actions").classList.add("hidden");
  setDepsModalStatus("Comprobando...");
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
  $<HTMLElement>("deps-spinner").classList.add("hidden");
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
    toast("Dependencias listas", "success");
    await loadStatus();
  } catch (err) {
    showDepsModalError(err instanceof Error ? err.message : String(err));
  }
}

$<HTMLButtonElement>("deps-close").addEventListener("click", hideDepsModal);
$<HTMLButtonElement>("deps-retry").addEventListener("click", () =>
  runDepsInstall(),
);

function updateProgress(p: DownloadProgressPayload): void {
  trackCurrent = p.current || 0;
  trackTotal = p.total || 0;
  setDownloading(true);

  if (currentQueueItem) {
    currentQueueItem.percent = p.percent;
    renderQueueItem(currentQueueItem);
  }

  $<HTMLParagraphElement>("dl-title").textContent =
    p.title || "Preparando...";
  setAnimatedText($<HTMLSpanElement>("dl-meta"), p.eta ? `ETA ${p.eta}` : "");
  $<HTMLDivElement>("dl-bar").style.width = `${Math.min(100, p.percent)}%`;
  setAnimatedText($<HTMLSpanElement>("dl-percent"), `${Math.round(p.percent)}%`);
  const total = p.total || 0;
  setAnimatedText($<HTMLParagraphElement>("dl-count"), total
    ? `Canción ${p.current || 0} de ${total}`
    : p.percent > 0
      ? "Descargando..."
      : "Preparando...");
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
        ? `Descargando ${trackCurrent} de ${trackTotal} canciones`
        : "Descargando canciones...");
  } else {
    el.classList.add("hidden");
    trackCurrent = 0;
    trackTotal = 0;
  }
}

function resetDownloadUI(): void {
  $<HTMLDivElement>("dl-bar").style.width = "0%";
  setAnimatedText($<HTMLSpanElement>("dl-percent"), "0%");
  setAnimatedText($<HTMLParagraphElement>("dl-count"), "Sin descargas activas");
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
  $<HTMLButtonElement>("btn-pause").textContent = "Pausar";
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
    btn.textContent = "En cola";
  } else if (item.status === "downloading") {
    btn.disabled = true;
    btn.className = DL_BTN_BASE + " cursor-default";
    btn.innerHTML =
      `${circularLoaderSVG(item.percent)}<span>${Math.round(item.percent)}%</span>`;
  } else {
    btn.disabled = false;
    btn.className = DL_BTN_BASE;
    btn.textContent = "Descargar";
  }
  updateQueueRowStatus(item);
}

function enqueueDownload(url: string, title: string, btn: HTMLButtonElement): void {
  if (!guard()) return;
  const existing = downloadQueue.find((q) => q.url === url);
  if (
    existing &&
    (existing.status === "queued" || existing.status === "downloading")
  ) {
    toast("Esa canción ya está en la cola", "warn");
    return;
  }
  const item: QueueItem = { url, title, status: "queued", percent: 0, button: btn };
  if (existing) {
    existing.status = "queued";
    existing.percent = 0;
    existing.button = btn;
    renderQueueItem(existing);
  } else {
    downloadQueue.push(item);
    renderQueueItem(item);
  }
  toast(`En cola: ${title}`, "info", false, 2200);
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
        currentQueueItem.status = "done";
        currentQueueItem.percent = 100;
      } catch (err) {
        currentQueueItem.status = "error";
        toast((err as Error).message, "error", true);
      }
      renderQueueItem(currentQueueItem);
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

function makeDownloadButton(t: { url: string; title: string }): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = DL_BTN_BASE;
  btn.textContent = "Descargar";
  btn.addEventListener("click", () => enqueueDownload(t.url, t.title, btn));
  return btn;
}

// ---- Lista de la cola (con paginación) ----
const QUEUE_PAGE_SIZE = 15;
let queuePage = 0;
const queueStatusEls = new Map<string, HTMLElement>();

function renderQueue(): void {
  const list = $<HTMLElement>("queue-list");
  const total = downloadQueue.length;
  setAnimatedText($<HTMLElement>("queue-count"), `${total} canciones`);
  const pages = Math.max(1, Math.ceil(total / QUEUE_PAGE_SIZE));
  if (queuePage >= pages) queuePage = pages - 1;
  const start = queuePage * QUEUE_PAGE_SIZE;
  const slice = downloadQueue.slice(start, start + QUEUE_PAGE_SIZE);

  queueStatusEls.clear();
  list.textContent = "";
  if (!slice.length) {
    const p = document.createElement("p");
    p.className = "text-xs text-ink-500";
    p.textContent = "No hay descargas en la cola.";
    list.appendChild(p);
  }
  slice.forEach((item, i) => list.appendChild(queueRow(item, start + i + 1)));

  $<HTMLButtonElement>("queue-prev").disabled = queuePage === 0;
  $<HTMLButtonElement>("queue-next").disabled = queuePage >= pages - 1;
  setAnimatedText($<HTMLElement>("queue-page"), `${queuePage + 1} / ${pages}`);
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
    status.textContent = "En cola";
  } else if (item.status === "downloading") {
    status.className += " text-brand-300";
    status.innerHTML =
      `${circularLoaderSVG(item.percent)}<span>${Math.round(item.percent)}%</span>`;
  } else if (item.status === "done") {
    status.className += " text-emerald-400";
    status.textContent = "✓";
  } else {
    status.className += " text-red-400";
    status.textContent = "Error";
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
const views = ["status", "download", "search", "collection", "settings", "developer"];

function showView(name: string): void {
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
      `${s.downloaded} de ${s.total} descargadas`);
    const btn = $<HTMLButtonElement>("btn-sync-missing");
    if (s.missing > 0) {
      setAnimatedText($<HTMLElement>("sync-text"),
        `Faltan ${s.missing} canciones por descargar`);
      btn.textContent = `Descargar faltantes (${s.missing})`;
      btn.classList.remove("opacity-50", "pointer-events-none");
    } else {
      setAnimatedText($<HTMLElement>("sync-text"),
        "Todas tus favoritas están descargadas");
      btn.textContent = "Sincronizado";
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
    await api.request.downloadAll({});
    await renderSyncStats();
  }),
);
$<HTMLButtonElement>("btn-sync-all").addEventListener("click", () =>
  withBusy("btn-sync-all", async () => {
    if (!guard()) return;
    $<HTMLDivElement>("dev-log").textContent = "";
    await api.request.downloadAll({});
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
      p.textContent = "Sin descargas registradas todavía.";
      list.appendChild(p);
      return;
    }
    for (const it of res.items) {
      const row = document.createElement("div");
      row.className = "flex items-center justify-between gap-3 text-xs py-1";
      const label = document.createElement("span");
      label.className = "text-ink-300 truncate";
      label.textContent =
        it.target === "favoritos" ? "Sincronización de favoritos" : it.target;
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
    b.textContent = `nueva: v${v.latest}`;
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
  ytSub.textContent = d.ytdlpPath ?? (d.ytdlpPresent ? "listo" : "no instalado");
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
    ? "binario propio"
    : d.ffmpegPresent
      ? "del sistema"
      : "no instalado";
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
    ? c.username || "Sesión iniciada"
    : "No has iniciado sesión";
  $<HTMLElement>("account-user").textContent = logged
    ? "Listo para descargar tus favoritos"
    : "Inicia sesión para descargar tus favoritos";
  const chip = $<HTMLElement>("account-chip");
  chip.textContent = logged ? "con sesión" : "sin sesión";
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
    setSidebar(false, "Vista previa sin conexión a la app");
    return null;
  }
  try {
    const s: StatusSnapshot = await api.request.getStatus({});
    renderDeps(s.deps);
    renderAccount(s.config);
    renderLikes(s.likesCount);
    seedSettings(s.config);
    if (!s.deps.ready) setSidebar(false, "Instala las dependencias");
    else if (!s.config.hasToken) setSidebar(false, "Inicia sesión");
    else setSidebar(true, `Listo: ${s.likesCount ?? "?"} favoritos`);
    return s;
  } catch (err) {
    toast(`Error al cargar el estado: ${(err as Error).message}`, "error", true);
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
  toast("La app no está conectada", "error", true);
  return false;
};

$<HTMLButtonElement>("btn-install-deps").addEventListener("click", () =>
  runDepsInstall(),
);

$<HTMLButtonElement>("btn-login").addEventListener("click", () =>
  withBusy("btn-login", async () => {
    if (!guard()) return;
    toast("Se abrirá el navegador. Inicia sesión y, si aparece un captcha, resuélvelo.");
    try {
      await api.request.login({});
      toast("Sesión iniciada", "success");
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
      toast("Pega un token primero", "warn");
      return;
    }
    await api.request.loginWithToken({ token });
    closeTokenModal();
    toast("Token guardado", "success");
    await loadStatus();
  }),
);

$<HTMLButtonElement>("btn-logout").addEventListener("click", () =>
  withBusy("btn-logout", async () => {
    if (!guard()) return;
    await api.request.logout({});
    toast("Sesión cerrada", "success");
    await loadStatus();
  }),
);

$<HTMLButtonElement>("btn-refresh-likes").addEventListener("click", () =>
  withBusy("btn-refresh-likes", async () => {
    if (!guard()) return;
    const res = await api.request.refreshLikes({});
    renderLikes(res.count);
    setSidebar(true, `Listo: ${res.count} favoritos`);
    toast(`${res.count} favoritos actualizados`, "success");
  }),
);

$<HTMLButtonElement>("btn-download-all").addEventListener("click", () =>
  withBusy("btn-download-all", async () => {
    if (!guard()) return;
    showView("download");
    $<HTMLDivElement>("dev-log").textContent = "";
    await api.request.downloadAll({});
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
    btn.textContent = "Pausar";
    downloadPaused = false;
  } else {
    api.request.pauseDownload({});
    btn.textContent = "Reanudar";
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
  const query = input.value.trim().toLowerCase();
  const results = $<HTMLElement>("search-results");

  if (!query) {
    renderSearchEmpty("Escribe algo para buscar", "Se buscará solo en tu lista de favoritos.");
    return;
  }

  results.textContent = "";
  const searching = document.createElement("p");
  searching.className = "text-sm text-ink-400 flex items-center gap-2";
  searching.innerHTML = '<span class="spinner spinner-accent"></span> Buscando...';
  results.appendChild(searching);

  let cache = await api.request.getLikesCache({});
  if (cache.tracks.length === 0) {
    toast("Refrescando la lista de favoritos...");
    await api.request.refreshLikes({});
    cache = await api.request.getLikesCache({});
  }

  const matches = cache.tracks.filter(
    (t: LikedTrackPayload) =>
      t.title.toLowerCase().includes(query) ||
      (t.uploader ?? "").toLowerCase().includes(query),
  );
  results.textContent = "";

  if (matches.length === 0) {
    renderSearchEmpty(
      `Sin resultados para "${input.value.trim()}"`,
      "Prueba con otro término o refresca la lista de favoritos.",
    );
    return;
  }

  const shown = matches.slice(0, 30);
  if (matches.length > shown.length) {
    const more = document.createElement("p");
    more.className = "text-xs text-ink-500 mb-1";
    more.textContent = `${matches.length} coincidencias; mostrando las primeras ${shown.length}.`;
    results.appendChild(more);
  }
  for (const t of shown) results.appendChild(trackCard(t));
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
      toast("Pega un enlace de SoundCloud primero", "warn");
      return;
    }
    showView("download");
    $<HTMLDivElement>("dev-log").textContent = "";
    $<HTMLParagraphElement>("dl-title").textContent = url;
    showDlControls();
    await api.request.downloadUrl({ url });
    await renderSyncStats();
    await renderHistory();
  }),
);
$<HTMLInputElement>("url-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $<HTMLButtonElement>("btn-download-url").click();
});
$<HTMLButtonElement>("btn-search-refresh").addEventListener("click", () =>
  withBusy("btn-search-refresh", async () => {
    if (!guard()) return;
    await api.request.refreshLikes({});
    toast("Lista de favoritos actualizada", "success");
    if ($<HTMLInputElement>("search-input").value.trim()) await doSearch();
  }),
);

// ---- Editor de plantilla de nombre (chips) ----
const VAR_TITLES: Record<string, string> = {
  title: "Título",
  uploader: "Subidor",
  artist: "Artista",
  album: "Álbum",
  id: "ID",
  playlist_index: "Nº",
  ext: "Ext",
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
  chip.textContent = VAR_TITLES[variable] ?? `%(${variable})s`;
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
    preview ? `Nombre: ${preview}.mp3` : "";
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
  renderTemplateToEditor(c.filenameTemplate ?? "%(title)s - %(artist)s");
  updateTemplatePreview();
  $<HTMLInputElement>("set-skip").checked = c.skipExisting ?? true;
  applyTheme(c.theme ?? "dark");
  updateBitrateState();
}

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
      toast("El formato del nombre de archivo no puede estar vacío", "warn");
      return;
    }
    if (!/\([^)]+\)/.test(template)) {
      toast("El nombre debe incluir al menos una variable", "warn");
      return;
    }
    await api.request.saveConfig({
      outdir: $<HTMLInputElement>("set-outdir").value.trim(),
      format: $<HTMLSelectElement>("set-format").value,
      bitrate: $<HTMLSelectElement>("set-bitrate").value,
      filenameTemplate: template,
      theme: $<HTMLSelectElement>("set-theme").value,
      skipExisting: $<HTMLInputElement>("set-skip").checked,
    });
    toast("Ajustes guardados", "success");
    await loadStatus();
  }),
);

// ---- Exportar / importar configuración ----
function openConfigModal(mode: "export" | "import", text = ""): void {
  const modal = $<HTMLElement>("config-modal");
  modal.classList.remove("hidden");
  $<HTMLElement>("config-modal-title").textContent =
    mode === "export" ? "Exportar configuración" : "Importar configuración";
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
  toast("Configuración copiada al portapapeles", "success");
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
    toast("Configuración importada", "success");
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
      ["Total", String(items.length)],
      ["Últimos 7 días", String(last7)],
      ["Formatos", Object.entries(byFormat).map(([f, n]) => `${f} ×${n}`).join(" · ") || "—"],
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
$<HTMLButtonElement>("btn-cleanup").addEventListener("click", () =>
  withBusy("btn-cleanup", async () => {
    if (!guard()) return;
    const ok = window.confirm(
      "Se eliminarán de la carpeta las canciones descargadas que ya no estén en tus favoritos. ¿Continuar?",
    );
    if (!ok) return;
    const res = await api.request.cleanupNonFavorites({});
    if (res.removed.length) {
      toast(`Eliminadas ${res.removed.length} canciones`, "success");
    } else {
      toast("No había canciones que limpiar", "info");
    }
    await renderSyncStats();
  }),
);

// ---- Colección (favoritos / playlists) ----
const collectionState = {
  source: "favorites" as "favorites" | "playlists",
  playlistUrl: null as string | null,
  playlistsCache: null as { id: string; title: string; url: string }[] | null,
  playlistTracksCache: null as { url: string; tracks: LikedTrackPayload[] } | null,
};

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

  if (collectionState.source === "favorites") {
    await renderCollectionFavorites();
  } else if (collectionState.playlistUrl) {
    await renderCollectionPlaylistTracks();
  } else {
    await renderCollectionPlaylists();
  }
}

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

  if (!tracks.length) {
    content.appendChild(emptyState("No hay favoritos todavía", "Refresca la lista desde Inicio si crees que falta algo."));
    return;
  }

  const header = document.createElement("div");
  header.className = "flex items-center justify-between gap-3 flex-wrap";
  const h = document.createElement("p");
  h.className = "text-sm text-ink-300";
  h.textContent = `${tracks.length} canciones`;
  const dl = document.createElement("button");
  dl.className =
    "px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-sm font-semibold text-white active:scale-[0.98] transition-all";
  dl.textContent = "Descargar todo";
  dl.addEventListener("click", () =>
    withBusy("", async () => {
      if (!guard()) return;
      startDownloadView("Tus favoritos");
      await api.request.downloadAll({});
      await renderSyncStats();
      await renderHistory();
    }),
  );
  header.appendChild(h);
  header.appendChild(dl);

  const list = document.createElement("div");
  list.className = "space-y-1.5 max-h-[60vh] overflow-y-auto pr-1";
  for (const t of tracks) list.appendChild(collectionTrackRow(t));

  content.appendChild(header);
  content.appendChild(list);
}

async function renderCollectionPlaylists(): Promise<void> {
  const content = $<HTMLElement>("collection-content");
  if (!isApp) return;

  if (!collectionState.playlistsCache) {
    content.appendChild(loadingState("Cargando tus playlists..."));
    try {
      const res = await api.request.getPlaylists({});
      collectionState.playlistsCache = res.playlists;
    } catch (err) {
      content.appendChild(emptyState("No se pudieron cargar las playlists", (err as Error).message));
      return;
    }
  }

  const playlists = collectionState.playlistsCache;
  if (!playlists?.length) {
    content.appendChild(emptyState("No tienes playlists", "Las playlists (sets) de tu cuenta aparecerán aquí."));
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
    content.appendChild(loadingState("Cargando canciones de la playlist..."));
    try {
      const res = await api.request.getPlaylistTracks({ url });
      collectionState.playlistTracksCache = { url, tracks: res.tracks };
    } catch (err) {
      content.appendChild(emptyState("No se pudieron cargar las canciones", (err as Error).message));
      return;
    }
  }

  const tracks = collectionState.playlistTracksCache!.tracks;

  const top = document.createElement("div");
  top.className = "flex items-center justify-between gap-3 flex-wrap";
  const left = document.createElement("div");
  left.className = "flex items-center gap-2";
  const back = document.createElement("button");
  back.className =
    "px-3 py-1.5 rounded-lg border border-ink-700 text-sm text-ink-200 hover:bg-ink-800 transition-colors";
  back.textContent = "‹ Atrás";
  back.addEventListener("click", () => {
    collectionState.playlistUrl = null;
    renderCollection();
  });
  const count = document.createElement("p");
  count.className = "text-sm text-ink-300";
  count.textContent = `${tracks.length} canciones`;
  left.appendChild(back);
  left.appendChild(count);

  const dl = document.createElement("button");
  dl.className =
    "px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-sm font-semibold text-white active:scale-[0.98] transition-all";
  dl.textContent = "Descargar todo";
  dl.disabled = tracks.length === 0;
  if (tracks.length === 0) dl.classList.add("opacity-50", "pointer-events-none");
  dl.addEventListener("click", () =>
    withBusy("", async () => {
      if (!guard()) return;
      startDownloadView("Playlist completa");
      await api.request.downloadUrls({ urls: tracks.map((t) => t.url) });
      await renderSyncStats();
      await renderHistory();
    }),
  );
  top.appendChild(left);
  top.appendChild(dl);

  content.appendChild(top);

  if (!tracks.length) {
    content.appendChild(emptyState("La playlist está vacía", ""));
    return;
  }
  const list = document.createElement("div");
  list.className = "space-y-1.5 max-h-[60vh] overflow-y-auto pr-1";
  for (const t of tracks) list.appendChild(collectionTrackRow(t));
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
  renderCollection();
});
$<HTMLButtonElement>("src-playlists").addEventListener("click", () => {
  collectionState.source = "playlists";
  renderCollection();
});

// ---- Arranque ----
resetDownloadUI();
showView("status");
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
    await api.request.checkAppUpdate({});
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
        `Dependencias actualizadas: ${r.updated.join(", ")}`,
        "success",
        false,
        6000,
      );
    }
  } catch {
    // Sin red u otro fallo: se ignora, no es crítico.
  }
}
