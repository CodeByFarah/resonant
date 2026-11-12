// App core: API client, router, shell, global player, modals, audio utilities.
import { pages } from "./pages.js";

// ---------- tiny templating ----------
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(s);
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => {
    const part = Array.isArray(v) ? v.map((x) => (x instanceof Raw ? x.s : esc(x))).join("") : v instanceof Raw ? v.s : v === false || v == null ? "" : esc(v);
    out += part + strings[i + 1];
  });
  return raw(out);
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- icons (Lucide-style strokes) ----------
const P = {
  dialogue: '<path d="M14 9a2 2 0 0 1-2 2H6l-3 3V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2z"/><path d="M18 9h1a2 2 0 0 1 2 2v9l-3-3h-6a2 2 0 0 1-2-2v-1"/>',
  pron: '<path d="M4 18 8.5 6 13 18M5.6 14h5.8"/><path d="M16 9a5 5 0 0 1 0 6M19 6.5a9 9 0 0 1 0 11"/>',
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  tts: '<path d="M4 7V5h16v2"/><path d="M12 5v14"/><path d="M9 19h6"/>',
  sts: '<path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><path d="M12 18v4"/>',
  sfx: '<path d="M2 12h2l3-8 4 16 3-10 2 4h6"/>',
  stt: '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/><path d="M9 13h6M9 17h4"/>',
  iso: '<circle cx="12" cy="12" r="9"/><path d="M8 12h1l1.5-3 3 6L15 12h1"/>',
  voices: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M19 8v6M22 11h-6"/>',
  library: '<path d="M4 19.5V4.5A1.5 1.5 0 0 1 5.5 3H20v16H5.5A1.5 1.5 0 0 0 4 20.5 1.5 1.5 0 0 0 5.5 22H20"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  upload: '<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  thumbUp: '<path d="M7 10v11"/><path d="M15 5.9 14 10h5.8a2 2 0 0 1 1.9 2.6l-2.3 7A2 2 0 0 1 17.5 21H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h2.8a2 2 0 0 0 1.8-1.1L12 2a3.1 3.1 0 0 1 3 3.9z"/>',
  thumbDown: '<path d="M17 14V3"/><path d="M9 18.1 10 14H4.2a2 2 0 0 1-1.9-2.6l2.3-7A2 2 0 0 1 6.5 3H20a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-2.8a2 2 0 0 0-1.8 1.1L12 22a3.1 3.1 0 0 1-3-3.9z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  dice: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.2" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
  wave: '<path d="M2 13h2M6 9v8M10 5v14M14 8v8M18 11v4M22 13h-2"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  code: '<path d="m8 9-4 3 4 3M16 9l4 3-4 3"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  chevronL: '<path d="m15 6-6 6 6 6"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowR: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  clone: '<circle cx="9" cy="10" r="4"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M17 8v6M14 11h6"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  sort: '<path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14a4 4 0 0 0 8 0M9 9h.01M15 9h.01"/>',
  megaphone: '<path d="M3 11v2a1 1 0 0 0 1 1h3l6 4V6L7 10H4a1 1 0 0 0-1 1z"/><path d="M17 9a4 4 0 0 1 0 6"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M17 9h4M3 15h4M17 15h4"/>',
  news: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h6M7 13h10M7 16h10"/>',
};
export const icon = (name, cls = "") => raw(`<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ""}</svg>`);

// ---------- API ----------
export class ApiError extends Error {}
export async function api(path, { method = "GET", body, json, raw: wantRaw = false, signal } = {}) {
  const init = { method, headers: {}, signal };
  if (json !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(json); }
  else if (body) init.body = body;
  const res = await fetch(path, init);
  if (res.status === 401) { showLogin(); throw new ApiError("Sign in required"); }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); msg = j.detail?.message || msg; } catch {}
    throw new ApiError(msg);
  }
  if (wantRaw) return res;
  return res.json();
}

// ---------- shared state ----------
export const store = {
  voices: null, settings: null, models: null, health: null,
  async loadVoices(force) { if (!this.voices || force) this.voices = (await api("/v2/voices?page_size=500")).voices; return this.voices; },
  async loadSettings(force) { if (!this.settings || force) this.settings = await api("/api/settings"); return this.settings; },
  async loadModels(force) { if (!this.models || force) this.models = await api("/v1/models"); return this.models; },
  voice(id) { return this.voices?.find((v) => v.voice_id === id); },
};

// ---------- formatting ----------
export const fmtTime = (s) => { if (!isFinite(s)) return "0:00"; s = Math.max(0, s); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`; };
export function fmtAgo(unix) {
  const d = Date.now() / 1000 - unix;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 604800) return `${Math.floor(d / 86400)}d ago`;
  return new Date(unix * 1000).toLocaleDateString();
}
export const fmtNum = (n) => Number(n || 0).toLocaleString();

// Deterministic gradient avatar from a voice id.
export function orb(id, size = "") {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const a = h % 360, b = (a + 40 + ((h >> 8) % 80)) % 360, c = (a + 180 + ((h >> 16) % 60)) % 360;
  return html`<span class="orb ${size}" style="background: radial-gradient(circle at 70% 80%, hsl(${c} 85% 60%), transparent 60%), linear-gradient(135deg, hsl(${a} 80% 62%), hsl(${b} 80% 55%))"></span>`;
}

// ---------- toasts ----------
export function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), kind === "error" ? 6000 : 3000);
}
export const toastError = (e) => toast(e?.message || String(e), "error");

// ---------- modal ----------
export function modal({ title, body, foot = "", wide = false, onMount, onClose }) {
  const el = document.createElement("div");
  el.className = "modal-backdrop";
  el.innerHTML = String(html`<div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-label="${title}">
    <div class="modal-head"><h2 class="h2">${title}</h2><button class="icon-btn" data-close aria-label="Close">${icon("x")}</button></div>
    <div class="modal-body">${body}</div>${foot ? html`<div class="modal-foot">${foot}</div>` : ""}</div>`);
  const prev = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.remove();
    document.removeEventListener("keydown", onKey);
    prev?.focus?.();
    onClose?.();
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  el.addEventListener("mousedown", (e) => { if (e.target === el) close(); });
  el.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) close(); });
  document.addEventListener("keydown", onKey);
  $("#modal-root").append(el);
  onMount?.(el.querySelector(".modal"), close);
  (el.querySelector("[autofocus]") || el.querySelector(".modal-body input, .modal-body button"))?.focus();
  return close;
}
export function confirmDialog(title, text, okLabel = "Delete") {
  return new Promise((resolve) => {
    let ok = false;
    modal({
      title,
      body: html`<p class="muted" style="margin:0">${text}</p>`,
      foot: html`<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-ok>${okLabel}</button>`,
      onMount: (m, close) => { m.querySelector("[data-ok]").onclick = () => { ok = true; close(); }; },
      onClose: () => resolve(ok),
    });
  });
}

// ---------- voice picker ----------
export function providerBadge(v) {
  if (v?.provider === "elevenlabs") return html`<span class="badge accent">ElevenLabs</span>`;
  if (["cloned", "generated"].includes(v?.category)) return html`<span class="badge green">${v.labels?.designed ? "Designed" : "Your clone"}</span>`;
  if (v?.provider === "qwen") return html`<span class="badge accent">Qwen3</span>`;
  return v ? html`<span class="badge">Kokoro</span>` : "";
}
export async function pickVoice(currentId, { filter } = {}) {
  const voices = (await store.loadVoices()).filter(filter || (() => true));
  return new Promise((resolve) => {
    let chosen = null;
    let q = "";
    let tab = "all";
    const rows = () => {
      const list = voices
        .filter((v) => tab === "all" || (tab === "mine" ? v.in_my_voices : v.is_favorite))
        .filter((v) => !q || `${v.name} ${v.description} ${Object.values(v.labels || {}).join(" ")}`.toLowerCase().includes(q));
      if (!list.length) return html`<div class="empty">No voices match.</div>`;
      return html`${list.map((v) => html`<button class="vp-row ${v.voice_id === currentId ? "sel" : ""}" data-id="${v.voice_id}">
        <span class="play-orb" data-preview="${v.voice_id}" title="Preview">${orb(v.voice_id)}<span class="ov">${icon("play")}</span></span>
        <span class="grow"><div class="h3">${v.name}</div><div class="small subtle">${v.description || ""}</div></span>
        ${providerBadge(v)}
        ${v.voice_id === currentId ? icon("check") : ""}</button>`)}`;
    };
    modal({
      title: "Select a voice",
      body: html`<div class="search">${icon("search")}<input class="input" placeholder="Search voices…" data-q autofocus></div>
        <div><div class="seg"><button class="active" data-tab="all">All</button><button data-tab="mine">My voices</button><button data-tab="fav">Favorites</button></div></div>
        <div class="vp-list" data-list>${rows()}</div>`,
      onMount: (m, close) => {
        const list = m.querySelector("[data-list]");
        const render = () => { list.innerHTML = String(rows()); };
        m.querySelector("[data-q]").oninput = (e) => { q = e.target.value.toLowerCase(); render(); };
        m.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => { tab = b.dataset.tab; m.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("active", x === b)); render(); });
        list.addEventListener("click", (e) => {
          const pv = e.target.closest("[data-preview]");
          if (pv) { e.stopPropagation(); previewVoice(pv.dataset.preview, pv); return; }
          const row = e.target.closest("[data-id]");
          if (row) { chosen = row.dataset.id; close(); }
        });
      },
      onClose: () => { stopPreview(); resolve(chosen); },
    });
  });
}

// Lightweight preview player separate from the main player.
const previewAudio = new Audio();
let previewBtn = null;
export function stopPreview() {
  previewAudio.pause();
  const ov = previewBtn?.querySelector(".ov");
  if (ov) ov.innerHTML = String(icon("play"));
  previewBtn?.classList.remove("playing");
  previewBtn = null;
}
export function previewVoice(id, btn) {
  if (previewBtn === btn) return stopPreview();
  stopPreview();
  previewBtn = btn;
  btn?.classList.add("playing");
  const ov = btn?.querySelector(".ov");
  if (ov) ov.innerHTML = '<span class="spinner"></span>';
  previewAudio.src = `/v1/voices/${encodeURIComponent(id)}/preview`;
  previewAudio.play().then(() => { if (ov && previewBtn === btn) ov.innerHTML = String(icon("pause")); }).catch((e) => { if (e.name !== "AbortError") toast("Couldn't load the preview.", "error"); stopPreview(); });
}
previewAudio.onended = stopPreview;

// ---------- global player ----------
export const player = (() => {
  const audio = new Audio();
  let peaks = null;
  let item = null;
  let live = false;
  const el = $("#player");
  el.innerHTML = String(html`
    <div class="info"><span data-orb></span><div><div class="t" data-title></div><div class="s" data-sub></div></div></div>
    <button class="play" data-play aria-label="Play or pause">${icon("play")}</button>
    <span class="time" data-time>0:00 / 0:00</span>
    <canvas class="wave" data-wave aria-label="Seek"></canvas>
    <a class="icon-btn" data-dl title="Download" aria-label="Download">${icon("download")}</a>
    <button class="icon-btn" data-close title="Close player" aria-label="Close player">${icon("x")}</button>`);
  const canvas = $("[data-wave]", el);
  const playBtn = $("[data-play]", el);
  const draw = () => {
    const dpr = devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w) return;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const styles = getComputedStyle(document.documentElement);
    const fg = styles.getPropertyValue("--fg").trim(), muted = styles.getPropertyValue("--border-strong").trim();
    const bars = Math.floor(w / 3);
    const prog = length() ? audio.currentTime / length() : 0;
    for (let i = 0; i < bars; i++) {
      const v = peaks ? peaks[Math.floor((i / bars) * peaks.length)] : 0.12;
      const bh = Math.max(2, v * (h - 4));
      ctx.fillStyle = i / bars < prog ? fg : muted;
      ctx.fillRect(i * 3, (h - bh) / 2, 2, bh);
    }
  };
  // While audio is still streaming in, its length is what has arrived so far.
  const length = () => (live ? (audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) : 0) : audio.duration);
  const tick = () => {
    $("[data-time]", el).textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(length())}${live ? "…" : ""}`;
    draw();
    document.dispatchEvent(new CustomEvent("player:time", { detail: { t: audio.currentTime, item } }));
  };
  let rafId;
  const loop = () => { cancelAnimationFrame(rafId); if (!audio.paused) { tick(); rafId = requestAnimationFrame(loop); } };
  audio.ontimeupdate = tick;
  audio.onloadedmetadata = tick;
  audio.onplay = () => { playBtn.innerHTML = String(icon("pause")); loop(); };
  audio.onpause = audio.onended = () => { playBtn.innerHTML = String(icon("play")); tick(); };
  playBtn.onclick = () => (audio.paused ? audio.play() : audio.pause());
  canvas.onclick = (e) => { if (length()) { audio.currentTime = (e.offsetX / canvas.clientWidth) * length(); tick(); } };
  audio.onprogress = audio.onwaiting = audio.onplaying = () => { if (live) tick(); };
  $("[data-close]", el).onclick = () => { audio.pause(); el.hidden = true; document.body.classList.remove("has-player"); };
  window.addEventListener("resize", draw);
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !el.hidden && !e.target.closest("input,textarea,select,button,a,[contenteditable]")) { e.preventDefault(); playBtn.click(); }
  });

  async function computePeaks(src) {
    try {
      const buf = await (src instanceof Blob ? src : await (await fetch(src)).blob()).arrayBuffer();
      const ctx = new OfflineAudioContext(1, 1, 44100);
      const decoded = await ctx.decodeAudioData(buf);
      const data = decoded.getChannelData(0);
      const n = 400, step = Math.max(1, Math.floor(data.length / n));
      const out = new Float32Array(n);
      let max = 0;
      for (let i = 0; i < n; i++) { let m = 0; for (let j = i * step; j < (i + 1) * step && j < data.length; j++) m = Math.max(m, Math.abs(data[j])); out[i] = m; max = Math.max(max, m); }
      return out.map((v) => v / (max || 1));
    } catch { return null; }
  }

  return {
    audio,
    get item() { return item; },
    // live: the url is a MediaSource still being filled; call done() once it's complete.
    async play({ url, title, subtitle, voiceId, downloadUrl, id, live: isLive = false }) {
      item = { url, title, id };
      live = isLive;
      el.hidden = false;
      document.body.classList.add("has-player");
      $("[data-title]", el).textContent = title || "Audio";
      $("[data-sub]", el).textContent = subtitle || "";
      $("[data-orb]", el).innerHTML = String(orb(voiceId || title || "x"));
      const dl = $("[data-dl]", el);
      dl.href = downloadUrl || url;
      dl.setAttribute("download", "");
      peaks = null;
      audio.src = url;
      draw();
      audio.play().catch(() => {});
      if (live) return;
      const p = await computePeaks(url);
      if (item?.url === url) { peaks = p; draw(); }
    },
    async done(url, { blob, downloadUrl, id } = {}) {
      if (item?.url !== url) return;
      live = false;
      if (id) item.id = id;
      if (downloadUrl) $("[data-dl]", el).href = downloadUrl;
      tick();
      const p = blob ? await computePeaks(blob) : null;
      if (item?.url === url) { peaks = p; draw(); }
    },
    seek(t) {
      const go = () => { audio.currentTime = t; if (audio.paused) audio.play(); };
      if (audio.readyState >= 1) go(); else audio.addEventListener("loadedmetadata", go, { once: true });
    },
  };
})();

export function playHistory(h) {
  const title = h.source === "SFX" ? h.text : h.voice_name || h.source;
  const sub = h.source === "SFX" ? "Sound effect" : h.text || "";
  player.play({ url: `/v1/history/${h.history_item_id}/audio`, downloadUrl: `/v1/history/${h.history_item_id}/audio?download=1`, title, subtitle: sub, voiceId: h.voice_id || h.history_item_id, id: h.history_item_id });
}

// ---------- browser audio utilities ----------
// Converts any browser-decodable audio/video file to a mono 16-bit WAV.
export async function toWav(fileOrBlob, rate = 16000) {
  const buf = await fileOrBlob.arrayBuffer();
  const tmp = new AudioContext();
  let decoded;
  try { decoded = await tmp.decodeAudioData(buf.slice(0)); } catch { throw new Error("Your browser couldn't decode the audio in this file."); } finally { tmp.close(); }
  const len = Math.ceil(decoded.duration * rate);
  const off = new OfflineAudioContext(1, len, rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const out = (await off.startRendering()).getChannelData(0);
  const view = new DataView(new ArrayBuffer(44 + out.length * 2));
  const w = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); view.setUint32(4, 36 + out.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); w(36, "data"); view.setUint32(40, out.length * 2, true);
  for (let i = 0; i < out.length; i++) { const s = Math.max(-1, Math.min(1, out[i])); view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return { blob: new Blob([view], { type: "audio/wav" }), duration: decoded.duration };
}

export async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Recording isn't supported in this browser.");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const rec = new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start();
  const started = Date.now();
  return {
    started,
    stop: () => new Promise((resolve) => {
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
        resolve(new File([new Blob(chunks, { type: rec.mimeType })], `recording-${stamp}.webm`, { type: rec.mimeType }));
      };
      rec.stop();
    }),
  };
}

// Shared upload/record widget used by STT, voice changer and isolator.
export function audioInput(container, { onChange, record = true, accept = "audio/*,video/*" }) {
  let file = null;
  let rec = null;
  let timer = null;
  const render = () => {
    clearInterval(timer);
    if (rec) {
      container.innerHTML = String(html`<div class="file-pill"><span class="rec-dot"></span><span class="grow">Recording… <span data-t>0:00</span></span><button class="btn btn-sm" data-stop>${icon("stop")} Stop</button></div>`);
      $("[data-stop]", container).onclick = async () => { const f = await rec.stop(); rec = null; set(f); };
      timer = setInterval(() => { const t = $("[data-t]", container); if (t && rec) t.textContent = fmtTime((Date.now() - rec.started) / 1000); }, 250);
      return;
    }
    if (file) {
      container.innerHTML = String(html`<div class="file-pill">${icon("wave")}<span class="grow"><div class="h3" style="overflow:hidden;text-overflow:ellipsis">${file.name}</div><div class="small subtle">${(file.size / 1024 / 1024).toFixed(2)} MB</div></span>
        <button class="icon-btn" data-play title="Play" aria-label="Play input">${icon("play")}</button><button class="icon-btn" data-clear title="Remove" aria-label="Remove file">${icon("x")}</button></div>`);
      $("[data-clear]", container).onclick = () => set(null);
      $("[data-play]", container).onclick = () => player.play({ url: URL.createObjectURL(file), title: file.name, subtitle: "Input audio" });
      return;
    }
    container.innerHTML = String(html`<div class="up-card" data-drop role="button" tabindex="0" aria-label="Upload audio">
      <span class="ib">${icon("upload")}</span><div class="t">Click to upload, or drag and drop</div>
      <div class="s">Audio or video files up to 50 MB each</div>
      ${record ? html`<span class="or-pill">or</span><button type="button" class="btn" data-rec>${icon("mic")} Record audio</button>` : ""}
      <input type="file" accept="${accept}" hidden data-file></div>`);
    const drop = $("[data-drop]", container);
    const fileInput = $("[data-file]", container);
    drop.onclick = (e) => { if (!e.target.closest("[data-rec]")) fileInput.click(); };
    drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } };
    fileInput.onchange = (e) => e.target.files[0] && set(e.target.files[0]);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); const f = e.dataTransfer.files[0]; if (f) set(f); };
    const r = $("[data-rec]", container);
    if (r) r.onclick = async () => { try { rec = await startRecording(); render(); } catch (e) { toastError(e); } };
  };
  const set = (f) => {
    if (f && f.size > 50 * 1024 * 1024) { toast("That file is larger than 50 MB.", "error"); return; }
    file = f;
    render();
    onChange?.(file);
  };
  render();
  return { get file() { return file; }, clear: () => set(null), destroy: () => { clearInterval(timer); rec?.stop(); } };
}

export function rangeFill(input) {
  const upd = () => input.style.setProperty("--p", `${((input.value - input.min) / (input.max - input.min)) * 100}%`);
  input.addEventListener("input", upd);
  upd();
}

export function download(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "";
  document.body.append(a);
  a.click();
  a.remove();
}

// ---------- shell ----------
export const NAV = [
  { path: "/app/home", label: "Home", icon: "home" },
  { path: "/app/voice-library", label: "Voices", icon: "grid", also: ["/app/voice-lab"] },
  { path: "/app/history", label: "History", icon: "history" },
  { label: "Tools" },
  { path: "/app/speech-synthesis/text-to-speech", label: "Text to Speech", icon: "wave" },
  { path: "/app/dialogue", label: "Dialogue", icon: "dialogue" },
  { path: "/app/studio", label: "Studio", icon: "book" },
  { path: "/app/dubbing", label: "Dubbing", icon: "film" },
  { path: "/app/voice-changer", label: "Voice Changer", icon: "sts" },
  { path: "/app/voice-design", label: "Voice Design", icon: "sparkle" },
  { path: "/app/sound-effects", label: "Sound Effects", icon: "sfx" },
  { path: "/app/speech-to-text", label: "Speech to Text", icon: "stt" },
  { path: "/app/voice-isolator", label: "Voice Isolator", icon: "iso" },
  { path: "/app/voice-lab", label: "Voice Cloning", icon: "clone", exact: true },
  { path: "/app/pronunciation", label: "Pronunciation", icon: "pron" },
];

function renderSidebar() {
  $("#sidebar").innerHTML = String(html`
    <a class="brand" href="/app/home" data-link><img class="brand-mark" src="/favicon.svg" alt="">Resonant</a>
    <nav class="nav">${NAV.map((n) => n.path
      ? html`<a href="${n.path}" data-link data-nav="${n.path}" ${n.exact ? raw("data-exact") : ""}>${icon(n.icon)}<span>${n.label}</span></a>`
      : html`<div class="nav-label">${n.label}</div>`)}</nav>
    <div class="sidebar-foot">
      <div class="usage-card" data-usage><div class="row"><span>Characters this month</span></div><div class="skeleton" style="height:14px;margin-top:6px"></div></div>
      <div class="model-status" data-models></div>
      <a class="foot-link" href="/app/settings#api" data-link>${icon("code")} Developers</a>
      <a class="foot-link" href="/app/settings" data-link data-nav="/app/settings">${icon("settings")} Settings</a>
      <button class="foot-link" data-theme-toggle></button>
    </div>`);
  $("[data-theme-toggle]", $("#sidebar")).onclick = cycleTheme;
  updateThemeLabel();
  markActive();
  refreshUsage();
  pollHealth();
}

export async function refreshUsage() {
  const el = $("[data-usage]");
  if (!el) return;
  try {
    const sub = await api("/v1/user/subscription");
    const pct = sub.character_limit ? Math.min(100, (sub.character_count / sub.character_limit) * 100) : 0;
    el.innerHTML = String(html`<div class="row"><span>Characters this month</span></div>
      <div style="font-weight:600;font-size:14px;margin-top:2px">${fmtNum(sub.character_count)}${sub.character_limit ? html` <span class="subtle" style="font-weight:400">/ ${fmtNum(sub.character_limit)}</span>` : ""}</div>
      ${sub.character_limit ? html`<div class="meter"><i style="width:${pct}%"></i></div>` : html`<div class="small subtle">No limit · <a href="/app/settings#usage" data-link style="text-decoration:underline">set one</a></div>`}
      <div class="small subtle" style="margin-top:6px">Resets ${new Date(sub.next_character_count_reset_unix * 1000).toLocaleDateString()}</div>`);
  } catch {}
}

let healthTimer;
async function pollHealth() {
  clearTimeout(healthTimer);
  try {
    const h = await api("/api/health");
    store.health = h;
    const label = { ready: "ready", loading: "loading…", idle: "loads on first use", error: "failed to load" };
    const el = $("[data-models]");
    if (el) el.innerHTML = String(html`<span class="dot ${h.models.tts}"></span><span title="Speech: ${label[h.models.tts]} · Transcription: ${label[h.models.stt]} · Sound: ${label[h.models.sfx]}">Speech engine ${label[h.models.tts]}</span>`);
    healthTimer = setTimeout(pollHealth, Object.values(h.models).includes("loading") ? 2000 : 15000);
  } catch { healthTimer = setTimeout(pollHealth, 5000); }
}

const THEMES = ["light", "dark"];
// Light unless the user picked dark; the OS setting is deliberately ignored.
const getTheme = () => { try { return localStorage.getItem("theme") === "dark" ? "dark" : "light"; } catch { return "light"; } };
function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(getTheme()) + 1) % THEMES.length];
  try { localStorage.setItem("theme", next); } catch {}
  if (next === "dark") document.documentElement.dataset.theme = "dark"; else delete document.documentElement.dataset.theme;
  updateThemeLabel();
  document.dispatchEvent(new Event("theme"));
}
function updateThemeLabel() {
  const cur = getTheme();
  const b = $("[data-theme-toggle]");
  if (b) b.innerHTML = String(html`${icon(cur === "light" ? "sun" : cur === "dark" ? "moon" : "monitor")} Theme: ${cur[0].toUpperCase() + cur.slice(1)}`);
}

function markActive() {
  const p = location.pathname;
  $$("[data-nav]").forEach((a) => {
    const n = a.dataset.nav;
    const extra = NAV.find((x) => x.path === n)?.also || [];
    const on = a.hasAttribute("data-exact") ? p === n : [n, ...extra].some((x) => p === x || p.startsWith(x + "/"));
    a.classList.toggle("active", on);
  });
  // "Voices" stays highlighted on the cloning page only when reached from the Voices tabs.
  if (p === "/app/voice-lab") $(`[data-nav="/app/voice-library"]`)?.classList.remove("active");
}

// crumbs: [title] or [[label, href], ..., title]
export function setTopbar(title, crumbs) {
  const parts = crumbs || [title];
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  $("#topbar").innerHTML = String(html`
    <button class="icon-btn" data-menu aria-label="Toggle sidebar" title="Toggle sidebar">${icon("panel")}</button>
    <div class="crumbs">${parts.map((c, i) => html`${i ? html`<span class="sep">${icon("chevron")}</span>` : ""}${Array.isArray(c) ? html`<a href="${c[1]}" data-link>${c[0]}</a>` : html`<span class="cur">${c}</span>`}`)}</div>
    <button class="search-btn" data-search>${icon("search")}<span class="grow">Search everything...</span><span class="kbd">${mac ? "⌘" : "Ctrl"}</span><span class="kbd">K</span></button>
    <div class="tb-right">
      <a class="btn hide-sm" href="/app/settings#api" data-link>API</a>
      <a class="btn hide-sm" href="/app/history" data-link>${icon("history")} History</a>
      <button class="icon-btn outline" data-theme-top title="Switch theme" aria-label="Switch theme">${icon(getTheme() === "dark" ? "moon" : "sun")}</button>
      <a href="/app/settings#profile" data-link title="Profile" aria-label="Profile" class="avatar-btn">${avatarInitial()}</a>
    </div>`);
  $$(".crumbs svg", $("#topbar")).forEach((s) => s.setAttribute("style", "width:14px;height:14px"));
  $("[data-menu]").onclick = () => {
    if (matchMedia("(max-width: 820px)").matches) return document.body.classList.toggle("nav-open");
    document.body.classList.toggle("nav-collapsed");
    try { localStorage.setItem("nav_collapsed", document.body.classList.contains("nav-collapsed") ? "1" : ""); } catch {}
  };
  $("[data-search]").onclick = openPalette;
  $("[data-theme-top]").onclick = () => { cycleTheme(); setTopbar(title, crumbs); };
}
function avatarInitial() {
  const name = store.settings?.display_name || "R";
  return html`<span class="avatar-circle">${name.trim()[0].toUpperCase()}</span>`;
}

// ---------- command palette (Ctrl/⌘+K) ----------
function openPalette() {
  if ($(".palette")) return;
  const items = [
    ...NAV.filter((n) => n.path).map((n) => ({ label: n.label, hint: "Go to", href: n.path, icon: n.icon })),
    { label: "Settings", hint: "Go to", href: "/app/settings", icon: "settings" },
    ...(store.voices || []).map((v) => ({ label: v.name, hint: "Use voice", href: `/app/speech-synthesis/text-to-speech?voice=${encodeURIComponent(v.voice_id)}`, orb: v.voice_id })),
  ];
  let sel = 0;
  modal({
    title: "Search",
    body: html`<div class="search">${icon("search")}<input class="input" data-q placeholder="Pages, tools and voices…" autofocus aria-label="Search"></div><div class="vp-list" data-list></div>`,
    onMount: (m, close) => {
      m.classList.add("palette");
      const list = $("[data-list]", m);
      let shown = items;
      const render = () => {
        list.innerHTML = shown.length ? String(html`${shown.slice(0, 40).map((it, i) => html`<button class="vp-row ${i === sel ? "sel" : ""}" data-i="${i}">${it.orb ? orb(it.orb, "sm") : icon(it.icon)}<span class="grow">${it.label}</span><span class="small subtle">${it.hint}</span></button>`)}`) : String(html`<div class="empty small">No results</div>`);
        list.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
      };
      const go = (it) => { if (it) { close(); navigate(it.href); } };
      $("[data-q]", m).oninput = (e) => { const q = e.target.value.toLowerCase(); shown = items.filter((it) => it.label.toLowerCase().includes(q)); sel = 0; render(); };
      $("[data-q]", m).onkeydown = (e) => {
        if (e.key === "ArrowDown") { sel = Math.min(sel + 1, shown.length - 1); render(); e.preventDefault(); }
        if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); render(); e.preventDefault(); }
        if (e.key === "Enter") go(shown[sel]);
      };
      list.onclick = (e) => { const b = e.target.closest("[data-i]"); if (b) go(shown[b.dataset.i]); };
      render();
      if (!store.voices) store.loadVoices().then(() => { items.push(...store.voices.map((v) => ({ label: v.name, hint: "Use voice", href: `/app/speech-synthesis/text-to-speech?voice=${encodeURIComponent(v.voice_id)}`, orb: v.voice_id }))); render(); });
    },
  });
}
document.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); } });
try { if (localStorage.getItem("nav_collapsed")) document.body.classList.add("nav-collapsed"); } catch {}

// ---------- router ----------
let cleanup = null;
export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, "", path); else history.pushState({}, "", path);
  route();
}
async function route() {
  document.body.classList.remove("nav-open");
  stopPreview();
  if (["/", "/app", "/app/"].includes(location.pathname)) return navigate("/app/home", { replace: true });
  const page = pages.find((p) => p.match?.test(location.pathname)) || pages.find((p) => p.notFound);
  markActive();
  try { cleanup?.(); } catch {}
  cleanup = null;
  const el = $("#page");
  el.innerHTML = "";
  el.scrollTop = 0;
  el.style.animation = "none"; void el.offsetWidth; el.style.animation = "";
  document.title = `${page.title} | Resonant`;
  setTopbar(page.title, page.crumbs);
  try {
    cleanup = await page.render(el, { params: location.pathname.match(page.match || /$^/)?.slice(1) || [], query: new URLSearchParams(location.search) });
  } catch (e) {
    el.innerHTML = String(html`<div class="page-inner"><div class="notice warn">${icon("info")}<div><b>Something went wrong.</b><br>${e.message}</div></div></div>`);
    console.error(e);
  }
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target) return;
  e.preventDefault();
  const url = new URL(a.href);
  if (url.pathname === location.pathname && url.hash) {
    history.replaceState({}, "", url.pathname + url.hash);
    document.getElementById(url.hash.slice(1))?.scrollIntoView({ behavior: "smooth" });
    return;
  }
  navigate(url.pathname + url.search + url.hash);
});
window.addEventListener("popstate", route);
$("#scrim").onclick = () => document.body.classList.remove("nav-open");

// ---------- auth gate ----------
function showLogin() {
  if ($("#login")) return;
  document.body.innerHTML = String(html`<div class="center-screen" id="login"><form class="card card-pad stack" style="width:min(380px,100%)">
    <div class="row"><img src="/favicon.svg" width="28" alt=""><b style="font-size:17px">Resonant</b></div>
    <h1 class="h2">Enter access key</h1><p class="muted small" style="margin:0">This server requires the key set in RESONANT_API_KEY.</p>
    <input class="input" type="password" name="key" placeholder="Access key" autofocus required autocomplete="current-password">
    <button class="btn btn-primary">Continue</button><div class="small" style="color:var(--danger)" data-err></div></form></div>`);
  $("#login form").onsubmit = async (e) => {
    e.preventDefault();
    const r = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: e.target.key.value }) });
    if (r.ok) location.reload(); else $("[data-err]").textContent = "That key isn't valid.";
  };
}

// ---------- boot ----------
export async function refreshShell() {
  await store.loadSettings(true);
  renderSidebar();
}
(async () => {
  const s = await (await fetch("/api/session")).json();
  if (s.auth_required && !s.authorized) return showLogin();
  const settings = await store.loadSettings().catch(() => null);
  renderSidebar();
  route();
  // First run: show what this computer can handle, once.
  if (settings && !settings.system_check_seen) import("./system.js").then((m) => m.showSystemCheck());
})();
