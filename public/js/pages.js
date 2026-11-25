// Page modules. Each render(el) returns an optional cleanup function.
import {
  html, raw, $, $$, icon, api, store, orb, toast, toastError, modal, confirmDialog, pickVoice, previewVoice, providerBadge, startRecording,
  player, playHistory, toWav, audioInput, rangeFill, download, fmtTime, fmtAgo, fmtNum, navigate,
  refreshUsage, refreshShell, setTopbar,
} from "./app.js";
import { voiceChanger, voiceDesign, soundEffects, speechToText, voiceIsolator, historyPage } from "./tools.js";
import { studioList, studioProject } from "./studio.js";
import { dialoguePage, pronunciationPage } from "./dialogue.js";
import { dubbingList, dubbingEditor } from "./dubbing.js";
import { MODELS as CREDIT_MODELS, LIBRARIES as CREDIT_LIBRARIES, LICENSE_URLS } from "./credits.js";
import { renderSystem } from "./system.js";

// Settings → Connect AI apps: ready-to-paste MCP setup for this install (paths come from the server).
async function renderMcp(box) {
  try {
    const c = await api("/api/mcp-config");
    const entry = { command: c.command, args: c.args, ...(Object.keys(c.env).length ? { env: c.env } : {}) };
    const desktopJson = JSON.stringify({ mcpServers: { resonant: entry } }, null, 2);
    const q = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
    const claudeCode = ["claude mcp add resonant", ...Object.entries(c.env).map(([k, v]) => `-e ${k}=${q(v)}`), "--", q(c.command), ...c.args.map(q)].join(" ");
    const configPath = c.platform === "win32" ? "%APPDATA%\\Claude\\claude_desktop_config.json" : c.platform === "darwin" ? "~/Library/Application Support/Claude/claude_desktop_config.json" : "~/.config/Claude/claude_desktop_config.json";
    box.innerHTML = String(html`
      <h3 class="h3 mt">Claude Desktop</h3>
      <p class="small subtle">In Claude, open Settings → Developer → Edit Config, add this to <span class="mono">${configPath}</span> (merge it with any servers already there), save, and restart Claude.</p>
      <div class="code" data-mcp-json>${desktopJson}</div>
      <div class="row wrap mt"><button class="btn btn-sm" data-copy="mcp-json">${icon("copy")} Copy</button></div>
      <h3 class="h3 mt">Claude Code</h3>
      <p class="small subtle">Run this once in a terminal.</p>
      <div class="code" data-mcp-cli>${claudeCode}</div>
      <div class="row wrap mt"><button class="btn btn-sm" data-copy="mcp-cli">${icon("copy")} Copy</button></div>
      <h3 class="h3 mt">Cursor and other apps</h3>
      <p class="small subtle">Add the same <span class="mono">resonant</span> entry to the app's MCP settings (in Cursor: Settings → MCP). Audio they make is saved to <span class="mono">${c.output_dir}</span>.</p>
      <p class="small subtle">Try asking: "Read this paragraph aloud in George's voice", "Turn these notes into a two-person podcast", or "Transcribe interview.mp3 and label the speakers".</p>`);
    for (const b of box.querySelectorAll("[data-copy]")) b.onclick = async () => {
      try { await navigator.clipboard.writeText($(`[data-${b.dataset.copy}]`, box).textContent); toast("Copied"); } catch { toast("Couldn't access the clipboard.", "error"); }
    };
  } catch (e) {
    box.innerHTML = String(html`<p class="small" style="color:var(--danger)">Couldn't load the setup: ${e.message}</p>`);
  }
}

// Title case, so multi-word labels read "New York", "South African".
export const cap = (s) => (s ? s.replace(/(^|[\s(-])(\p{L})/gu, (m, sep, c) => sep + c.toUpperCase()) : "");
// "Heart - Female, American", the way voices are named in pickers.
export const voiceLabel = (v) => {
  if (!v) return "Select a voice";
  const tags = [cap(v.labels?.gender), cap(v.labels?.native_language || v.labels?.accent)].filter((t) => t && t !== "Multilingual");
  return tags.length ? `${v.name} - ${tags.join(", ")}` : v.name;
};
export const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

export const UI_FORMATS = [
  { id: "mp3_44100_128", label: "MP3 · 44.1 kHz · 128 kbps" },
  { id: "mp3_44100_192", label: "MP3 · 44.1 kHz · 192 kbps" },
  { id: "mp3_22050_32", label: "MP3 · 22.05 kHz · 32 kbps" },
  { id: "wav_44100", label: "WAV · 44.1 kHz", localOnly: true },
  { id: "wav_24000", label: "WAV · 24 kHz", localOnly: true },
];
export const SOURCE_LABEL = { TTS: "Text to Speech", DIALOGUE: "Dialogue", STS: "Voice Changer", SFX: "Sound Effect", VOICE_ISOLATOR: "Voice Isolator" };
// Voices the user made (cloned or designed), as opposed to library voices.
export const OWN = new Set(["cloned", "generated"]);

// Inline tags: pauses work with every voice; emotions steer the Qwen3 preset voices.
export const TAG_CHIPS = ["pause 1s", "whisper", "excited", "happy", "sad", "angry", "calm", "laughs", "sighs", "shouting", "sarcastic", "normal"];
export function tagChips(voice, hint) {
  return html`<div class="field"><span class="label">Tags</span>
    <div class="chips tag-chips">${TAG_CHIPS.map((t) => html`<button type="button" class="chip" data-tag="${t}">[${t}]</button>`)}</div>
    <span class="hint">${hint || (voice?.style_instructions
      ? "Click to add at the cursor. An emotion lasts until the end of the line or the next tag; [normal] ends it."
      : "Pauses work with every voice. Emotion tags change only the Qwen3 preset voices; this voice skips them.")}</span></div>`;
}
export function insertTag(ta, tag) {
  const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? s;
  const pad = s && !/\s$/.test(ta.value.slice(0, s)) ? " " : "";
  ta.focus();
  ta.setRangeText(`${pad}[${tag}] `, s, e, "end");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

export function setLoading(btn, on, label) {
  if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = String(html`<span class="spinner"></span> ${label || "Working…"}`); }
  else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; delete btn.dataset.label; }
}
export function elapsedLabel(btn, base) {
  const start = Date.now();
  const t = setInterval(() => { if (!btn.disabled) return clearInterval(t); btn.innerHTML = String(html`<span class="spinner"></span> ${base} ${Math.floor((Date.now() - start) / 1000)}s`); }, 1000);
  return () => clearInterval(t);
}
export async function postAudio(path, opts) {
  const res = await api(path, { method: "POST", ...opts, raw: true });
  const blob = await res.blob();
  return { url: URL.createObjectURL(blob), historyId: res.headers.get("history-item-id"), transcript: res.headers.get("x-transcript"), blob };
}
// Plays speech while it's still being generated: the MP3 stream goes into the player through
// MediaSource as it arrives. Browsers without MediaSource for MP3 use postAudio instead.
export const canStream = () => typeof MediaSource !== "undefined" && MediaSource.isTypeSupported("audio/mpeg");
export async function streamAudio(path, { json, signal, title, subtitle, voiceId }) {
  const res = await api(path, { method: "POST", json, raw: true, signal });
  const historyId = res.headers.get("history-item-id");
  const reader = res.body.getReader();
  const chunks = [];
  let ms = null, sb = null, url = null, stopped = false;
  const append = (buf) => new Promise((ok, bad) => {
    if (ms.readyState !== "open") return ok(); // the player moved on to something else
    sb.addEventListener("updateend", ok, { once: true });
    sb.addEventListener("error", bad, { once: true });
    sb.appendBuffer(buf);
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      if (!ms) {
        // Open the player on the first audio, not before.
        ms = new MediaSource();
        url = URL.createObjectURL(ms);
        const open = new Promise((ok) => ms.addEventListener("sourceopen", ok, { once: true }));
        player.play({ url, title, subtitle, voiceId, id: historyId, live: true });
        await open;
        sb = ms.addSourceBuffer("audio/mpeg");
      }
      await append(value);
    }
  } catch (e) {
    if (e.name !== "AbortError") { if (ms?.readyState === "open") ms.endOfStream("network"); throw e; }
    stopped = true;
  }
  if (ms?.readyState === "open") ms.endOfStream();
  const blob = new Blob(chunks, { type: "audio/mpeg" });
  // A stopped stream isn't saved to history, so its download is the part that played.
  if (url) player.done(url, { blob, id: stopped ? null : historyId, downloadUrl: stopped ? URL.createObjectURL(blob) : `/v1/history/${historyId}/audio?download=1` });
  return { historyId: stopped ? null : historyId, blob, stopped, played: Boolean(url) };
}
// 0–1 settings read as percentages; anything else (speed) as a multiplier.
const sliderValue = (v, max) => (Number(max) <= 1 ? `${Math.round(v * 100)}%` : `${Number(v).toFixed(2)}×`);
export function slider({ key, label, min, max, step, value, left, right }) {
  return html`<div class="slider-field"><div class="top"><span class="label">${label}</span><span class="val" data-out="${key}">${sliderValue(value, max)}</span></div>
    ${left ? html`<div class="ends"><span>${left}</span><span>${right}</span></div>` : ""}
    <input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-k="${key}" aria-label="${label}"></div>`;
}
export function wireSliders(root, state, fmt) {
  fmt = fmt || ((v, k) => sliderValue(v, $(`input[data-k="${k}"]`, root).max));
  $$("input[type=range][data-k]", root).forEach((r) => {
    rangeFill(r);
    const o = $(`[data-out="${r.dataset.k}"]`, root);
    if (o) o.textContent = fmt(Number(r.value), r.dataset.k);
    r.addEventListener("input", () => { state[r.dataset.k] = Number(r.value); if (o) o.textContent = fmt(Number(r.value), r.dataset.k); });
  });
}

// History list used inside tool pages.
export async function historyList(container, { source, empty, onUse }) {
  const load = async () => {
    let data;
    try { data = await api(`/v1/history?source=${source}&page_size=30`); } catch (e) { container.innerHTML = String(html`<div class="notice">${e.message}</div>`); return; }
    if (!data.history.length) { container.innerHTML = String(html`<div class="empty">${icon("history")}<div>${empty}</div></div>`); return; }
    container.innerHTML = String(html`<div class="list">${data.history.map((h) => html`<div class="list-row" data-id="${h.history_item_id}">
      <button class="icon-btn" data-play title="Play" aria-label="Play">${icon("play")}</button>
      <div class="grow"><div class="title">${h.text || h.voice_name || SOURCE_LABEL[h.source]}</div>
        <div class="meta">${[h.voice_name, h.duration ? fmtTime(h.duration) : null, fmtAgo(h.date_unix)].filter(Boolean).join(" · ")}</div></div>
      <div class="actions">${onUse ? html`<button class="icon-btn" data-use title="Reuse text and settings" aria-label="Reuse text and settings">${icon("refresh")}</button>` : ""}
        <a class="icon-btn" href="/v1/history/${h.history_item_id}/audio?download=1" download title="Download" aria-label="Download">${icon("download")}</a>
        <button class="icon-btn" data-del title="Delete" aria-label="Delete">${icon("trash")}</button></div></div>`)}</div>`);
    const byId = Object.fromEntries(data.history.map((h) => [h.history_item_id, h]));
    container.onclick = async (e) => {
      const row = e.target.closest("[data-id]");
      if (!row) return;
      const h = byId[row.dataset.id];
      if (e.target.closest("[data-play]")) playHistory(h);
      else if (e.target.closest("[data-use]")) onUse(h);
      else if (e.target.closest("[data-del]")) {
        if (!(await confirmDialog("Delete generation?", "This permanently removes the audio from history."))) return;
        try { await api(`/v1/history/${h.history_item_id}`, { method: "DELETE" }); row.remove(); toast("Deleted"); refreshUsage(); } catch (err) { toastError(err); }
      }
    };
  };
  await load();
  return load;
}

export const chevron = () => raw('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--fg-muted)"><path d="m9 6 6 6-6 6"/></svg>');

// ====================================================================== Home
const home = {
  match: /^\/app\/home$/,
  title: "Home",
  async render(el) {
    const [settings, hist] = await Promise.all([store.loadSettings(), api("/v1/history?page_size=8"), store.loadVoices()]);
    let voiceId = ls.get("tts_state", {}).voice_id || settings.default_voice_id;
    if (!store.voice(voiceId)) voiceId = store.voices[0]?.voice_id;
    const quick = [
      ["/app/speech-synthesis/text-to-speech", "wave", "Speech"],
      ["/app/studio", "book", "Studio"],
      ["/app/voice-changer", "sts", "Voice Changer"],
      ["/app/sound-effects", "sfx", "Sound Effects"],
      ["/app/speech-to-text", "stt", "Transcribe"],
      ["/app/voice-lab", "clone", "Voice Clone"],
      ["/app/voice-design", "sparkle", "Voice Design"],
      ["/app/dialogue", "dialogue", "Dialogue"],
    ];
    const slides = [
      { h: "Meet the Qwen3 voices", p: "Nine expressive voices in ten languages, with style instructions.", go: "/app/speech-synthesis/text-to-speech?voice=qwen_aiden", more: "/app/voice-library?engine=qwen", hue: 0 },
      { h: "Clone a voice in seconds", p: "Record 10 seconds of your voice and use it everywhere.", go: "/app/voice-lab", more: "/app/voice-lab", hue: 140 },
    ];
    el.innerHTML = String(html`<div class="page-inner" style="max-width:830px">
      <section class="hero">
        <h1 class="display">What do you want to make today?</h1>
        <form class="prompt" data-prompt>
          <button type="button" class="play-orb" data-pv title="Choose voice" aria-label="Choose voice">${orb(voiceId)}</button>
          <input data-q placeholder="Write what you want spoken, then press Enter…" aria-label="Text to speak" maxlength="20000">
          <button type="button" class="icon-btn" data-mic title="Dictate" aria-label="Dictate">${icon("mic")}</button>
          <button class="send" data-send disabled aria-label="Create speech">${icon("arrowUp")}</button>
        </form>
      </section>
      <nav class="quick">${quick.map(([href, ic, label]) => html`<a href="${href}" data-link><span class="qi">${icon(ic)}</span>${label}</a>`)}</nav>
      <section class="promo" data-promo></section>
      <div class="row" style="justify-content:center;gap:6px;margin:21px 0 52px" data-dots>${slides.map((_, i) => html`<button class="dotbtn" data-dot="${i}" aria-label="Slide ${i + 1}"></button>`)}</div>
      <div class="tabs"><button class="tab active" data-tab="recent">Recents</button><button class="tab" data-tab="starts">Quick starts</button></div>
      <div data-tabbody style="padding-top:8px"></div>
    </div>`);

    // Prompt: voice orb, dictation and send.
    const form = $("[data-prompt]", el), q = $("[data-q]", el), send = $("[data-send]", el), mic = $("[data-mic]", el);
    q.oninput = () => { send.disabled = !q.value.trim(); };
    $("[data-pv]", el).onclick = async () => { const id = await pickVoice(voiceId); if (id) { voiceId = id; $("[data-pv]", el).innerHTML = String(orb(id)); } };
    form.onsubmit = (e) => {
      e.preventDefault();
      if (!q.value.trim()) return;
      ls.set("tts_draft", q.value.trim());
      ls.set("tts_state", { ...ls.get("tts_state", {}), voice_id: voiceId });
      navigate(`/app/speech-synthesis/text-to-speech?voice=${encodeURIComponent(voiceId)}&autogen=1`);
    };
    let rec = null;
    mic.onclick = async () => {
      try {
        if (!rec) { rec = await startRecording(); mic.innerHTML = String(icon("stop")); mic.title = "Stop dictation"; return; }
        const file = await rec.stop(); rec = null;
        mic.innerHTML = '<span class="spinner"></span>';
        const fd = new FormData();
        fd.set("file", (await toWav(file)).blob, "dictation.wav");
        const t = await api("/v1/speech-to-text", { method: "POST", body: fd });
        q.value = (q.value ? q.value + " " : "") + t.text;
        q.dispatchEvent(new Event("input"));
        api(`/v1/speech-to-text/transcripts/${t.transcription_id}`, { method: "DELETE" }).catch(() => {});
      } catch (e) { toastError(e); rec = null; }
      mic.innerHTML = String(icon("mic")); mic.title = "Dictate";
    };

    // Carousel
    let slide = 0;
    const promo = $("[data-promo]", el);
    const showSlide = (i) => {
      slide = (i + slides.length) % slides.length;
      const s = slides[slide];
      // Decorative voice orbs on the right, tinted per slide.
      const orbs = [[62, 18, 96, 0], [86, 4, 44, 50], [74, 64, 58, 110], [93, 70, 40, 170], [50, 66, 30, 220]];
      const art = orbs.map(([x, y, d, h]) => `<span style="position:absolute;left:${x}%;top:${y}%;width:${d}px;height:${d}px;margin-left:-${d / 2}px;border-radius:50%;background:radial-gradient(circle at 35% 30%,hsl(${(s.hue + h) % 360} 85% 78%),hsl(${(s.hue + h + 30) % 360} 70% 45%));box-shadow:inset 0 0 0 1px rgba(0,0,0,.05)"></span>`).join("");
      promo.innerHTML = String(html`<div class="art">${raw(art)}</div><div class="promo-in"><h3>${s.h}</h3><p>${s.p}</p><div class="row"><a class="btn-white" href="${s.go}" data-link>Try it</a><a class="btn-link" href="${s.more}" data-link>Learn more</a></div></div>`);
      $$("[data-dot]", el).forEach((d) => d.classList.toggle("on", Number(d.dataset.dot) === slide));
    };
    $$("[data-dot]", el).forEach((d) => d.onclick = () => { showSlide(Number(d.dataset.dot)); restart(); });
    let timer;
    const restart = () => { clearInterval(timer); timer = setInterval(() => showSlide(slide + 1), 7000); };
    showSlide(0); restart();

    // Tabs
    const body = $("[data-tabbody]", el);
    const renderTab = (t) => {
      $$("[data-tab]", el).forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
      if (t === "starts") {
        body.innerHTML = String(html`<div class="starts">${STARTERS.slice(0, 6).map(([l, text], i) => html`<button class="start-card" data-start="${i}"><span class="qi sm">${icon(["book", "smile", "megaphone", "film", "news", "sparkle"][i])}</span><span><b>${l}</b><span class="small muted" style="display:block;margin-top:2px">${text.slice(0, 64)}…</span></span></button>`)}</div>`);
        body.onclick = (e) => { const b = e.target.closest("[data-start]"); if (!b) return; ls.set("tts_draft", STARTERS[b.dataset.start][1]); navigate("/app/speech-synthesis/text-to-speech"); };
        return;
      }
      if (!hist.history.length) { body.innerHTML = String(html`<div class="empty">${icon("sparkle")}<div>Nothing yet. What you create will show up here.</div></div>`); return; }
      body.innerHTML = String(html`<div class="list">${hist.history.map((h) => html`<div class="list-row" data-id="${h.history_item_id}">
        <span class="avatar-tile" style="width:40px;height:40px">${orb(h.voice_id || h.history_item_id, "sm")}</span><div class="grow"><div class="title">${h.text || h.voice_name || SOURCE_LABEL[h.source]}</div>
        <div class="meta">${SOURCE_LABEL[h.source] || h.source}${h.voice_name ? ` · ${h.voice_name}` : ""} · ${fmtAgo(h.date_unix)}</div></div>
        <button class="icon-btn" data-play aria-label="Play">${icon("play")}</button></div>`)}</div>`);
      body.onclick = (e) => { const r = e.target.closest("[data-id]"); if (r) playHistory(hist.history.find((h) => h.history_item_id === r.dataset.id)); };
    };
    $$("[data-tab]", el).forEach((b) => b.onclick = () => renderTab(b.dataset.tab));
    renderTab("recent");
    return () => { clearInterval(timer); rec?.stop(); };
  },
};

// ====================================================================== Text to Speech
const STARTERS = [
  ["Narrate a story", "In the ancient land of Eldoria, where the skies shimmered and the forests whispered secrets to the wind, there lived a dragon named Zephyros. Not the fearsome kind, but gentle and wise, with eyes that sparkled like a thousand stars."],
  ["Tell a silly joke", "Why don't skeletons fight each other? Because they don't have the guts! And honestly, neither do I, which is why I'm telling jokes instead."],
  ["Record an advertisement", "Tired of mornings that drag? Meet Brightbrew, the coffee that wakes up before you do. Rich, smooth, and ready in sixty seconds. Brightbrew. Start bright."],
  ["Direct a dramatic movie scene", "The storm was getting closer. She turned to him, rain streaming down her face. \"We don't have time,\" she whispered. \"If we don't leave now, we never will.\""],
  ["Introduce your podcast", "Welcome back to Curious Minds, the show where we ask the questions nobody else thinks to ask. I'm your host, and today we're exploring why cats really knock things off tables."],
  ["Guide a meditation class", "Find a comfortable position and gently close your eyes. Breathe in slowly through your nose, and out through your mouth. Let your shoulders soften. You are exactly where you need to be."],
];

const STYLE_PRESETS = ["Cheerful and upbeat", "Calm, warm narrator", "Whispering softly", "Sad and slow", "Angry and intense", "Excited, fast-paced", "News anchor, formal"];

const tts = {
  match: /^\/app\/speech-synthesis\/text-to-speech$/,
  title: "Text to Speech",
  async render(el, { query }) {
    const [settings, voices, models] = await Promise.all([store.loadSettings(), store.loadVoices(), store.loadModels()]);
    const saved = ls.get("tts_state", {});
    const state = {
      voice_id: query.get("voice") || saved.voice_id || settings.default_voice_id,
      model_id: saved.model_id || "kokoro_82m",
      output_format: saved.output_format || settings.default_output_format,
      language: saved.language || "auto", instructions: saved.instructions || "",
      speed: saved.speed ?? 1, stability: saved.stability ?? 0.5, similarity_boost: saved.similarity_boost ?? 0.75, style: saved.style ?? 0, use_speaker_boost: saved.use_speaker_boost ?? true,
    };
    if (!store.voice(state.voice_id)) state.voice_id = voices[0]?.voice_id;
    let tab = "settings";
    let busy = false;
    const MAX = 20000;

    const STARTER_ICONS = ["book", "smile", "megaphone", "film", "news", "sparkle"];
    el.innerHTML = String(html`<div class="studio">
      <div class="studio-main">
        <div class="studio-top"><button class="voice-chip" data-voice-chip></button></div>
        <div class="studio-editor">
          <textarea data-text placeholder="Start typing here, or paste any text you want spoken…" maxlength="${MAX}" aria-label="Text to convert"></textarea>
        </div>
        <div class="starters-wrap" data-starters><div class="small">Get started with</div><div class="starters">${STARTERS.map(([l], i) => html`<button class="chip" data-starter="${i}">${icon(STARTER_ICONS[i])} ${l}</button>`)}</div></div>
        <div class="studio-bar" data-bar><span class="small muted" data-count></span><span class="grow"></span>
          <span class="small muted hide-sm"><span class="kbd">Ctrl</span> <span class="kbd">Enter</span></span>
          <button class="btn btn-lg" data-stop hidden>${icon("stop")} Stop</button>
          <button class="btn btn-primary btn-lg" data-gen>Generate speech</button></div>
      </div>
      <aside class="studio-side"><div class="tabs"><button class="tab active" data-tab="settings">Settings</button><button class="tab" data-tab="history">History</button></div>
        <div class="side-body" data-side></div></aside></div>`);

    const text = $("[data-text]", el);
    const side = $("[data-side]", el);
    const count = $("[data-count]", el);
    const genBtn = $("[data-gen]", el);
    const stopBtn = $("[data-stop]", el);
    let abort = null;
    stopBtn.onclick = () => abort?.abort();
    text.value = ls.get("tts_draft", "");
    const persist = () => ls.set("tts_state", state);
    const updateCount = () => {
      count.textContent = `${fmtNum(text.value.length)} / ${fmtNum(MAX)} characters`;
      $("[data-starters]", el).hidden = Boolean(text.value.trim());
      $("[data-bar]", el).hidden = !text.value.trim() && !busy;
      if (!busy) genBtn.disabled = !text.value.trim();
    };
    text.addEventListener("input", () => { ls.set("tts_draft", text.value); updateCount(); });
    $$("[data-starter]", el).forEach((b) => b.onclick = () => { text.value = STARTERS[b.dataset.starter][1]; ls.set("tts_draft", text.value); updateCount(); text.focus(); });

    const modelsFor = (voice) => models.filter((m) => m.provider === (voice?.provider || "local") && m.can_do_text_to_speech);
    const qwenModel = models.find((m) => m.provider === "qwen");

    const renderSettings = () => {
      const voice = store.voice(state.voice_id);
      const isEl = voice?.provider === "elevenlabs";
      const isQwen = voice?.provider === "qwen";
      const ms = modelsFor(voice);
      if (!ms.find((m) => m.model_id === state.model_id)) state.model_id = ms[0]?.model_id;
      const formats = UI_FORMATS.filter((f) => !(isEl && f.localOnly));
      if (!formats.find((f) => f.id === state.output_format)) state.output_format = formats[0].id;
      const chip = $("[data-voice-chip]", el);
      chip.innerHTML = String(html`${orb(state.voice_id, "xs")}<span class="n">${voiceLabel(voice)}</span>`);
      chip.onclick = async () => { const id = await pickVoice(state.voice_id); if (id) { state.voice_id = id; persist(); setTab("settings"); } };
      const tip = !ls.get("tip_qwen_dismissed", false) && qwenModel && !isQwen;
      side.innerHTML = String(html`
        ${tip ? html`<div class="tip-card"><span class="tip-art"></span><div class="grow"><div class="tip-t">Try the Qwen3 voices</div><div class="tip-s">Expressive voices with style instructions, in ten languages.</div></div><button class="icon-btn" data-tip-x aria-label="Dismiss">${icon("x")}</button></div>` : ""}
        <div class="field"><span class="label">Voice</span><button class="voice-select" data-voice>${orb(state.voice_id, "xs")}<span class="name">${voiceLabel(voice)}</span>${chevron()}</button></div>
        <div class="field"><label for="tts-model">Model</label><select class="select model-select" id="tts-model" data-model title="${ms.find((m) => m.model_id === state.model_id)?.description || ""}">${ms.map((m) => html`<option value="${m.model_id}" ${m.model_id === state.model_id ? raw("selected") : ""}>${m.name}</option>`)}</select></div>
        ${isQwen ? html`
          <div class="side-row"><label for="tts-lang">Language</label><select class="pill-select" id="tts-lang" data-lang>${(qwenModel?.languages || []).map((l) => html`<option value="${l.language_id}" ${l.language_id === state.language ? raw("selected") : ""}>${l.language_id === "auto" ? "Auto" : l.name}</option>`)}</select></div>
          ${!voice.style_instructions
            ? html`<div class="notice">${icon("info")}<div>This voice keeps the tone of its reference recording. Style instructions work with the 9 Qwen preset voices.</div></div>`
            : html`<div class="field"><label for="tts-instr">Style instructions <span class="subtle">(optional)</span></label>
              <textarea class="textarea" id="tts-instr" data-instr maxlength="500" placeholder="e.g. Speak softly, like telling a bedtime story" style="min-height:76px">${state.instructions}</textarea>
              <div class="chips" style="gap:6px">${STYLE_PRESETS.map((s) => html`<button class="chip" data-style="${s}" style="height:26px;font-size:12px">${s}</button>`)}</div></div>`}`
        : slider({ key: "speed", label: "Speed", min: 0.7, max: 1.2, step: 0.01, value: state.speed, left: "Slower", right: "Faster" })}
        ${isQwen ? "" : isEl ? html`
          ${slider({ key: "stability", label: "Stability", min: 0, max: 1, step: 0.01, value: state.stability, left: "More variable", right: "More stable" })}
          ${slider({ key: "similarity_boost", label: "Similarity", min: 0, max: 1, step: 0.01, value: state.similarity_boost, left: "Low", right: "High" })}
          ${slider({ key: "style", label: "Style exaggeration", min: 0, max: 1, step: 0.01, value: state.style, left: "None", right: "Exaggerated" })}
          <label class="toggle-row"><span>Speaker boost</span><span class="switch"><input type="checkbox" data-boost ${state.use_speaker_boost ? raw("checked") : ""}><span></span></span></label>`
        : ""}
        ${isEl ? "" : tagChips(voice)}
        <div class="side-row"><label for="tts-fmt">Output format</label><select class="pill-select" id="tts-fmt" data-fmt>${formats.map((f) => html`<option value="${f.id}" ${f.id === state.output_format ? raw("selected") : ""}>${f.label}</option>`)}</select></div>
        <button class="btn btn-sm btn-ghost" data-reset style="align-self:flex-start">${icon("refresh")} Reset values</button>`);
      wireSliders(side, state);
      side.querySelectorAll("input[type=range]").forEach((r) => r.addEventListener("change", persist));
      const tipX = $("[data-tip-x]", side);
      if (tipX) {
        tipX.onclick = (e) => { e.stopPropagation(); ls.set("tip_qwen_dismissed", true); renderSettings(); };
        $(".tip-card", side).onclick = () => { state.voice_id = "qwen_aiden"; persist(); renderSettings(); };
      }
      $("[data-voice]", side).onclick = async () => { const id = await pickVoice(state.voice_id); if (id) { state.voice_id = id; persist(); renderSettings(); } };
      $("[data-model]", side).onchange = (e) => { state.model_id = e.target.value; persist(); renderSettings(); };
      $("[data-fmt]", side).onchange = (e) => { state.output_format = e.target.value; persist(); };
      $$("[data-tag]", side).forEach((b) => b.onclick = () => insertTag(text, b.dataset.tag));
      const boost = $("[data-boost]", side);
      if (boost) boost.onchange = () => { state.use_speaker_boost = boost.checked; persist(); };
      const lang = $("[data-lang]", side);
      if (lang) lang.onchange = () => { state.language = lang.value; persist(); };
      const instr = $("[data-instr]", side);
      if (instr) {
        instr.oninput = () => { state.instructions = instr.value; persist(); };
        $$("[data-style]", side).forEach((b) => b.onclick = () => { instr.value = state.instructions = b.dataset.style; persist(); });
      }
      $("[data-reset]", side).onclick = () => { Object.assign(state, { speed: 1, stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true }); persist(); renderSettings(); };
    };
    const renderHistory = () => historyList(side, {
      source: "TTS", empty: "Generated speech will appear here.",
      onUse: (h) => {
        text.value = h.text || "";
        ls.set("tts_draft", text.value);
        if (store.voice(h.voice_id)) state.voice_id = h.voice_id;
        for (const k of ["speed", "stability", "similarity_boost", "style", "use_speaker_boost", "instructions"]) if (h.settings?.[k] !== undefined) state[k] = h.settings[k];
        persist(); updateCount(); setTab("settings");
      },
    });
    const setTab = (t) => { tab = t; $$("[data-tab]", el).forEach((b) => b.classList.toggle("active", b.dataset.tab === t)); side.onclick = null; t === "settings" ? renderSettings() : renderHistory(); };
    $$("[data-tab]", el).forEach((b) => b.onclick = () => setTab(b.dataset.tab));

    const generate = async () => {
      const t = text.value.trim();
      if (!t || busy) return;
      const voice = store.voice(state.voice_id);
      if (!voice) return toast("Pick a voice first.", "error");
      busy = true;
      setLoading(genBtn, true, "Generating…");
      const stop = elapsedLabel(genBtn, "Generating…");
      try {
        const body = { text: t, model_id: state.model_id };
        if (voice.provider === "elevenlabs") body.voice_settings = { stability: state.stability, similarity_boost: state.similarity_boost, style: state.style, use_speaker_boost: state.use_speaker_boost, speed: state.speed };
        else if (voice.provider === "qwen") {
          body.language_code = state.language;
          if (voice.style_instructions && state.instructions.trim()) body.instructions = state.instructions.trim();
        } else body.voice_settings = { speed: state.speed };
        const path = `/v1/text-to-speech/${encodeURIComponent(voice.voice_id)}`;
        // MP3 plays while it's generated; WAV (or a browser without MediaSource) waits for the whole file.
        if (canStream() && state.output_format.startsWith("mp3_")) {
          abort = new AbortController();
          stopBtn.hidden = false;
          const out = await streamAudio(`${path}/stream?output_format=${state.output_format}`, { json: body, signal: abort.signal, title: voice.name, subtitle: t, voiceId: voice.voice_id });
          if (out.stopped) toast(out.played ? "Stopped. The part that played isn't saved to history." : "Stopped.");
        } else {
          const out = await postAudio(`${path}?output_format=${state.output_format}`, { json: body });
          player.play({ url: out.url, downloadUrl: `/v1/history/${out.historyId}/audio?download=1`, title: voice.name, subtitle: t, voiceId: voice.voice_id, id: out.historyId });
        }
        refreshUsage();
        if (tab === "history") renderHistory();
      } catch (e) { toastError(e); } finally { stop(); busy = false; abort = null; stopBtn.hidden = true; setLoading(genBtn, false); updateCount(); }
    };
    genBtn.onclick = generate;
    const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); generate(); } };
    document.addEventListener("keydown", onKey);
    renderSettings();
    updateCount();
    // Arriving from the Home prompt: generate straight away, once.
    if (query.get("autogen") && text.value.trim()) {
      history.replaceState({}, "", `${location.pathname}?voice=${encodeURIComponent(state.voice_id)}`);
      generate();
    }
    return () => document.removeEventListener("keydown", onKey);
  },
};

// ====================================================================== Voices
const PROVIDER_LABEL = { local: "Kokoro · local", qwen: "Qwen3-TTS · local", cloned: "Cloned · Qwen3-TTS", generated: "Designed · Qwen3-TTS", elevenlabs: "ElevenLabs" };
function voiceCard(v, { deletable = false } = {}) {
  const heart = String(icon("heart")).replace('fill="none"', v.is_favorite ? 'fill="currentColor"' : 'fill="none"');
  return html`<div class="voice-card" data-vid="${v.voice_id}">
    <div class="head"><button class="play-orb" data-preview="${v.voice_id}" aria-label="Preview ${v.name}">${orb(v.voice_id, "lg")}<span class="ov">${icon("play")}</span></button>
      <div style="min-width:0;flex:1"><div class="h3">${v.name}</div><div class="small subtle">${PROVIDER_LABEL[v.provider === "qwen" && OWN.has(v.category) ? v.category : v.provider] || v.provider}${v.labels?.quality ? ` · grade ${v.labels.quality}` : ""}</div></div>
      <button class="icon-btn ${v.is_favorite ? "on" : ""}" data-fav title="${v.is_favorite ? "Remove from favorites" : "Add to favorites"}" aria-label="Favorite" aria-pressed="${v.is_favorite}">${raw(heart)}</button></div>
    <p class="desc">${v.description || ""}</p>
    <div class="foot">${["gender", "accent", "language"].map((k) => (v.labels?.[k] ? html`<span class="badge">${v.labels[k]}</span>` : ""))}<span class="sp"></span>
      ${deletable ? html`<button class="btn btn-sm btn-danger" data-delete>${icon("trash")} Delete</button>`
        : html`<button class="btn btn-sm" data-mine>${v.in_my_voices ? html`${icon("check")} Added` : html`${icon("plus")} Add`}</button>`}
      <a class="btn btn-sm btn-primary" href="/app/speech-synthesis/text-to-speech?voice=${v.voice_id}" data-link>Use</a></div></div>`;
}
function voiceGridActions(container, onChange) {
  container.addEventListener("click", async (e) => {
    const p = e.target.closest("[data-preview]");
    if (p) return previewVoice(p.dataset.preview, p);
    const card = e.target.closest("[data-vid]");
    if (!card) return;
    const v = store.voice(card.dataset.vid);
    try {
      if (e.target.closest("[data-fav]")) {
        await api(`/api/voices/${encodeURIComponent(v.voice_id)}/meta`, { method: "POST", json: { favorite: !v.is_favorite } });
        v.is_favorite = !v.is_favorite;
        toast(v.is_favorite ? "Added to favorites" : "Removed from favorites");
        onChange();
      } else if (e.target.closest("[data-mine]")) {
        await api(`/api/voices/${encodeURIComponent(v.voice_id)}/meta`, { method: "POST", json: { in_my_voices: !v.in_my_voices } });
        v.in_my_voices = !v.in_my_voices;
        toast(v.in_my_voices ? "Added to My Voices" : "Removed from My Voices");
        onChange();
      } else if (e.target.closest("[data-delete]")) {
        const where = v.provider === "elevenlabs" ? "from your ElevenLabs account" : "and its sample from this server";
        if (!(await confirmDialog(`Delete ${v.name}?`, `This permanently deletes the cloned voice ${where}.`))) return;
        await api(`/v1/voices/${encodeURIComponent(v.voice_id)}`, { method: "DELETE" });
        toast("Voice deleted");
        onChange(true);
      }
    } catch (err) { toastError(err); }
  });
}

// Compact row used in the voice grids (avatar tile, name, description, tags, hover actions).
function voiceRow(v, { deletable = false } = {}) {
  const heart = String(icon("heart")).replace('fill="none"', v.is_favorite ? 'fill="currentColor"' : 'fill="none"');
  const lang = v.labels?.native_language || v.labels?.accent;
  return html`<div class="vrow" data-vid="${v.voice_id}">
    <button class="avatar-tile play-orb" data-preview="${v.voice_id}" aria-label="Preview ${v.name}">${orb(v.voice_id)}<span class="ov">${icon("play")}</span></button>
    <div class="grow"><div class="nm">${v.name}${v.description ? ` - ${v.description.replace(/\.$/, "")}` : ""}</div>
      <div class="ds">${PROVIDER_LABEL[v.provider === "qwen" && OWN.has(v.category) ? v.category : v.provider] || v.provider}</div>
      <div class="lang">${lang ? html`${icon("globe")}<span>${cap(lang)}</span>` : ""}${v.labels?.gender ? html`<span class="plus">${cap(v.labels.gender)}</span>` : ""}</div></div>
    <div class="acts">
      <button class="icon-btn ${v.is_favorite ? "on" : ""}" data-fav title="${v.is_favorite ? "Remove from favorites" : "Add to favorites"}" aria-label="Favorite" aria-pressed="${v.is_favorite}">${raw(heart)}</button>
      ${deletable ? html`<button class="icon-btn" data-delete title="Delete voice" aria-label="Delete voice">${icon("trash")}</button>`
        : html`<button class="icon-btn" data-mine title="${v.in_my_voices ? "Remove from My Voices" : "Add to My Voices"}" aria-label="My Voices">${icon(v.in_my_voices ? "check" : "plus")}</button>`}
      <a class="btn btn-sm" href="/app/speech-synthesis/text-to-speech?voice=${v.voice_id}" data-link>Use</a></div></div>`;
}

const USE_CASES = [
  { title: "Expressive voices you can direct", chip: "qwen", bg: "linear-gradient(135deg,#efe4d6,#d9c6b0)", art: "radial-gradient(circle at 40% 40%,#f6b98a,#b8643c)" },
  { title: "Clear British narrators", chip: "british", bg: "linear-gradient(135deg,#e6dbdb,#cdbcbc)", art: "radial-gradient(circle at 40% 40%,#c9a7ff,#5b3cc4)" },
  { title: "Warm female voices", chip: "female", bg: "linear-gradient(135deg,#dfe8e1,#c3d4c7)", art: "radial-gradient(circle at 40% 40%,#9de0b8,#2f7d52)" },
  { title: "Speak in ten languages", chip: "multilingual", bg: "linear-gradient(135deg,#dde3ee,#c3cde0)", art: "radial-gradient(circle at 40% 40%,#9cc3ff,#2c5fc4)" },
];
const VOICE_CHIPS = [
  ["female", "Female", "smile", (v) => v.labels?.gender === "female"],
  ["male", "Male", "smile", (v) => v.labels?.gender === "male"],
  ["american", "American", "globe", (v) => v.labels?.accent === "american"],
  ["british", "British", "globe", (v) => v.labels?.accent === "british"],
  ["multilingual", "Multilingual", "globe", (v) => Boolean(v.labels?.language) && v.labels.language !== "en"],
  ["narration", "Narration", "book", (v) => ["narration", "storytelling", "documentary"].includes(v.labels?.use_case)],
  ["characters", "Characters", "sparkle", (v) => v.labels?.use_case === "characters"],
  ["qwen", "Style control", "sparkle", (v) => Boolean(v.style_instructions)],
  ["kokoro", "Fast", "wave", (v) => v.provider === "local"],
  ["fav", "Favorites", "heart", (v) => v.is_favorite],
];

async function voicesPage(el, { mine, query }) {
  el.innerHTML = String(html`<div class="page-inner">
    <div class="page-head" style="margin-bottom:3px"><h1 class="h1">Voices</h1></div>
    <div class="tabs-row"><div class="tabs"><a class="tab ${mine ? "" : "active"}" href="/app/voice-library" data-link>${icon("grid")} Explore</a><a class="tab ${mine ? "active" : ""}" href="/app/voice-lab" data-link>${icon("clone")} My Voices</a></div>
      <button class="btn btn-primary btn-md" data-add>${icon("clone")} Clone a voice</button></div>
    <div class="filters" style="margin-top:24px"><div class="search">${icon("search")}<input class="input" placeholder="${mine ? "Search my voices…" : "Search voices by name, accent or style…"}" data-q aria-label="Search voices"></div>
      <button class="btn btn-md" data-filters>${icon("filter")} Filters</button>
      <button class="icon-btn outline" data-sort title="Sort: Recommended" aria-label="Sort: Recommended" style="width:40px;height:40px">${icon("sort")}</button></div>
    <div class="filters" data-panel hidden style="margin-top:0">
      <select class="select" data-engine aria-label="Engine" style="width:auto"><option value="">All engines</option><option value="local">Kokoro</option><option value="qwen">Qwen3-TTS</option><option value="elevenlabs">ElevenLabs</option></select></div>
    <div class="chips scroll" data-chips>${VOICE_CHIPS.map(([k, l, ic]) => html`<button class="chip lg" data-chip="${k}">${icon(ic)} ${l}</button>`)}</div>
    <div data-body></div></div>`);
  const body = $("[data-body]", el);
  const f = { q: "", sort: "quality", engine: "", chips: new Set(query.get("engine") === "qwen" ? ["qwen"] : []) };
  let voices = await store.loadVoices(true);
  const grade = (v) => (v.provider === "qwen" ? "A" : v.labels?.quality || "Z");
  const apply = (list) => {
    const out = list.filter((v) => (!f.engine || v.provider === f.engine)
      && [...f.chips].every((k) => VOICE_CHIPS.find((c) => c[0] === k)[3](v))
      && (!f.q || `${v.name} ${v.description} ${Object.values(v.labels || {}).join(" ")}`.toLowerCase().includes(f.q)));
    return out.sort(f.sort === "name" ? (a, b) => a.name.localeCompare(b.name) : f.sort === "fav" ? (a, b) => b.is_favorite - a.is_favorite || a.name.localeCompare(b.name) : (a, b) => grade(a).localeCompare(grade(b)) || a.name.localeCompare(b.name));
  };
  const grid = (list) => html`<div class="vgrid">${list.map((v) => voiceRow(v, { deletable: OWN.has(v.category) || (v.provider === "elevenlabs" && v.category !== "premade") }))}</div>`;
  const render = () => {
    $$("[data-chip]", el).forEach((c) => c.classList.toggle("on", f.chips.has(c.dataset.chip)));
    const filtering = f.q || f.engine || f.chips.size;
    if (mine) {
      const list = apply(voices.filter((v) => v.in_my_voices));
      body.innerHTML = list.length ? String(html`<div class="section-head"><h2 class="h2">My voices <span class="muted" style="font-size:14px">${list.length}</span></h2></div>${grid(list)}`)
        : String(html`<div class="empty">${icon("clone")}<div style="margin-bottom:12px">${filtering ? "None of your voices match." : "Clone a voice, design one in Voice Design, or add voices from Explore."}</div><button class="btn btn-primary" data-add2>${icon("clone")} Clone a voice</button></div>`);
      $("[data-add2]", body)?.addEventListener("click", () => $("[data-add]", el).click());
      return;
    }
    const all = apply(voices);
    if (filtering) {
      body.innerHTML = all.length ? String(html`<div class="section-head"><h2 class="h2">Results <span class="muted" style="font-size:14px">${all.length}</span></h2></div>${grid(all)}`) : String(html`<div class="empty">No voices match those filters.</div>`);
      return;
    }
    body.innerHTML = String(html`
      <div class="section-head"><h2 class="h2">Featured voices</h2></div>${grid(all.slice(0, 9))}
      <div class="section-head"><h2 class="h2">Picked for your use case</h2><div class="row"><button class="icon-btn outline" data-scroll="-1" aria-label="Scroll left">${icon("chevronL")}</button><button class="icon-btn outline" data-scroll="1" aria-label="Scroll right">${icon("chevron")}</button></div></div>
      <div class="cards-row" data-cards>${USE_CASES.map((u) => html`<button class="use-card" data-use="${u.chip}" style="background:${u.bg};border:none;text-align:left"><span class="art" style="background:${u.art}"></span><h3>${u.title}</h3><span class="go">${icon("arrowR")}</span></button>`)}</div>
      <div class="section-head"><h2 class="h2">All voices <span class="muted" style="font-size:14px">${all.length}</span></h2></div>${grid(all)}`);
    $$("[data-scroll]", body).forEach((b) => b.onclick = () => $("[data-cards]", body).scrollBy({ left: Number(b.dataset.scroll) * 352, behavior: "smooth" }));
    $$("[data-use]", body).forEach((b) => b.onclick = () => { f.chips = new Set([b.dataset.use]); render(); el.closest(".page").scrollTo({ top: 0, behavior: "smooth" }); });
  };
  let deb;
  $("[data-q]", el).oninput = (e) => { clearTimeout(deb); deb = setTimeout(() => { f.q = e.target.value.trim().toLowerCase(); render(); }, 120); };
  const SORTS = [["quality", "Recommended"], ["name", "Name A–Z"], ["fav", "Favorites first"]];
  $("[data-sort]", el).onclick = (e) => {
    const b = e.currentTarget;
    const next = SORTS[(SORTS.findIndex(([k]) => k === f.sort) + 1) % SORTS.length];
    f.sort = next[0];
    b.title = b.ariaLabel = `Sort: ${next[1]}`;
    toast(`Sorted by ${next[1].toLowerCase()}`);
    render();
  };
  $("[data-engine]", el).onchange = (e) => { f.engine = e.target.value; render(); };
  $("[data-filters]", el).onclick = () => { const p = $("[data-panel]", el); p.hidden = !p.hidden; };
  $$("[data-chip]", el).forEach((c) => c.onclick = () => { f.chips.has(c.dataset.chip) ? f.chips.delete(c.dataset.chip) : f.chips.add(c.dataset.chip); render(); });
  const created = async () => { voices = await store.loadVoices(true); if (!mine) navigate("/app/voice-lab"); else render(); };
  $("[data-add]", el).onclick = () => cloneDialog(created);
  voiceGridActions(body, async (fresh) => { if (fresh) voices = await store.loadVoices(true); render(); });
  render();
}

const voiceLibrary = {
  match: /^\/app\/voice-library$/,
  title: "Voices",
  crumbs: [["Voices", "/app/voice-library"], "Explore"],
  render: (el, ctx) => voicesPage(el, { mine: false, query: ctx.query }),
};

const myVoices = {
  match: /^\/app\/voice-lab$/,
  title: "My Voices",
  crumbs: [["Voices", "/app/voice-library"], "My Voices"],
  render: (el, ctx) => voicesPage(el, { mine: true, query: ctx.query }),
};

function cloneDialog(onDone) {
  const localOk = store.settings?.local_cloning;
  const elOk = store.settings?.elevenlabs?.connected;
  if (!localOk && !elOk) {
    modal({
      title: "Instant Voice Clone",
      body: html`<p class="muted" style="margin:0">Cloning needs either the local Qwen3-TTS Base model (see the README's Qwen3-TTS section) or an ElevenLabs API key.</p>`,
      foot: html`<button class="btn" data-close>Cancel</button><a class="btn btn-primary" href="/app/settings#providers" data-link data-close>${icon("key")} Connect ElevenLabs</a>`,
    });
    return;
  }
  let files = [];
  let rec = null;
  let provider = localOk ? "qwen" : "elevenlabs";
  modal({
    title: "Instant Voice Clone",
    body: html`<div class="field"><label for="ivc-name">Name</label><input class="input" id="ivc-name" data-name placeholder="e.g. Narrator" maxlength="100" autofocus></div>
      ${localOk && elOk ? html`<div class="field"><span class="label">Clone with</span><div><div class="seg" data-prov><button class="active" data-p="qwen">This computer (Qwen3-TTS)</button><button data-p="elevenlabs">ElevenLabs</button></div></div></div>` : ""}
      <div class="field"><span class="label">Samples</span><label class="dropzone" style="padding:20px">${icon("upload")}<div class="h3">Upload audio samples</div><input type="file" accept="audio/*,video/*" multiple hidden data-file></label>
        <div class="row" style="justify-content:center"><span class="small subtle">or</span><button class="btn btn-sm" type="button" data-rec>${icon("mic")} Record a sample</button></div>
        <div class="hint" data-hint></div><div data-files class="small"></div></div>
      <div class="field" data-tx-field><label for="ivc-tx">What is said in the sample <span class="subtle">(optional)</span></label><textarea class="textarea" id="ivc-tx" data-tx style="min-height:60px" maxlength="2000" placeholder="Leave empty to transcribe it automatically"></textarea></div>
      <div class="field"><label for="ivc-desc">Description <span class="subtle">(optional)</span></label><textarea class="textarea" id="ivc-desc" data-desc style="min-height:60px" maxlength="500"></textarea></div>
      <label class="row small" style="align-items:flex-start"><input type="checkbox" data-consent style="margin-top:3px"> <span>I confirm this is my own voice, or I have the speaker's permission to clone it, and I won't use it to impersonate anyone or for anything illegal, fraudulent or harmful.</span></label>`,
    foot: html`<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-save disabled>Add voice</button>`,
    onClose: () => rec?.stop(),
    onMount: (m, close) => {
      const save = $("[data-save]", m);
      const check = () => { save.disabled = Boolean(rec) || !($("[data-name]", m).value.trim() && files.length && $("[data-consent]", m).checked); };
      const showFiles = () => { $("[data-files]", m).textContent = files.map((f) => f.name).join(", "); check(); };
      const setProvider = (p) => {
        provider = p;
        $$("[data-p]", m).forEach((b) => b.classList.toggle("active", b.dataset.p === p));
        $("[data-hint]", m).textContent = p === "qwen"
          ? "5–20 seconds of one person speaking clearly, without music or background noise. Only the first 20 seconds are used."
          : "1–25 clean recordings, ideally 1–2 minutes in total.";
        $("[data-tx-field]", m).hidden = p !== "qwen";
      };
      setProvider(provider);
      $$("[data-p]", m).forEach((b) => b.onclick = () => setProvider(b.dataset.p));
      $("[data-file]", m).onchange = (e) => { files = [...e.target.files].slice(0, 25); showFiles(); };
      const recBtn = $("[data-rec]", m);
      recBtn.onclick = async () => {
        try {
          if (rec) { files = [await rec.stop()]; rec = null; recBtn.innerHTML = String(html`${icon("mic")} Record again`); showFiles(); return; }
          rec = await startRecording();
          recBtn.innerHTML = String(html`${icon("stop")} Stop recording`);
          check();
        } catch (e) { toastError(e); }
      };
      m.addEventListener("input", check);
      m.addEventListener("change", check);
      save.onclick = async () => {
        setLoading(save, true, provider === "qwen" ? "Preparing sample…" : "Cloning…");
        try {
          const form = new FormData();
          form.set("name", $("[data-name]", m).value.trim());
          form.set("provider", provider);
          const d = $("[data-desc]", m).value.trim();
          if (d) form.set("description", d);
          const tx = $("[data-tx]", m).value.trim();
          if (tx && provider === "qwen") form.set("transcript", tx);
          // The local server decodes WAV/MP3 only, so convert other formats (recordings are WebM) in the browser.
          for (const f of files) {
            if (provider === "qwen" && !/\.(wav|mp3)$/i.test(f.name)) form.append("files", (await toWav(f, 24000)).blob, f.name.replace(/\.\w+$/, "") + ".wav");
            else form.append("files", f, f.name);
          }
          await api("/v1/voices/add", { method: "POST", body: form });
          toast("Voice cloned");
          close();
          onDone();
        } catch (e) { toastError(e); setLoading(save, false); }
      };
    },
  });
}

// ====================================================================== Settings
const settingsPage = {
  match: /^\/app\/settings$/,
  title: "Settings",
  async render(el) {
    const [s, voices] = await Promise.all([store.loadSettings(true), store.loadVoices()]);
    const base = location.origin;
    const rw = s.qwen.remote; // GPU worker, when one is set up
    el.innerHTML = String(html`<div class="page-inner"><h1 class="h1">Settings</h1>
      <div class="settings-grid"><nav class="settings-nav"><a href="#profile" data-link>Profile</a><a href="#defaults" data-link>Defaults</a><a href="#usage" data-link>Usage</a><a href="#providers" data-link>Providers</a><a href="#appearance" data-link>Appearance</a><a href="#api" data-link>API</a><a href="#ai-apps" data-link>AI apps</a><a href="#extension" data-link>Browser extension</a><a href="#data" data-link>Data</a><a href="#computer" data-link>This computer</a><a href="#about" data-link>About</a></nav>
      <div>
        <section class="card settings-section" id="profile"><h2 class="h2">Profile</h2><form class="rows" data-form="profile">
          <div class="field"><label for="st-name">Display name</label><input class="input" id="st-name" name="display_name" value="${s.display_name}" maxlength="80" placeholder="Your name"></div>
          <button class="btn btn-primary" style="align-self:flex-start">Save</button></form></section>
        <section class="card settings-section" id="defaults"><h2 class="h2">Defaults</h2><form class="rows" data-form="defaults">
          <div class="field"><label for="st-voice">Default voice</label><select class="select" id="st-voice" name="default_voice_id">${voices.map((v) => html`<option value="${v.voice_id}" ${v.voice_id === s.default_voice_id ? raw("selected") : ""}>${v.name}${v.provider === "elevenlabs" ? " (ElevenLabs)" : ""}</option>`)}</select></div>
          <div class="field"><label for="st-fmt">Default output format</label><select class="select" id="st-fmt" name="default_output_format">${UI_FORMATS.map((f) => html`<option value="${f.id}" ${f.id === s.default_output_format ? raw("selected") : ""}>${f.label}</option>`)}</select></div>
          <button class="btn btn-primary" style="align-self:flex-start">Save</button></form></section>
        <section class="card settings-section" id="usage"><h2 class="h2">Usage</h2><p class="muted small">Characters generated this calendar month count toward the limit. Leave it empty for no limit.</p><form class="rows" data-form="usage">
          <div class="field"><label for="st-limit">Monthly character limit</label><input class="input" id="st-limit" name="character_limit" type="number" min="1" step="1" value="${s.character_limit ?? ""}" placeholder="Unlimited"></div>
          <button class="btn btn-primary" style="align-self:flex-start">Save</button></form></section>
        <section class="card settings-section" id="providers"><h2 class="h2">Providers</h2>
          <div class="rows"><div class="row" style="gap:12px">${orb("local-kokoro")}<div style="flex:1"><div class="h3">Local engine</div><div class="small subtle">Kokoro 82M · Whisper Base · MusicGen Small. Runs on this machine and is always on.</div></div><span class="badge green">Active</span></div>
          <div class="row" style="gap:12px">${orb("qwen3-tts")}<div style="flex:1"><div class="h3">${s.qwen.model}</div><div class="small subtle">${s.qwen.available
            ? `9 voices with style instructions in 10 languages${s.qwen.can_clone ? ", plus voice cloning" : ""}. ${rw ? "Runs on your GPU worker." : "Uses your downloaded models; starts on first use and stops after 10 idle minutes."}`
            : rw ? "Not available on the GPU worker yet. Check the connection below." : "Not found. Needs the Python environment and Qwen3-TTS models described in the README."}</div></div>
            ${s.qwen.available ? html`<span class="badge green">Active</span>` : html`<span class="badge">${rw ? "Unavailable" : "Not installed"}</span>`}</div>
          <div class="set-row" style="padding-left:44px"><div><div>Runs on</div><div class="small muted" style="font-weight:400" data-wstatus>${rw
              ? rw.connected ? html`<span class="dot ready"></span> Connected to ${rw.url} · ${rw.gpu || rw.device}${rw.size ? ` · ${rw.size}` : ""}` : html`<span class="dot error"></span> Can't reach ${rw.url}${rw.error ? `: ${rw.error}` : ""}`
              : "This computer's processor. A GPU worker makes Qwen3-TTS, voice design and voice isolation 20–50× faster."}</div></div>
            <div class="seg" data-where><button data-w="local" class="${rw ? "" : "active"}">This computer</button><button data-w="remote" class="${rw ? "active" : ""}">GPU worker</button></div></div>
          <form class="rows studio-worker" data-form="worker" style="padding-left:44px;margin-top:0" ${rw ? "" : raw("hidden")}>
            <div class="field"><label for="st-wurl">Worker address</label><input class="input" id="st-wurl" name="qwen_remote_url" placeholder="http://192.168.1.20:8765" value="${rw?.url || ""}" required autocomplete="off" spellcheck="false">
              <span class="hint">On the GPU machine, install the same Python packages and run <span class="mono">python worker/qwen_worker.py --host 0.0.0.0 --port 8765 --token YOUR_SECRET</span>. Works with a PC on your network or a rented cloud GPU.</span></div>
            <div class="field"><label for="st-wtok">Token</label><input class="input" id="st-wtok" name="qwen_remote_token" type="password" autocomplete="off" placeholder="${rw?.has_token ? "Saved. Leave empty to keep it." : "The --token you started the worker with"}"></div>
            <div class="row" style="gap:8px"><button class="btn btn-primary">${rw ? "Save" : "Connect"}</button>${rw ? html`<button type="button" class="btn" data-wcheck>${icon("refresh")} Check connection</button>` : ""}</div></form>
          ${s.qwen.sizes ? html`<div class="set-row" style="padding-left:44px"><div><div>Model size</div><div class="small muted" style="font-weight:400">1.7B sounds a little better but takes about twice as long and uses about 7 GB of RAM.</div></div>
            <div class="seg" data-qsize>${s.qwen.sizes.map((o) => html`<button data-size="${o.size}" class="${o.size === s.qwen.size ? "active" : ""}" ${o.voices ? "" : raw('disabled title="Not downloaded"')}>${o.size}</button>`)}</div></div>` : ""}
          <div class="set-row" style="padding-left:44px"><div><div>Voice design</div><div class="small muted" style="font-weight:400">Create new voices from a written description (Qwen3-TTS 1.7B VoiceDesign).</div></div>
            ${s.qwen.can_design ? html`<span class="badge green">Installed</span>` : html`<span class="badge">Not downloaded</span>`}</div>
          <div class="set-row" style="padding-left:44px"><div><div>Voice changer</div><div class="small muted" style="font-weight:400">Changes the voice in a recording while keeping its timing and emotion (OpenVoice V2).</div></div>
            ${s.qwen.can_convert ? html`<span class="badge green">Installed</span>` : html`<span class="badge">Not installed</span>`}</div>
          <div class="set-row" style="padding-left:44px"><div><div>Accurate transcription</div><div class="small muted" style="font-weight:400">Whisper Large v3 Turbo: punctuation, 99 languages and the detected language.</div></div>
            ${s.qwen.can_transcribe ? html`<span class="badge green">Installed</span>` : html`<span class="badge">Not installed</span>`}</div>
          <div class="set-row" style="padding-left:44px"><div><div>Speaker detection</div><div class="small muted" style="font-weight:400">Labels who said what in transcripts (ECAPA speaker model).</div></div>
            ${s.qwen.can_diarize ? html`<span class="badge green">Installed</span>` : html`<span class="badge">Not installed</span>`}</div>
          <div class="set-row" style="padding-left:44px"><div><div>Voice isolation</div><div class="small muted" style="font-weight:400">Removes music and background noise from recordings (Demucs), without an ElevenLabs key.</div></div>
            ${s.qwen.can_isolate ? html`<span class="badge green">Installed</span>` : html`<span class="badge">Not installed</span>`}</div>
          <div class="row" style="gap:12px">${orb("elevenlabs-provider")}<div style="flex:1"><div class="h3">ElevenLabs</div><div class="small subtle">${s.elevenlabs.connected ? `Connected with key ${s.elevenlabs.key_hint}${s.elevenlabs.from_env ? " (from environment)" : ""}` : "Use your own API key for ElevenLabs voices, cloning, Scribe and voice isolation."}</div></div>
            ${s.elevenlabs.connected ? html`<span class="badge accent">Connected</span>` : ""}</div>
          ${s.elevenlabs.from_env ? "" : html`<form class="rows" data-form="el" style="margin-top:0">${s.elevenlabs.connected
            ? html`<button class="btn btn-danger" data-disconnect type="button" style="align-self:flex-start">Disconnect</button>`
            : html`<div class="field"><label for="st-key">API key</label><input class="input" id="st-key" name="elevenlabs_api_key" type="password" autocomplete="off" placeholder="sk_…" required>
              <span class="hint">Stored in this server's database and sent only to api.elevenlabs.io. The key is checked before it's saved.</span></div>
              <button class="btn btn-primary" style="align-self:flex-start">${icon("key")} Connect</button>`}</form>`}</div></section>
        <section class="card settings-section" id="appearance"><h2 class="h2">Appearance</h2><div class="rows"><div><div class="seg" data-themes>${["light", "dark"].map((t) => html`<button data-t="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`)}</div></div></div></section>
        <section class="card settings-section" id="api"><h2 class="h2">API</h2><p class="muted small">Resonant exposes an ElevenLabs-compatible REST API, so existing code can switch by changing the base URL. Set <span class="mono">RESONANT_API_KEY</span> on the server to require an <span class="mono">xi-api-key</span> header.</p>
          <div class="code" data-curl>curl -X POST "${base}/v1/text-to-speech/${s.default_voice_id}?output_format=mp3_44100_128" \\
  -H "Content-Type: application/json" \\
  -d '{"text": "Hello from Resonant!"}' --output hello.mp3</div>
          <div class="row wrap mt"><button class="btn btn-sm" data-copy-curl>${icon("copy")} Copy</button><span class="small subtle">Endpoints: /v1/text-to-speech, /v1/speech-to-text, /v1/speech-to-speech, /v1/sound-generation, /v2/voices, /v1/history, /v1/models</span></div></section>
        <section class="card settings-section" id="ai-apps"><h2 class="h2">Connect AI apps</h2>
          <p class="muted small">Let Claude, Cursor and other AI apps use Resonant through MCP. Ask them to read text aloud, make a dialogue or podcast, transcribe a recording, or design a voice, and the work happens here on this computer. Resonant has to be open while they use it.</p>
          <div data-mcp><p class="small subtle">Loading…</p></div></section>
        <section class="card settings-section" id="extension"><h2 class="h2">Browser extension</h2>
          <p class="muted small">Resonant Reader reads web pages and selected text aloud with your voices, in Chrome or Edge. It talks to this server, so nothing goes anywhere else, and readings appear in your history.</p>
          <ol class="steps small">
            <li>Download the extension and unzip it.</li>
            <li>Open <span class="mono">chrome://extensions</span> (or <span class="mono">edge://extensions</span>) and turn on <b>Developer mode</b>.</li>
            <li>Click <b>Load unpacked</b> and choose the <span class="mono">resonant-reader</span> folder.</li>
            <li>Click the Resonant icon in the toolbar. If this server isn't at <span class="mono">http://localhost:3000</span>, enter <span class="mono">${location.origin}</span> under <b>Server</b>, plus the API key if you set one.</li>
          </ol>
          <div class="row wrap mt"><a class="btn btn-sm" href="/api/extension.zip" download>${icon("download")} Download extension</a><span class="small subtle">Shortcuts: Alt+Shift+R reads the selection or the page, Alt+Shift+S stops.</span></div></section>
        <section class="card settings-section" id="data"><h2 class="h2">Data</h2><p class="muted small">All audio and transcripts are stored on this server in its data folder.</p>
          <button class="btn btn-danger" data-clear>${icon("trash")} Delete all history</button></section>
        <section class="card settings-section" id="computer"><h2 class="h2">This computer</h2>
          <p class="muted small">What each part of the studio can do on this machine.</p><div data-sys></div>
          <button class="btn btn-sm mt" data-speed>${icon("refresh")} Run the speed test again</button></section>
        <section class="card settings-section" id="about"><h2 class="h2">About</h2>
          <p class="muted small">Resonant <span data-version></span> runs open models on this computer. Each one has its own licence, listed here with the credit it asks for.</p>
          <h3 class="h3 mt">Models</h3>
          <div class="credits">${CREDIT_MODELS.map((m) => html`<div class="credit">
            <div class="credit-main"><a class="credit-name" href="${m.url}" target="_blank" rel="noopener">${m.name}</a><div class="small subtle">${m.use}. By ${m.by}.</div>
              ${m.attribution ? html`<div class="small credit-note">${m.attribution}</div>` : ""}
              ${m.caution ? html`<div class="small credit-caution">${m.caution}</div>` : ""}</div>
            <a class="badge ${m.caution ? "amber" : ""}" href="${LICENSE_URLS[m.license]}" target="_blank" rel="noopener">${m.license}</a></div>`)}</div>
          <details class="credits-more mt"><summary class="h3">Libraries (${CREDIT_LIBRARIES.length})</summary>
            <div class="credits">${CREDIT_LIBRARIES.map((l) => html`<div class="credit">
              <div class="credit-main"><a class="credit-name" href="${l.url}" target="_blank" rel="noopener">${l.name}</a><div class="small subtle">By ${l.by}.${l.note ? ` ${l.note}` : ""}</div>
                ${l.also ? html`<div class="small subtle"><a href="${l.also.url}" target="_blank" rel="noopener">${l.also.name}</a> is licensed under <a href="${LICENSE_URLS[l.also.license]}" target="_blank" rel="noopener">${l.also.license}</a>.</div>` : ""}</div>
              <a class="badge" href="${LICENSE_URLS[l.license]}" target="_blank" rel="noopener">${l.license}</a></div>`)}</div></details>
          <p class="small subtle mt">The same list, with links to every licence and to the source code of the GPL and LGPL parts, is in THIRD_PARTY_NOTICES.md in Resonant's folder.</p></section>
      </div></div></div>`);
    api("/api/health").then((h) => { const v = $("[data-version]", el); if (v && h.version) v.textContent = h.version; }).catch(() => {});
    renderSystem($("[data-sys]", el));
    renderMcp($("[data-mcp]", el));
    $("[data-speed]", el).onclick = async (e) => {
      setLoading(e.currentTarget, true, "Timing…");
      try { await api("/api/system/speed", { method: "POST" }); await renderSystem($("[data-sys]", el)); toast("Speed test done"); }
      catch (err) { toastError(err); }
      finally { setLoading(e.currentTarget, false); }
    };

    const save = async (patch, msg = "Saved") => { try { await api("/api/settings", { method: "PATCH", json: patch }); toast(msg); await refreshShell(); return true; } catch (e) { toastError(e); return false; } };
    $$("form[data-form]", el).forEach((form) => form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(form));
      const btn = form.querySelector("button:not([type=button])");
      const kind = form.dataset.form;
      if (btn) setLoading(btn, true, kind === "el" || kind === "worker" ? "Connecting…" : "Saving…");
      if (kind === "usage") fd.character_limit = fd.character_limit === "" ? null : Number(fd.character_limit);
      if (kind === "worker" && !fd.qwen_remote_token && rw?.has_token) delete fd.qwen_remote_token; // keep the saved token
      const ok = await save(fd, kind === "el" ? "ElevenLabs connected" : kind === "worker" ? "GPU worker connected" : "Saved");
      if (btn) setLoading(btn, false);
      if (ok && (kind === "el" || kind === "worker")) { store.voices = null; store.models = null; settingsPage.render(el); }
      if (ok && form.dataset.form === "usage") refreshUsage();
    });
    $$("[data-qsize] [data-size]", el).forEach((b) => b.onclick = async () => {
      if (b.classList.contains("active")) return;
      if (await save({ qwen_size: b.dataset.size }, `Qwen3-TTS switched to ${b.dataset.size}. The next generation loads it.`)) {
        store.voices = null; store.models = null;
        settingsPage.render(el);
      }
    });
    $$("[data-where] [data-w]", el).forEach((b) => b.onclick = async () => {
      if (b.classList.contains("active")) return;
      if (b.dataset.w === "remote") {
        $$("[data-where] [data-w]", el).forEach((x) => x.classList.toggle("active", x === b));
        const f = $("[data-form=worker]", el);
        f.hidden = false;
        f.querySelector("input").focus();
        return;
      }
      if (!rw) { $("[data-form=worker]", el).hidden = true; $$("[data-where] [data-w]", el).forEach((x) => x.classList.toggle("active", x === b)); return; }
      if (await save({ qwen_remote_url: "" }, "Back to this computer")) { store.voices = null; store.models = null; settingsPage.render(el); }
    });
    const wcheck = $("[data-wcheck]", el);
    if (wcheck) wcheck.onclick = async () => {
      setLoading(wcheck, true, "Checking…");
      try { await api("/api/worker/check", { method: "POST" }); store.voices = null; await refreshShell(); settingsPage.render(el); } catch (e) { toastError(e); setLoading(wcheck, false); }
    };
    const disc = $("[data-disconnect]", el);
    if (disc) disc.onclick = async () => {
      if (!(await confirmDialog("Disconnect ElevenLabs?", "ElevenLabs voices and models will no longer be available. Your history is kept.", "Disconnect"))) return;
      if (await save({ elevenlabs_api_key: "" }, "Disconnected")) { store.voices = null; store.models = null; settingsPage.render(el); }
    };
    const markTheme = () => { let t = "light"; try { t = localStorage.getItem("theme") === "dark" ? "dark" : "light"; } catch {} $$("[data-t]", el).forEach((b) => b.classList.toggle("active", b.dataset.t === t)); };
    $$("[data-t]", el).forEach((b) => b.onclick = () => {
      try { localStorage.setItem("theme", b.dataset.t); } catch {}
      if (b.dataset.t === "dark") document.documentElement.dataset.theme = "dark"; else delete document.documentElement.dataset.theme;
      markTheme();
      refreshShell();
    });
    markTheme();
    $("[data-copy-curl]", el).onclick = async () => { try { await navigator.clipboard.writeText($("[data-curl]", el).textContent); toast("Copied"); } catch { toast("Couldn't access the clipboard.", "error"); } };
    $("[data-clear]", el).onclick = async () => {
      if (!(await confirmDialog("Delete all history?", "Every generated audio file will be permanently deleted. This can't be undone.", "Delete everything"))) return;
      try { const r = await api("/api/data/clear-history", { method: "POST" }); toast(`Deleted ${r.deleted} items`); refreshUsage(); } catch (e) { toastError(e); }
    };
  },
};

const notFound = {
  notFound: true,
  title: "Not found",
  render(el) {
    el.innerHTML = String(html`<div class="page-inner"><div class="nf"><span class="art">${icon("search")}</span><div><h1>We couldn't find that page</h1><p>The link may be out of date. Try reloading, or head back home.</p><a class="btn btn-primary" href="/app/home" data-link>Back to Home</a></div></div></div>`);
  },
};

export const pages = [home, tts, dialoguePage, pronunciationPage, dubbingList, dubbingEditor, studioList, studioProject, voiceChanger, voiceDesign, soundEffects, speechToText, voiceIsolator, voiceLibrary, myVoices, historyPage, settingsPage, notFound];
