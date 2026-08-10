import { Electroview } from "electrobun/view";
import type {
  AppRPCSchema,
  ConfigPayload,
  DepsStatus,
  DownloadProgressPayload,
  LikedTrackPayload,
  LogLevel,
  StatusSnapshot,
} from "../shared/types";
import {
  detectSystemLang,
  normalizeLang,
  resolveLang,
  t,
  type Lang,
} from "../shared/i18n";

let api: AppRPCSchema extends never ? never : any = null;
let isApp = false;

try {
  const rpc = Electroview.defineRPC<AppRPCSchema>({
    maxRequestTime: Infinity,
    handlers: {
      requests: {},
      messages: {
        log: ({ level, text }) => onLog(level, text),
        status: ({ stage, message }) => onStatus(stage, message),
        downloadProgress: (p) => onProgress(p),
      },
    },
  });
  const eb = new Electroview({ rpc });
  api = eb.rpc;
  isApp = true;
} catch {
  isApp = false;
}

// ================= i18n =================
let currentLang: Lang = normalizeLang(detectSystemLang());

function T(key: string, vars?: Record<string, string | number>): string {
  return t(currentLang, key, vars);
}

function applyStaticTranslations(): void {
  document.documentElement.lang = currentLang;
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    el.textContent = T(el.dataset.i18n!);
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-ph]")) {
    el.setAttribute("placeholder", T(el.dataset.i18nPh!));
  }
  renderAll();
}

function setLang(lang: Lang): void {
  currentLang = lang;
  document.documentElement.lang = lang;
  applyStaticTranslations();
}

// ================= dom helpers =================
const $ = <T extends HTMLElement>(sel: string, root?: ParentNode): T =>
  ((root || document).querySelector(sel) as T) || (null as unknown as T);
const $$ = (sel: string, root?: ParentNode): HTMLElement[] =>
  Array.from((root || document).querySelectorAll(sel));

// ================= odometer =================
function setAnimatedText(el: HTMLElement | null, text: string | number): void {
  if (!el) return;
  const next = String(text);
  if (el.dataset.odoValue === next) return;
  const prev = el.dataset.odoValue || "";
  el.dataset.odoValue = next;
  el.textContent = "";
  next.split("").forEach((rawCh, i) => {
    const ch = rawCh === " " ? "\u00a0" : rawCh;
    const span = document.createElement("span");
    span.className = "odo-digit";
    const inner = document.createElement("span");
    inner.textContent = ch;
    if (prev[i] !== rawCh) {
      inner.className = "odo-roll";
      inner.style.animationDelay = i * 28 + "ms";
    }
    span.appendChild(inner);
    el.appendChild(span);
  });
}

// ================= toasts =================
const TOAST_COLORS: Record<LogLevel, string> = {
  success: "#22c55e",
  error: "#ef4444",
  warn: "#f59e0b",
  info: "#ff5500",
};

function toast(
  msg: string,
  kind: LogLevel = "info",
  persistent = false,
  action?: { label: string; run: () => void },
): void {
  const host = $("#toasts");
  if (!host) return;
  while (host.children.length >= 4) host.firstChild!.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.innerHTML =
    '<span class="toast-bar" style="background:' +
    TOAST_COLORS[kind] +
    '"></span><span class="flex-1 leading-snug"><span data-msg></span></span>' +
    '<button class="toast-close" aria-label="Cerrar aviso">\u00d7</button>';
  el.querySelector("[data-msg]")!.textContent = msg;
  if (action) {
    const a = document.createElement("button");
    a.className = "toast-action mt-1 block text-xs";
    a.textContent = action.label;
    a.addEventListener("click", () => {
      action.run();
      el.remove();
    });
    el.querySelector(".flex-1")!.appendChild(a);
  }
  el.querySelector(".toast-close")!.addEventListener("click", () => el.remove());
  host.appendChild(el);
  if (!persistent) setTimeout(() => el.remove(), action ? 6000 : 3800);
  return el as unknown as void;
}

// ================= estado =================
interface QueueItem {
  id: string;
  title: string;
  uploader?: string;
  url: string;
  thumbnail?: string;
  state: "queued" | "active" | "done" | "error";
  pct: number;
}

interface CollectionItem {
  id: string;
  title: string;
  uploader?: string;
  url: string;
  thumbnail?: string;
}

const state = {
  view: "status",
  loggedIn: false,
  username: "",
  deps: { ytdlp: null as null | { ok: boolean; own: boolean; ver: string; upd: boolean }, ffmpeg: null as null | { ok: boolean; own: boolean; ver: string } },
  config: null as ConfigPayload | null,
  likes: [] as CollectionItem[],
  playlists: [] as { id: string; title: string; url: string; uploader?: string; count?: number }[],
  history: [] as { ts: number; target: string; format: string; ok: boolean }[],
  downloadedIds: new Set<string>(),
  queue: [] as QueueItem[],
  qPage: 1,
  qPer: 6,
  downloading: false,
  paused: false,
  curIdx: 0,
  tab: "likes",
  colMode: "grid",
  searchMode: "grid",
  openPlaylist: null as null | { id: string; title: string; url: string },
  playlistTracks: [] as CollectionItem[],
  searchResults: null as CollectionItem[] | null,
  log: [] as string[],
  syncTotal: 0,
  syncDone: 0,
  // settings dirty
  baseline: "",
};

// ================= arte generado (avatares de pistas) =================
const ART_PALETTE: [string, string][] = [
  ["#e8e4dd", "#1c1c1a"],
  ["#1c1c1a", "#e8e4dd"],
  ["#2b3440", "#c3cbd6"],
  ["#d9d3c7", "#8a5a3b"],
  ["#3f4a44", "#cfd8cf"],
  ["#f0ece4", "#ff5500"],
  ["#232a33", "#ff5500"],
  ["#6b6257", "#f2ede3"],
];
const artCache: Record<string, string> = {};
function hashOf(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}
/** Reduce la portada original de SoundCloud a un tamaño razonable para la UI. */
function artworkUrl(url: string): string {
  return url.replace(/-original\.(jpe?g|png|webp)$/i, "-t500x500.$1");
}
function artFor(item: { title: string; uploader?: string; thumbnail?: string }): string {
  if (item.thumbnail) return artworkUrl(item.thumbnail);
  const key = (item.title || "") + "|" + (item.uploader || "");
  if (artCache[key]) return artCache[key];
  const h = hashOf(key);
  const [a, b] = ART_PALETTE[h % ART_PALETTE.length];
  const kind = h % 4;
  let shapes = "";
  if (kind === 0) {
    shapes =
      '<circle cx="' + (20 + (h % 40)) + '" cy="' + (25 + ((h >> 3) % 40)) + '" r="' + (16 + (h % 18)) + '" fill="' + b + '"/>' +
      '<rect x="0" y="' + (60 + (h % 20)) + '" width="100" height="6" fill="' + b + '" opacity=".7"/>';
  } else if (kind === 1) {
    shapes =
      '<path d="M0 100 L' + (30 + (h % 30)) + ' ' + (20 + (h % 30)) + ' L100 100 Z" fill="' + b + '"/>' +
      '<rect x="' + (10 + (h % 20)) + '" y="10" width="8" height="' + (20 + (h % 40)) + '" fill="' + b + '" opacity=".6"/>';
  } else if (kind === 2) {
    shapes = Array.from({ length: 6 }, (_, i) =>
      '<rect x="' + (8 + i * 15) + '" y="' + (70 - ((h >> i) % 55)) + '" width="9" height="' + (12 + ((h >> i) % 55)) + '" fill="' + b + '" opacity="' + (0.5 + (i % 3) * 0.25) + '"/>',
    ).join("");
  } else {
    shapes =
      '<rect x="' + (12 + (h % 24)) + '" y="' + (12 + ((h >> 2) % 24)) + '" width="' + (34 + (h % 26)) + '" height="' + (34 + ((h >> 4) % 26)) + '" fill="' + b + '"/>' +
      '<circle cx="82" cy="82" r="14" fill="none" stroke="' + b + '" stroke-width="4"/>';
  }
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="' + a + '"/>' + shapes + "</svg>";
  const url = "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  artCache[key] = url;
  return url;
}
function artImg(item: { title: string; uploader?: string }, cls: string): string {
  return '<img src="' + artFor(item) + '" alt="" aria-hidden="true" class="' + cls + '" loading="lazy" />';
}

// ================= log =================
function onLog(level: LogLevel, text: string): void {
  state.log.push(text);
  if (state.log.length > 400) state.log.shift();
  const pre = $("#dev-log");
  if (pre) {
    const auto = $("#log-autoscroll") as HTMLInputElement | null;
    const stick = !auto || auto.checked;
    pre.textContent = state.log.join("\n");
    if (stick) pre.scrollTop = pre.scrollHeight;
  }
}
function log(line: string): void {
  onLog("info", line);
}

// ================= navegación =================
function setView(view: string): void {
  state.view = view;
  $$("[data-nav]").forEach((b) => {
    const on = b.dataset.nav === view;
    b.classList.toggle("is-active", on);
    if (b.hasAttribute("aria-current") || on) b.setAttribute("aria-current", on ? "page" : "false");
  });
  $$("[data-view]").forEach((s) => s.classList.toggle("hidden", s.dataset.view !== view));
  const main = document.querySelector("main");
  if (main) main.scrollTop = 0;
  if (view === "download") renderAll();
  if (view === "collection") renderCollection();
  if (view === "settings") renderBitrates();
  if (view === "developer") renderDev();
}

// ================= sidebar =================
function renderSidebarState(): void {
  const dot = $("#sb-dot");
  const txt = $("#sb-state");
  const box = $("#sb-status");
  let color = "bg-amber-400";
  let label = T("sidebar.loading");
  let action = "";
  if (!state.deps.ytdlp?.ok || !state.deps.ffmpeg?.ok) {
    label = T("sidebar.deps");
    action = "deps";
  } else if (!state.loggedIn) {
    label = T("sidebar.signin");
    action = "login";
  } else {
    label = T("sidebar.ready", { count: state.syncTotal || state.likes.length });
    color = "bg-emerald-400";
  }
  dot.className = "h-2 w-2 shrink-0 rounded-full " + color;
  setAnimatedText(txt, label);
  box.dataset.actionable = action ? "true" : "false";
  box.dataset.sbAction = action;
  box.title = action ? label : "";
  const dl = $("#sb-downloading");
  dl.classList.toggle("hidden", !state.downloading);
  dl.classList.toggle("flex", state.downloading);
  const pending = state.queue.filter((q) => q.state !== "done" && q.state !== "error").length;
  const badge = $("#nav-queue-badge");
  badge.textContent = pending ? String(pending) : "";
  badge.classList.toggle("hidden", !pending);
}

// ================= cuenta =================
function renderAccount(): void {
  const av = $("#acct-avatar");
  av.textContent = state.loggedIn ? (state.username[0] || "?").toUpperCase() : "?";
  av.className =
    "flex h-12 w-12 items-center justify-center font-display text-lg " +
    (state.loggedIn ? "bg-brand-600 text-white" : "bg-[var(--line)] text-[var(--text-dim)]");
  $("#acct-name").textContent = state.loggedIn ? state.username : T("account.anonymous");
  const chip = $("#acct-chip");
  chip.textContent = state.loggedIn ? T("account.loggedIn") : T("account.loggedOut");
  chip.className = "chip " + (state.loggedIn ? "chip-on" : "chip-muted");
  $("#acct-msg").textContent = state.loggedIn ? T("account.msgIn") : T("account.msgOut");
  $("#btn-logout").classList.toggle("hidden", !state.loggedIn);
}

// ================= herramientas =================
function toolRow(name: string, d: { ok: boolean; own?: boolean; ver?: string; upd?: boolean }): string {
  return (
    '<div class="flex items-center gap-3 rounded-none border border-[var(--line)] px-3 py-2.5">' +
    '<span class="flex h-6 w-6 items-center justify-center text-xs ' +
    (d.ok ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400") +
    '">' +
    (d.ok ? "✓" : "✗") +
    "</span>" +
    '<div class="min-w-0 flex-1"><p class="text-sm font-medium">' +
    name +
    '</p><p class="row-sub">' +
    (d.ok ? (d.own ? T("tools.own") : T("tools.system")) : T("tools.missing")) +
    "</p></div>" +
    (d.ok
      ? '<span class="font-mono text-xs text-[var(--text-dim)]">' + (d.ver || "") + "</span>" +
        (d.upd
          ? '<span class="chip ml-2" style="background:rgba(255,85,0,.15);color:#ff7a33">' + T("tools.update") + "</span>"
          : "")
      : "") +
    "</div>"
  );
}
function renderTools(): void {
  const yt = state.deps.ytdlp;
  const ff = state.deps.ffmpeg;
  $("#tools-list").innerHTML =
    toolRow("yt-dlp", yt || { ok: false }) +
    toolRow("ffmpeg", ff || { ok: false });
  $("#btn-install").classList.toggle("hidden", !!(yt?.ok && ff?.ok));
}

// ================= sync =================
function renderSync(): void {
  const done = state.syncDone;
  const total = state.syncTotal;
  const missing = total - done;
  setAnimatedText(
    $("#sync-state"),
    total === 0 ? T("dl.calculating") : missing === 0 ? T("dl.allDone") : T("dl.missingState", { n: missing }),
  );
  setAnimatedText($("#missing-count"), String(missing));
  setAnimatedText($("#sync-done"), String(done));
  setAnimatedText($("#sync-total"), String(total));
  $("#sync-fill").style.width = (total ? (done / total) * 100 : 0) + "%";
  setAnimatedText($("#likes-count"), String(total || state.likes.length));
}

// ================= cola =================
function queueStatusHtml(item: QueueItem): string {
  if (item.state === "done")
    return (
      '<span class="flex items-center gap-2 text-xs text-emerald-400">✓ ' +
      T("q.done") +
      '<button class="pager" data-open-folder="' + item.id + '" title="Abrir carpeta">📁</button></span>'
    );
  if (item.state === "error") return '<span class="text-xs text-red-400">' + T("q.error") + "</span>";
  if (item.state === "active")
    return (
      '<span class="flex items-center gap-2 text-xs text-brand-500"><span class="spinner spinner-accent h-3.5 w-3.5"></span>' +
      item.pct +
      "%</span>"
    );
  return '<span class="text-xs text-[var(--text-dim)]">' + T("q.queued") + "</span>";
}

function renderQueue(): void {
  const list = $("#queue-list");
  const pages = Math.max(1, Math.ceil(state.queue.length / state.qPer));
  if (state.qPage > pages) state.qPage = pages;
  setAnimatedText($("#q-page"), String(state.qPage));
  setAnimatedText($("#q-pages"), String(pages));
  const pending = state.queue.filter((q) => q.state !== "done" && q.state !== "error").length;
  $("#q-count").textContent = state.queue.length ? pending + "/" + state.queue.length : "";
  if (!state.queue.length) {
    list.innerHTML =
      '<div class="empty"><svg viewBox="0 0 24 24" class="empty-ico"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/></svg><p>' +
      T("dl.queueEmpty") +
      "</p></div>";
    return;
  }
  const start = (state.qPage - 1) * state.qPer;
  list.innerHTML = state.queue
    .slice(start, start + state.qPer)
    .map(
      (it, i) =>
        '<div class="row"><span class="row-num">' +
        (start + i + 1) +
        "</span>" +
        artImg(it, "row-art") +
        '<div class="row-main"><p class="row-title">' +
        it.title +
        '</p><p class="row-sub">' +
        (it.uploader || "") +
        "</p></div>" +
        queueStatusHtml(it) +
        "</div>",
    )
    .join("");
}

function renderHistory(): void {
  const failed = state.history.filter((h) => !h.ok).length;
  $("#h-count").textContent = state.history.length + (failed ? " · " + failed + " ✗" : "");
  $("#btn-retry-failed").classList.toggle("hidden", !failed);
  $("#history-list").innerHTML = state.history
    .slice(0, 30)
    .map(
      (h) =>
        '<div class="row"><div class="row-main"><p class="row-title">' +
        h.target +
        '</p><p class="row-sub">' +
        new Date(h.ts).toLocaleString() +
        " · " +
        h.format +
        '</p></div><span class="text-xs ' +
        (h.ok ? "text-emerald-400" : "text-red-400") +
        '">' +
        (h.ok ? "✓" : "✗") +
        "</span></div>",
    )
    .join("");
}

// ================= descarga =================
let currentDownloadUrl: string | null = null;

function canDownload(): boolean {
  if (!state.deps.ytdlp?.ok || !state.deps.ffmpeg?.ok) {
    toast(T("toast.needDeps"), "error", false, { label: T("modal.deps.title"), run: () => openModal("deps") });
    return false;
  }
  if (!state.loggedIn) {
    toast(T("toast.needLogin"), "warn", false, { label: T("account.login"), run: () => setView("status") });
    return false;
  }
  return true;
}

function isDownloaded(id: string): boolean {
  return state.downloadedIds.has(id);
}

function trackButtonHtml(item: CollectionItem): string {
  if (isDownloaded(item.id)) return '<button class="btn-secondary" disabled>✓ ' + T("q.done") + "</button>";
  const q = state.queue.find((x) => x.id === item.id);
  if (q?.state === "active")
    return '<button class="btn-secondary"><span class="spinner spinner-accent h-3.5 w-3.5"></span>' + q.pct + "%</button>";
  if (q?.state === "queued") return '<button class="btn-secondary" disabled>' + T("q.queued") + "</button>";
  return '<button class="btn-primary" data-dl-track="' + item.id + '">' + T("common.download") + "</button>";
}

function rowHtml(item: CollectionItem, n: number): string {
  return (
    '<div class="row"><span class="row-num">' +
    n +
    "</span>" +
    artImg(item, "row-art") +
    '<div class="row-main"><p class="row-title">' +
    item.title +
    '</p><p class="row-sub">' +
    (item.uploader || "") +
    "</p></div>" +
    trackButtonHtml(item) +
    "</div>"
  );
}

function cardHtml(item: CollectionItem): string {
  const done = isDownloaded(item.id);
  const q = state.queue.find((x) => x.id === item.id);
  return (
    '<div class="tile' + (done ? " is-done" : "") + '">' +
    '<div class="tile-art">' +
    artImg(item, "tile-img") +
    (done ? '<span class="tile-flag">✓</span>' : "") +
    (q?.state === "active" ? '<span class="tile-flag is-live">' + q.pct + "%</span>" : "") +
    '<div class="tile-hover">' + trackButtonHtml(item) + "</div>" +
    "</div>" +
    '<p class="tile-title" title="' + item.title + '">' + item.title + "</p>" +
    '<p class="tile-sub">' + (item.uploader || "") + "</p>" +
    "</div>"
  );
}

function listOrGrid(items: CollectionItem[], mode: string): string {
  return mode === "grid"
    ? '<div class="tile-grid">' + items.map(cardHtml).join("") + "</div>"
    : items.map((l, i) => rowHtml(l, i + 1)).join("");
}

function playlistCardHtml(p: { title: string; uploader?: string; count?: number }, i: number): string {
  const fake = { title: p.title, uploader: p.uploader };
  return (
    '<div class="tile"><div class="tile-art">' +
    artImg(fake, "tile-img") +
    '<span class="tile-flag">' + (p.count ?? "") + "</span>" +
    '<div class="tile-hover"><button class="btn-primary" data-open-playlist="' + i + '">' + T("col.open") + "</button></div>" +
    '</div><p class="tile-title">' + p.title + '</p><p class="tile-sub">' + (p.uploader || "") + "</p></div>"
  );
}

// ================= colección =================
function renderCollection(): void {
  const q = (($("#col-filter") as HTMLInputElement).value || "").toLowerCase();
  $("#col-clear").classList.toggle("hidden", !q);
  setAnimatedText($("#tab-likes-count"), String(state.likes.length));
  setAnimatedText($("#tab-pl-count"), String(state.playlists.length));
  $$("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === state.tab)));
  if (state.openPlaylist) $("#col-tracks-title").textContent = state.openPlaylist.title;
  const isLikes = state.tab === "likes";
  $("#col-likes").classList.toggle("hidden", !isLikes);
  $("#col-playlists").classList.toggle("hidden", isLikes || !!state.openPlaylist);
  $("#col-tracks").classList.toggle("hidden", isLikes || !state.openPlaylist);

  const mode = state.colMode;
  if (isLikes) {
    const rows = state.likes.filter((l) => (l.title + (l.uploader || "")).toLowerCase().includes(q));
    $("#col-likes").innerHTML = rows.length
      ? listOrGrid(rows, mode)
      : '<div class="empty"><p>' + T("col.emptyFilter") + "</p></div>";
  } else if (state.openPlaylist) {
    const tracks = state.playlistTracks.filter((l) =>
      (l.title + (l.uploader || "")).toLowerCase().includes(q),
    );
    $("#col-tracks-list").innerHTML = tracks.length
      ? listOrGrid(tracks, mode)
      : '<div class="empty"><p>' + T("col.emptyFilter") + "</p></div>";
  } else {
    const rows = state.playlists.filter((p) => (p.title + (p.uploader || "")).toLowerCase().includes(q));
    const idxOf = (p: (typeof state.playlists)[number]) => state.playlists.indexOf(p);
    $("#col-playlists").innerHTML = rows.length
      ? mode === "grid"
        ? '<div class="tile-grid">' + rows.map((p) => playlistCardHtml(p, idxOf(p))).join("") + "</div>"
        : rows
            .map(
              (p) =>
                '<div class="row"><span class="row-num">' +
                (idxOf(p) + 1) +
                "</span>" +
                artImg({ title: p.title, uploader: p.uploader }, "row-art") +
                '<div class="row-main"><p class="row-title">' +
                p.title +
                '</p><p class="row-sub">' +
                (p.uploader || "") +
                " · " +
                (p.count ?? "") +
                '</p></div><button class="btn-secondary" data-open-playlist="' +
                idxOf(p) +
                '">' +
                T("col.open") +
                "</button></div>",
            )
            .join("")
      : '<div class="empty"><p>' + T("col.emptyFilter") + "</p></div>";
  }
  syncModeButtons("col", state.colMode);
}

function syncModeButtons(scope: "col" | "search", mode: string): void {
  $$("[data-mode]").forEach((b) => {
    const [s, m] = b.dataset.mode!.split(":");
    const cur = s === "col" ? state.colMode : state.searchMode;
    b.classList.toggle("is-active", cur === m);
    b.setAttribute("aria-pressed", String(cur === m));
  });
}

// ================= ajustes =================
const BITRATES: Record<string, string[] | null> = {
  m4a: ["256k", "224k", "192k", "160k", "128k", "96k", "64k"],
  mp3: ["320k", "256k", "192k", "160k", "128k", "96k", "64k"],
  opus: ["160k", "128k", "96k", "64k"],
  vorbis: ["192k", "160k", "128k", "96k", "64k"],
  flac: null,
  wav: null,
  original: null,
};

function renderBitrates(): void {
  const fmt = ($("#set-format") as HTMLSelectElement).value;
  const sel = $("#set-bitrate") as HTMLSelectElement;
  const opts = BITRATES[fmt];
  sel.innerHTML = opts
    ? opts.map((b) => '<option value="' + b + '">' + b + "</option>").join("")
    : '<option value="">—</option>';
  sel.disabled = !opts;
  renderTplPreview();
}

const TPL_FIELDS: [string, string, string][] = [
  ["title", "Título", "Title"],
  ["uploader", "Subidor", "Uploader"],
  ["artist", "Artista", "Artist"],
  ["album", "Álbum", "Album"],
  ["id", "ID", "ID"],
  ["playlist_index", "Nº", "No."],
  ["ext", "Ext", "Ext"],
];

function renderTplChips(): void {
  $("#tpl-chips").innerHTML = TPL_FIELDS.map(
    (f) =>
      '<button class="tpl-chip" data-tpl="' + f[0] + '">' + (currentLang === "es" ? f[1] : f[2]) + "</button>",
  ).join("");
}

function renderTplPreview(): void {
  const tpl = $("#tpl-editor").textContent || "";
  const fmt = ($("#set-format") as HTMLSelectElement).value;
  const ext = fmt === "original" ? "m4a" : fmt;
  const rendered = tpl
    .replace(/%\(title\)s/g, "Neon Backroad")
    .replace(/%\(uploader\)s/g, "Kaori Lane")
    .replace(/%\(artist\)s/g, "Kaori Lane")
    .replace(/%\(album\)s/g, "Singles")
    .replace(/%\(id\)s/g, "100042")
    .replace(/%\(playlist_index\)s/g, "07")
    .replace(/%\(ext\)s/g, ext);
  // La extensión la añade yt-dlp al descargar; se muestra en la preview.
  $("#tpl-preview").textContent = rendered + (/%\(ext\)s/.test(tpl) ? "" : "." + ext);
}

function snapshotSettings(): string {
  return JSON.stringify({
    f: ($("#set-folder") as HTMLInputElement).value,
    fmt: ($("#set-format") as HTMLSelectElement).value,
    br: ($("#set-bitrate") as HTMLSelectElement).value,
    tpl: $("#tpl-editor").textContent,
    skip: ($("#set-skip") as HTMLInputElement).checked,
    theme: ($("#set-theme") as HTMLSelectElement).value,
    lang: currentLang,
  });
}
function markClean(): void {
  state.baseline = snapshotSettings();
  refreshDirty();
}
function refreshDirty(): void {
  const tpl = $("#tpl-editor").textContent || "";
  // yt-dlp añade la extensión al descargar; solo exigimos al menos una variable.
  const tplBad = !/%\([^)]+\)s/.test(tpl);
  $("#tpl-error").classList.toggle("hidden", !tplBad);
  const dirty = snapshotSettings() !== state.baseline;
  $("#set-dirty").classList.toggle("hidden", !dirty);
  const btn = $("#btn-save-settings") as HTMLButtonElement;
  btn.disabled = !dirty || tplBad;
  btn.title = tplBad ? T("set.tplError") : dirty ? "" : T("tip.noChanges");
}

// ================= tema / idioma =================
function applyTheme(theme: string): void {
  document.documentElement.classList.toggle("dark", theme !== "light");
  ($("#set-theme") as HTMLSelectElement).value = theme;
}
function applyLang(next: Lang): void {
  currentLang = next;
  ($("#set-lang") as HTMLSelectElement).value = next;
  applyStaticTranslations();
}

// ================= búsqueda =================
function renderSearch(query: string): void {
  const box = $("#search-results");
  const counter = $("#search-count");
  if (!query && !state.searchResults) {
    box.innerHTML =
      '<div class="empty"><svg viewBox="0 0 24 24" class="empty-ico"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><p>' +
      T("search.empty") +
      '</p><p class="note">' + T("search.hint") + "</p></div>";
    counter.textContent = "";
    syncModeButtons("search", state.searchMode);
    return;
  }
  const pool =
    state.searchResults ||
    state.likes.filter((l) =>
      (l.title + (l.uploader || "")).toLowerCase().includes(query.toLowerCase()),
    );
  counter.textContent = pool.length ? String(pool.length) : "0";
  box.innerHTML = pool.length
    ? listOrGrid(pool, state.searchMode)
    : '<div class="empty"><p>' + T("search.none") + "</p></div>";
  syncModeButtons("search", state.searchMode);
}

// ================= dev =================
function renderDev(): void {
  const ok = state.history.filter((h) => h.ok).length;
  const errors = state.history.filter((h) => !h.ok).length;
  const perDay = state.history.length ? Math.round(state.history.length / Math.max(1, new Date().getDay() || 1)) : 0;
  const cards: [string, string][] = [
    [T("dev.perDay"), String(perDay)],
    [T("dev.total"), String(state.history.length)],
    [T("dev.errors"), String(errors)],
    [T("dev.space"), "-"],
  ];
  $("#dev-stats").innerHTML = cards
    .map(
      (c) =>
        '<div class="card !p-4"><p class="label">' + c[0] + '</p><p class="mt-1 font-display text-2xl font-semibold">' + c[1] + "</p></div>",
    )
    .join("");
}

// ================= modales =================
function openModal(id: string): void {
  $("#modal-" + id).classList.remove("hidden");
}
function closeModal(el: HTMLElement): void {
  el.classList.add("hidden");
}

let purgeTimer: ReturnType<typeof setInterval> | null = null;
function openPurge(): void {
  const n = state.likes.length; // preview: se recalcula en el service
  $("#purge-count").textContent = String(n);
  const btn = $("#purge-confirm") as HTMLButtonElement;
  btn.disabled = true;
  let left = 3;
  setAnimatedText($("#purge-timer"), String(left));
  if (purgeTimer) clearInterval(purgeTimer);
  purgeTimer = setInterval(() => {
    left -= 1;
    setAnimatedText($("#purge-timer"), String(Math.max(0, left)));
    if (left <= 0) {
      if (purgeTimer) clearInterval(purgeTimer);
      purgeTimer = null;
      btn.disabled = false;
    }
  }, 1000);
  openModal("purge");
}

async function runDeps(): Promise<void> {
  if (!isApp) return;
  const pre = $("#deps-log");
  pre.textContent = "";
  openModal("deps");
  pre.textContent += T("modal.deps.sub") + "\n";
  try {
    await api.request.installDeps({});
    pre.textContent += "done.\n";
    await loadStatus();
    toast(T("toast.depsOk"), "success");
    setTimeout(() => closeModal($("#modal-deps")), 700);
  } catch (err) {
    pre.textContent += "ERROR: " + (err as Error).message + "\n";
  }
}

function openJson(mode: "export" | "import"): void {
  $("#json-title").textContent = T(mode === "export" ? "modal.json.export" : "modal.json.import");
  const btn = $("#json-confirm") as HTMLButtonElement;
  btn.textContent = T(mode === "export" ? "common.copy" : "common.apply");
  const apply = (json: string): void => {
    try {
      const data = JSON.parse(json) as Partial<ConfigPayload>;
      if (data.outdir) ($("#set-folder") as HTMLInputElement).value = data.outdir;
      if (data.format) ($("#set-format") as HTMLSelectElement).value = data.format;
      renderBitrates();
      if (data.bitrate) ($("#set-bitrate") as HTMLSelectElement).value = data.bitrate;
      if (data.filenameTemplate) $("#tpl-editor").textContent = data.filenameTemplate;
      if (typeof data.skipExisting === "boolean") ($("#set-skip") as HTMLInputElement).checked = data.skipExisting;
      if (data.theme) applyTheme(data.theme);
      if (data.lang) applyLang(normalizeLang(data.lang));
      renderTplPreview();
      refreshDirty();
      toast(T("toast.imported"), "success");
    } catch {
      toast(T("toast.badJson"), "error");
      return;
    }
  };
  btn.onclick = async () => {
    if (mode === "export") {
      if (!isApp) return;
      try {
        const r = await api.request.exportConfig({});
        ($("#json-area") as HTMLTextAreaElement).value = r.json;
        navigator.clipboard && navigator.clipboard.writeText(r.json);
        toast(T("toast.copied"), "success");
      } catch {
        toast(T("toast.badJson"), "error");
        return;
      }
      return;
    }
    apply(($("#json-area") as HTMLTextAreaElement).value);
    closeModal($("#modal-json"));
  };
  if (mode === "export") {
    if (isApp) {
      api.request.exportConfig({}).then((r: { json: string }) => {
        ($("#json-area") as HTMLTextAreaElement).value = r.json;
      });
    } else {
      ($("#json-area") as HTMLTextAreaElement).value = "";
    }
  } else {
    ($("#json-area") as HTMLTextAreaElement).value = "";
  }
  openModal("json");
}

// ================= datos (RPC) =================
async function loadStatus(): Promise<StatusSnapshot | null> {
  if (!isApp) return null;
  try {
    const s = await api.request.getStatus({});
    state.config = s.config;
    state.loggedIn = !!s.config.hasToken;
    state.username = s.config.username || "";
    const deps: DepsStatus = s.deps;
    state.deps = {
      ytdlp: deps.ytdlpPresent
        ? { ok: true, own: !!deps.ytdlpPath, ver: deps.ytdlpVersion.current || "", upd: !!deps.ytdlpVersion.hasUpdate }
        : null,
      ffmpeg: deps.ffmpegPresent
        ? { ok: true, own: !!deps.ffmpegDir, ver: deps.ffmpegVersion.current || "" }
        : null,
    };
    renderAccount();
    renderTools();
    renderSidebarState();
    return s;
  } catch {
    return null;
  }
}

async function loadLikes(): Promise<void> {
  if (!isApp) return;
  try {
    const r = await api.request.getLikesCache({});
    if (r.tracks.length) {
      state.likes = r.tracks as unknown as CollectionItem[];
    } else {
      const res = await api.request.refreshLikes({});
      state.likes = res.tracks as unknown as CollectionItem[];
    }
  } catch {
    state.likes = [];
  }
  renderSync();
  renderCollection();
}

async function refreshSync(): Promise<void> {
  if (!isApp) return;
  try {
    const s = await api.request.getSyncStats({});
    state.syncTotal = s.total;
    state.syncDone = s.downloaded;
    renderSync();
  } catch {
    // sin red
  }
}

async function refreshDownloaded(): Promise<void> {
  if (!isApp) return;
  try {
    const r = await api.request.getDownloadedIds({});
    state.downloadedIds = new Set(r.ids);
    renderCollection();
    renderQueue();
  } catch {
    state.downloadedIds = new Set();
  }
}

async function loadPlaylists(): Promise<void> {
  if (!isApp || !state.loggedIn) return;
  try {
    const r = await api.request.getPlaylists({});
    state.playlists = r.playlists;
  } catch {
    state.playlists = [];
  }
  renderCollection();
}

async function loadHistory(): Promise<void> {
  if (!isApp) return;
  try {
    const r = await api.request.getHistory({});
    state.history = r.items.map((it: { ts: number; target: string; format: string; ok: boolean }) => ({
      ts: it.ts,
      target: it.target,
      format: it.format,
      ok: it.ok,
    }));
    renderHistory();
  } catch {
    state.history = [];
  }
}

// ================= descarga real =================
async function startBatch(kind: "all" | "missing"): Promise<void> {
  if (!isApp) return;
  if (!canDownload()) return;
  if (state.downloading) {
    toast("Ya hay una descarga en curso", "warn");
    return;
  }
  try {
    state.downloading = true;
    state.paused = false;
    $("#dl-active").classList.remove("hidden");
    renderSidebarState();
    const r = kind === "all" ? await api.request.downloadAll({}) : await api.request.downloadMissing({});
    void r;
  } catch (err) {
    toast((err as Error).message, "error");
  } finally {
    endDownload();
    await refreshDownloaded();
    await refreshSync();
    await loadHistory();
  }
}

async function queueTrack(item: CollectionItem): Promise<void> {
  if (!isApp) return;
  if (state.queue.some((q) => q.id === item.id && q.state !== "done" && q.state !== "error")) {
    toast(T("toast.queued"), "info");
    return;
  }
  state.queue.push({ id: item.id, title: item.title, uploader: item.uploader, url: item.url, thumbnail: item.thumbnail, state: "queued", pct: 0 });
  toast(T("toast.queued"), "info");
  renderQueue();
  processQueue();
}

async function processQueue(): Promise<void> {
  if (!isApp) return;
  if (state.downloading) return; // una a la vez (batch o cola)
  let next = state.queue.find((q) => q.state === "queued") || null;
  if (!next) return;
  state.downloading = true;
  state.paused = false;
  $("#dl-active").classList.remove("hidden");
  renderSidebarState();
  while (next) {
    if (isDownloaded(next.id)) {
      next.state = "done";
      next.pct = 100;
      renderQueue();
      renderCollection();
      next = state.queue.find((q) => q.state === "queued") || null;
      continue;
    }
    next.state = "active";
    next.pct = 0;
    currentDownloadUrl = next.url;
    renderQueue();
    renderCollection();
    $("#cur-title").textContent = next.title;
    $("#cur-eta").textContent = "ETA --:--";
    $("#cur-fill").style.width = "0%";
    setAnimatedText($("#cur-pct"), "0%");
    setAnimatedText($("#cur-idx"), String(state.queue.filter((q) => q.state === "active" || q.state === "queued").length ? state.queue.indexOf(next) + 1 : 1));
    setAnimatedText($("#cur-total"), String(state.queue.length));
    try {
      const r = await api.request.downloadTrack({ url: next.url });
      next.state = r.ok ? "done" : "error";
      if (r.ok) next.pct = 100;
    } catch (err) {
      next.state = "error";
      toast((err as Error).message, "error");
    }
    currentDownloadUrl = null;
    renderQueue();
    renderCollection();
    await refreshDownloaded();
    await refreshSync();
    await loadHistory();
    next = state.queue.find((q) => q.state === "queued") || null;
  }
  endDownload();
  await refreshDownloaded();
  await refreshSync();
  await loadHistory();
}

function endDownload(): void {
  state.downloading = false;
  state.paused = false;
  currentDownloadUrl = null;
  $("#sb-dl-fill").style.width = "0%";
  $("#dl-active").classList.add("hidden");
  renderSidebarState();
}

// ================= mensajes del main =================
let syncStatsTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSyncRefresh(): void {
  if (syncStatsTimer) clearTimeout(syncStatsTimer);
  syncStatsTimer = setTimeout(() => {
    syncStatsTimer = null;
    refreshDownloaded();
    refreshSync();
  }, 700);
}

function onStatus(stage: string, message: string): void {
  if (stage === "download") {
    const done = /completada|finaliz|código|erro/i.test(message);
    if (done) {
      $("#dl-active").classList.add("hidden");
      toast(message, /completad/i.test(message) ? "success" : "error");
    } else {
      $("#dl-active").classList.remove("hidden");
    }
  } else if (stage === "song") {
    scheduleSyncRefresh();
  } else if (stage === "likes") {
    // silencioso
  } else if (stage === "login") {
    // silencioso
  } else if (stage === "update") {
    toast(message, "info", false);
  } else if (stage === "deps") {
    const pre = $("#deps-log");
    if (pre && $("#modal-deps")) pre.textContent += message + "\n";
  }
}

function onProgress(p: DownloadProgressPayload): void {
  const dlActive = $("#dl-active");
  if (dlActive) dlActive.classList.remove("hidden");
  $("#cur-title").textContent = p.title || $("#cur-title").textContent;
  $("#cur-eta").textContent = p.eta ? "ETA " + p.eta : "ETA --:--";
  $("#cur-fill").style.width = Math.min(100, p.percent) + "%";
  setAnimatedText($("#cur-pct"), Math.round(p.percent) + "%");
  const idx = p.current || state.queue.filter((q) => q.state === "active").length;
  const total = p.total || state.queue.length || state.syncTotal;
  if (idx) setAnimatedText($("#cur-idx"), String(idx));
  if (total) setAnimatedText($("#cur-total"), String(total));
  // sidebar
  $("#sb-dl-fill").style.width = Math.min(100, p.percent) + "%";
  $("#sb-dl-pct").textContent = Math.round(p.percent) + "%";
  if (p.title) $("#sb-dl-title").textContent = p.title;
  // item activo de la cola
  const active = state.queue.find((q) => q.state === "active");
  if (active) {
    active.pct = p.percent;
    renderQueue();
  }
}

// ================= acciones =================
function debounce(fn: () => void, ms: number): () => void {
  let id: ReturnType<typeof setTimeout>;
  return () => {
    clearTimeout(id);
    id = setTimeout(fn, ms);
  };
}

document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;

  const openBtn = target.closest("[data-modal-open]") as HTMLElement | null;
  if (openBtn) {
    const [id, arg] = (openBtn.dataset.modalOpen || "").split(":");
    if (id === "json") openJson(arg as "export" | "import");
    else if (id === "purge") openPurge();
    else if (id === "deps") runDeps();
    else openModal(id);
    return;
  }

  const pg = target.closest("[data-page]") as HTMLElement | null;
  if (pg) {
    const delta = Number((pg.dataset.page || "").split(":")[1]);
    const pages = Math.max(1, Math.ceil(state.queue.length / state.qPer));
    state.qPage = Math.min(pages, Math.max(1, state.qPage + delta));
    renderQueue();
    return;
  }

  const tab = target.closest("[data-tab]") as HTMLElement | null;
  if (tab) {
    state.tab = tab.dataset.tab as "likes" | "playlists";
    state.openPlaylist = null;
    $$("[data-tab]").forEach((p) => p.classList.toggle("is-active", p === tab));
    renderCollection();
    return;
  }

  const op = target.closest("[data-open-playlist]") as HTMLElement | null;
  if (op) {
    const p = state.playlists[Number(op.dataset.openPlaylist)];
    if (p) {
      state.openPlaylist = p;
      state.playlistTracks = [];
      renderCollection();
      if (isApp) {
        api.request
          .getPlaylistTracks({ url: p.url })
          .then((r: { tracks: LikedTrackPayload[]; tokenInvalid: boolean }) => {
            state.playlistTracks = r.tracks as unknown as CollectionItem[];
            renderCollection();
          })
          .catch(() => {
            state.playlistTracks = [];
            renderCollection();
          });
      }
    }
    return;
  }

  const tpl = target.closest("[data-tpl]") as HTMLElement | null;
  if (tpl) {
    $("#tpl-editor").textContent += "%(" + tpl.dataset.tpl + ")s";
    renderTplPreview();
    refreshDirty();
    return;
  }

  const dl = target.closest("[data-dl-track]") as HTMLElement | null;
  if (dl) {
    const item = state.likes.find((l) => l.id === dl.dataset.dlTrack);
    if (item) queueTrack(item);
    return;
  }

  if (target.closest("[data-open-folder]")) {
    const id = (target.closest("[data-open-folder]") as HTMLElement).dataset.openFolder;
    const item = state.queue.find((q) => q.id === id);
    if (item && isApp) {
      api.request.showDownloadedItem({ id: item.id, title: item.title }).then((r: { ok: boolean }) => {
        if (!r.ok) toast(T("toast.opened"), "info");
      });
    }
    return;
  }

  const md = target.closest("[data-mode]") as HTMLElement | null;
  if (md) {
    const [scope, mode] = (md.dataset.mode || "").split(":");
    if (scope === "col") {
      state.colMode = mode;
      renderCollection();
    } else {
      state.searchMode = mode;
      renderSearch(($("#search-input") as HTMLInputElement).value);
    }
    return;
  }

  const actEl = target.closest("[data-action]") as HTMLElement | null;
  if (!actEl) return;
  const action = actEl.dataset.action;
  handleAction(action, actEl);
});

async function handleAction(action: string | undefined, el: HTMLElement): Promise<void> {
  if (!action) return;
  if (action === "login") {
    if (!isApp) return;
    try {
      const r = await api.request.login({});
      state.loggedIn = true;
      state.username = r.username || state.username;
      await loadStatus();
      toast(T("toast.login").replace("nova.rincon", state.username), "success");
      await loadLikes();
      await refreshDownloaded();
      await refreshSync();
      loadPlaylists();
    } catch (err) {
      toast((err as Error).message, "error", false, { label: T("account.pasteToken"), run: () => openModal("token") });
    }
  } else if (action === "logout") {
    if (!isApp) return;
    await api.request.logout({});
    state.loggedIn = false;
    state.username = "";
    await loadStatus();
    toast(T("toast.logout"), "warn");
  } else if (action === "save-token") {
    const v = ($("#token-input") as HTMLInputElement).value.trim();
    if (!v) return toast(T("toast.tokenEmpty"), "error");
    if (!isApp) return;
    await api.request.loginWithToken({ token: v });
    closeModal($("#modal-token"));
    state.loggedIn = true;
    await loadStatus();
    await loadLikes();
    await refreshDownloaded();
    await refreshSync();
    loadPlaylists();
    toast(T("toast.tokenSaved"), "success");
  } else if (action === "refresh-likes") {
    if (!isApp) return;
    try {
      await api.request.refreshLikes({});
      await loadLikes();
      await refreshDownloaded();
      await refreshSync();
      toast(T("toast.refreshed"), "success");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  } else if (action === "download-all" || action === "download-missing") {
    await startBatch(action === "download-all" ? "all" : "missing");
  } else if (action === "download-missing-col") {
    await startBatch("missing");
  } else if (action === "retry-failed") {
    const failed = state.history.filter((h) => !h.ok);
    if (!failed.length) return toast(T("toast.noFailed"), "info");
    toast(T("toast.retrying", { n: failed.length }), "info", false, {
      label: T("toast.viewDownloads"),
      run: () => setView("download"),
    });
    // re-descargar: se usa downloadMissing para los que falten
    await startBatch("missing");
  } else if (action === "copy-log") {
    navigator.clipboard && navigator.clipboard.writeText(state.log.join("\n"));
    toast(T("toast.logCopied"), "success");
  } else if (action === "clear-search") {
    ($("#search-input") as HTMLInputElement).value = "";
    state.searchResults = null;
    renderSearch("");
    $("#search-input").focus();
  } else if (action === "clear-filter") {
    ($("#col-filter") as HTMLInputElement).value = "";
    renderCollection();
    $("#col-filter").focus();
  } else if (action === "pause") {
    if (!isApp) return;
    if (state.paused) {
      await api.request.resumeDownload({});
      state.paused = false;
    } else {
      await api.request.pauseDownload({});
      state.paused = true;
    }
    el.textContent = T(state.paused ? "dl.resume" : "dl.pause");
    toast(T(state.paused ? "toast.paused" : "toast.resumed"), "warn");
  } else if (action === "stop") {
    $("#btn-pause").textContent = T("dl.pause");
    state.paused = false;
    state.queue = [];
    renderQueue();
    if (isApp) await api.request.cancelDownload({});
    endDownload();
    toast(T("toast.stopped"), "warn");
  } else if (action === "search") {
    const q = ($("#search-input") as HTMLInputElement).value.trim();
    if (!q) {
      state.searchResults = null;
      renderSearch("");
      return;
    }
    if (!isApp) return;
    toast(T("search.searching"), "info", false);
    try {
      const r = await api.request.searchSoundcloud({ query: q });
      state.searchResults = r.tracks as unknown as CollectionItem[];
      renderSearch(q);
    } catch (err) {
      state.searchResults = [];
      renderSearch(q);
      toast((err as Error).message, "error");
    }
  } else if (action === "download-link") {
    const v = ($("#link-input") as HTMLInputElement).value.trim();
    const bad = !/^https?:\/\/(www\.)?soundcloud\.com\//.test(v);
    $("#link-error").classList.toggle("hidden", !bad);
    if (bad) {
      $("#link-input").focus();
      return toast(T("toast.noLink"), "error");
    }
    if (!isApp) return;
    if (!canDownload()) return;
    try {
      const r = await api.request.downloadUrl({ url: v });
      if (!r.ok) toast("Código " + r.code, "warn");
    } catch (err) {
      toast((err as Error).message, "error");
    }
    setView("download");
  } else if (action === "back-playlists") {
    state.openPlaylist = null;
    state.playlistTracks = [];
    renderCollection();
  } else if (action === "pick-folder") {
    if (!isApp) return;
    const r = await api.request.selectFolder({});
    if (r.path) {
      ($("#set-folder") as HTMLInputElement).value = r.path;
      $("#folder-error").classList.add("hidden");
      refreshDirty();
      toast(T("toast.folder"), "info");
    }
  } else if (action === "save-settings") {
    if (!($("#set-folder") as HTMLInputElement).value.trim()) {
      $("#folder-error").classList.remove("hidden");
      return toast(T("set.folderError"), "error");
    }
    $("#folder-error").classList.add("hidden");
    if (!isApp) return;
    await api.request.saveConfig({
      outdir: ($("#set-folder") as HTMLInputElement).value.trim(),
      format: ($("#set-format") as HTMLSelectElement).value,
      bitrate: ($("#set-bitrate") as HTMLSelectElement).value,
      filenameTemplate: $("#tpl-editor").textContent || "",
      theme: ($("#set-theme") as HTMLSelectElement).value,
      lang: currentLang,
      skipExisting: ($("#set-skip") as HTMLInputElement).checked,
    });
    markClean();
    toast(T("set.saved"), "success");
    loadStatus();
  } else if (action === "clear-log") {
    state.log = [];
    $("#dev-log").textContent = "";
  } else if (action === "retry-deps") {
    runDeps();
  } else if (action === "do-update") {
    $("#update-icon").classList.add("hidden");
    $("#update-spinner").classList.remove("hidden");
    $("#update-status").textContent = T("modal.update.downloading");
    if (isApp) {
      const r = await api.request.applyAppUpdate({});
      if (!r.ok) {
        $("#update-icon").classList.remove("hidden");
        $("#update-spinner").classList.add("hidden");
        $("#update-status").textContent = T("update.applyFailed");
      }
    }
  }
}

// ================= modales: cierre =================
$$("[data-modal-close]").forEach((b) =>
  b.addEventListener("click", () => closeModal(b.closest(".modal") as HTMLElement)),
);
$$(".modal").forEach((m) =>
  m.addEventListener("click", (e) => {
    if (e.target === m) closeModal(m as HTMLElement);
  }),
);
$("#purge-confirm").addEventListener("click", async () => {
  if (!isApp) return;
  closeModal($("#modal-purge"));
  try {
    const r = await api.request.cleanupNonFavorites({});
    toast(T("toast.purged") + (r.removed.length ? " (" + r.removed.length + ")" : ""), "success");
    await refreshDownloaded();
    await refreshSync();
  } catch (err) {
    toast((err as Error).message, "error");
  }
});

// ================= navegación / sidebar =================
$$("[data-nav]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.nav!)));
$("#sb-status").addEventListener("click", () => {
  const a = $("#sb-status").dataset.sbAction;
  if (a === "deps") runDeps();
  else if (a === "login") setView("status");
});
$("#sb-downloading").addEventListener("click", () => setView("download"));

// ================= ajustes listeners =================
($("#set-theme") as HTMLSelectElement).addEventListener("change", (e) => {
  applyTheme((e.target as HTMLSelectElement).value);
  refreshDirty();
});
($("#set-lang") as HTMLSelectElement).addEventListener("change", (e) => {
  applyLang(normalizeLang((e.target as HTMLSelectElement).value));
  if (isApp) api.request.saveConfig({ lang: currentLang }).catch(() => {});
});
($("#set-format") as HTMLSelectElement).addEventListener("change", () => {
  renderBitrates();
  refreshDirty();
});
$("#tpl-editor").addEventListener("input", () => {
  renderTplPreview();
  refreshDirty();
});
["#set-folder", "#set-bitrate", "#set-skip"].forEach((sel) => {
  const el = $(sel) as HTMLElement;
  el.addEventListener("input", refreshDirty);
  el.addEventListener("change", refreshDirty);
});
$("#col-filter").addEventListener("input", debounce(renderCollection, 140));
const liveSearch = debounce(() => renderSearch(($("#search-input") as HTMLInputElement).value), 220);
$("#search-input").addEventListener("input", (e) => {
  $("#search-clear").classList.toggle("hidden", !(e.target as HTMLInputElement).value);
  liveSearch();
});
$("#search-input").addEventListener("keydown", (e) => {
  const input = e.target as HTMLInputElement;
  if (e.key === "Enter") renderSearch(input.value);
  if (e.key === "Escape" && input.value) {
    input.value = "";
    $("#search-clear").classList.add("hidden");
    renderSearch("");
  }
});

// ================= shortcuts =================
document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const typing =
    /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || "") ||
    (document.activeElement as HTMLElement)?.isContentEditable === true;
  if (mod && e.key.toLowerCase() === "k") {
    e.preventDefault();
    setView("search");
    setTimeout(() => $("#search-input").focus(), 30);
  } else if (mod && e.key === ",") {
    e.preventDefault();
    setView("settings");
  } else if (mod && e.key.toLowerCase() === "s" && state.view === "settings") {
    e.preventDefault();
    const btn = $("#btn-save-settings") as HTMLButtonElement;
    if (!btn.disabled) btn.click();
  } else if (!mod && !typing && e.key === "/") {
    e.preventDefault();
    setView("search");
    setTimeout(() => $("#search-input").focus(), 30);
  } else if (!mod && !typing && /^[1-7]$/.test(e.key)) {
    const order = ["status", "download", "search", "collection", "settings", "developer", "about"];
    setView(order[Number(e.key) - 1]);
  } else if (e.key === "Escape") {
    $$(".modal").forEach((m) => m.classList.add("hidden"));
  }
});

// ================= boot =================
function renderAll(): void {
  renderSidebarState();
  renderAccount();
  renderTools();
  renderSync();
  renderQueue();
  renderHistory();
  renderCollection();
  renderTplChips();
  renderTplPreview();
  renderDev();
  renderSearch(($("#search-input") as HTMLInputElement).value);
  refreshDirty();
}

async function checkAppUpdateBackground(): Promise<void> {
  if (!isApp) return;
  try {
    const r = await api.request.checkAppUpdate({});
    if (r.updateAvailable) {
      $("#update-version").textContent = "v" + (r.version || "");
      openModal("update");
    }
  } catch {
    // sin red
  }
}

function seedSettings(c: ConfigPayload): void {
  ($("#set-folder") as HTMLInputElement).value = c.outdir || "";
  ($("#set-format") as HTMLSelectElement).value = c.format || "m4a";
  renderBitrates();
  const bitrate = c.bitrate || c.quality;
  if (bitrate) ($("#set-bitrate") as HTMLSelectElement).value = bitrate;
  ($("#set-theme") as HTMLSelectElement).value = c.theme || "light";
  applyTheme(c.theme || "light");
  const lang = resolveLang(c.lang);
  ($("#set-lang") as HTMLSelectElement).value = lang;
  currentLang = lang;
  document.documentElement.lang = lang;
  $("#tpl-editor").textContent = c.filenameTemplate || "%(title)s - %(artist)s";
  ($("#set-skip") as HTMLInputElement).checked = c.skipExisting ?? true;
  renderTplPreview();
  renderTplChips();
  markClean();
}

async function boot(): Promise<void> {
  applyStaticTranslations();
  renderTplChips();
  const s = await loadStatus();
  if (s) {
    seedSettings(s.config);
    if (!s.deps.ready) {
      // se abre el modal de deps automáticamente
      setTimeout(() => {
        if (!state.deps.ytdlp?.ok || !state.deps.ffmpeg?.ok) openModal("deps");
      }, 600);
    }
    await loadLikes();
    await refreshSync();
    await refreshDownloaded();
    await loadHistory();
    if (state.loggedIn) loadPlaylists();
  }
  renderAll();
  checkAppUpdateBackground();
}

boot();
