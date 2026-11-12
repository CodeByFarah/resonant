// Tool pages: Voice Changer, Voice Design, Sound Effects, Speech to Text, Voice Isolator, History.
import {
  html, raw, $, $$, icon, api, store, orb, toast, toastError, modal, confirmDialog, pickVoice, providerBadge,
  player, playHistory, toWav, audioInput, startRecording, download, fmtTime, fmtAgo, fmtNum, navigate, refreshUsage, setTopbar,
} from "./app.js";
import { ls, cap, SOURCE_LABEL, setLoading, elapsedLabel, postAudio, slider, wireSliders, chevron, historyList } from "./pages.js";

const fileDuration = (file) => new Promise((resolve) => {
  const a = new Audio();
  a.preload = "metadata";
  a.onloadedmetadata = () => { resolve(isFinite(a.duration) ? a.duration : 0); URL.revokeObjectURL(a.src); };
  a.onerror = () => resolve(0);
  a.src = URL.createObjectURL(file);
});

// Small anchored panel that closes on outside click or Escape.
function popover(anchor, content, onMount) {
  document.querySelector(".popover")?.remove();
  const el = document.createElement("div");
  el.className = "popover";
  el.innerHTML = String(content);
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  el.style.top = `${r.top - h - 8 > 8 ? r.top - h - 8 : r.bottom + 8}px`;
  const close = () => { el.remove(); document.removeEventListener("mousedown", out, true); document.removeEventListener("keydown", esc); };
  const out = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === "Escape") close(); };
  setTimeout(() => { document.addEventListener("mousedown", out, true); document.addEventListener("keydown", esc); });
  onMount?.(el, close);
  return close;
}

// ====================================================================== Voice Changer
export const voiceChanger = {
  match: /^\/app\/voice-changer$/,
  title: "Voice Changer",
  async render(el) {
    const [settings, voices, models] = await Promise.all([store.loadSettings(), store.loadVoices(), store.loadModels()]);
    const canConvert = Boolean(settings.qwen?.can_convert), canIsolate = Boolean(settings.qwen?.can_isolate);
    const state = { voice_id: ls.get("sts_voice", settings.default_voice_id), speed: 1, stability: 0.5, similarity_boost: 0.75, style: 0, remove_background_noise: false, model_id: "eleven_multilingual_sts_v2",
      mode: canConvert ? ls.get("sts_mode", "convert") : "revoice" };
    if (!store.voice(state.voice_id)) state.voice_id = voices[0]?.voice_id;
    let tab = "settings";
    el.innerHTML = String(html`<div class="studio">
      <div class="studio-main">
        <div class="studio-editor center"><div style="width:min(392px,100%)" data-input></div><div data-transcript style="width:min(392px,100%);margin-top:12px"></div></div>
        <div class="studio-bar" style="border-top:none"><span class="small muted" data-dur>0:00 total duration</span><span class="grow"></span><button class="btn btn-primary btn-md" data-go disabled>Generate speech</button></div>
        <div class="studio-foot" data-usage-line>${icon("history")} <span></span></div>
      </div>
      <aside class="studio-side"><div class="tabs"><button class="tab active" data-tab="settings">Settings</button><button class="tab" data-tab="history">History</button></div>
        <div class="side-body" data-side></div></aside></div>`);
    const go = $("[data-go]", el);
    const side = $("[data-side]", el);
    const input = audioInput($("[data-input]", el), {
      onChange: async (f) => {
        go.disabled = !f;
        $("[data-dur]", el).textContent = `${fmtTime(f ? await fileDuration(f) : 0)} total duration`;
      },
    });
    api("/v1/user/subscription").then((sub) => {
      $("[data-usage-line] span", el).textContent = sub.character_limit
        ? `${fmtNum(Math.max(0, sub.character_limit - sub.character_count))} characters remaining this month`
        : `${fmtNum(sub.character_count)} characters used this month · no limit`;
    }).catch(() => {});
    const stsModels = models.filter((m) => m.provider === "elevenlabs" && m.can_do_voice_conversion);
    const renderSettings = () => {
      const v = store.voice(state.voice_id);
      const isEl = v?.provider === "elevenlabs";
      side.innerHTML = String(html`
        <div class="field"><span class="label">Voice</span><button class="voice-select" data-voice>${orb(state.voice_id, "sm")}<span class="name">${v?.name || "Select a voice"}</span>${providerBadge(v)}${chevron()}</button></div>
        ${isEl ? html`
          ${stsModels.length ? html`<div class="field"><label for="sts-model">Model</label><select class="select model-select" id="sts-model" data-model>${stsModels.map((m) => html`<option value="${m.model_id}" ${m.model_id === state.model_id ? raw("selected") : ""}>${m.name}</option>`)}</select></div>` : ""}
          ${slider({ key: "stability", label: "Stability", min: 0, max: 1, step: 0.01, value: state.stability, left: "More variable", right: "More stable" })}
          ${slider({ key: "similarity_boost", label: "Similarity", min: 0, max: 1, step: 0.01, value: state.similarity_boost, left: "Low", right: "High" })}
          ${slider({ key: "style", label: "Style exaggeration", min: 0, max: 1, step: 0.01, value: state.style, left: "None", right: "Exaggerated" })}
          <label class="toggle-row"><span>Remove background noise</span><span class="switch"><input type="checkbox" data-noise ${state.remove_background_noise ? raw("checked") : ""}><span></span></span></label>`
        : html`${canConvert ? html`<div class="field"><span class="label">Method</span><div><div class="seg" data-mode>
              <button data-m="convert" class="${state.mode === "convert" ? "active" : ""}">Change voice</button><button data-m="revoice" class="${state.mode === "revoice" ? "active" : ""}">Re-speak words</button></div></div></div>` : ""}
          ${state.mode === "revoice" && v?.provider !== "qwen" ? slider({ key: "speed", label: "Speed", min: 0.7, max: 1.2, step: 0.01, value: state.speed, left: "Slower", right: "Faster" }) : ""}
          ${state.mode === "convert" && canIsolate ? html`<label class="toggle-row"><span>Remove background noise</span><span class="switch"><input type="checkbox" data-noise ${state.remove_background_noise ? raw("checked") : ""}><span></span></span></label>` : ""}
          ${state.mode === "convert"
            ? html`<div class="notice">${icon("info")}<div><b>Keeps your timing and emotion.</b> Only the voice changes: the words, pace, pauses and feeling all come from your recording. Clean recordings work best, and cloned voices give the closest likeness.</div></div>`
            : html`<div class="notice">${icon("info")}<div><b>Re-speaks your words.</b> The recording is transcribed, then spoken again in the target voice, so the wording is kept but timing and emotion are not.${canConvert ? " Use Change voice to keep them." : ""}</div></div>`}`}`);
      wireSliders(side, state);
      $("[data-voice]", side).onclick = async () => { const id = await pickVoice(state.voice_id); if (id) { state.voice_id = id; ls.set("sts_voice", id); renderSettings(); } };
      const n = $("[data-noise]", side); if (n) n.onchange = () => { state.remove_background_noise = n.checked; };
      const m = $("[data-model]", side); if (m) m.onchange = () => { state.model_id = m.value; };
      $$("[data-mode] [data-m]", side).forEach((b) => b.onclick = () => { state.mode = b.dataset.m; ls.set("sts_mode", state.mode); renderSettings(); });
    };
    const setTab = (t) => {
      tab = t;
      $$("[data-tab]", el).forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
      side.onclick = null;
      if (t === "settings") renderSettings(); else historyList(side, { source: "STS", empty: "Converted audio will appear here." });
    };
    $$("[data-tab]", el).forEach((b) => b.onclick = () => setTab(b.dataset.tab));
    renderSettings();
    go.onclick = async () => {
      const v = store.voice(state.voice_id);
      if (!input.file || !v) return;
      setLoading(go, true, "Converting…");
      const stop = elapsedLabel(go, "Converting…");
      try {
        const form = new FormData();
        const isEl = v.provider === "elevenlabs";
        const f = input.file;
        // The local server decodes WAV/MP3 only, so convert other formats in the browser first: at 44.1 kHz
        // for Change voice (it keeps detail up to 11 kHz), 16 kHz is enough when the words are re-spoken.
        const passthrough = isEl || /\.(wav|mp3)$/i.test(f.name);
        const rate = state.mode === "convert" ? 44100 : 16000;
        form.set("audio", passthrough ? f : (await toWav(f, rate)).blob, passthrough ? f.name : f.name.replace(/\.\w+$/, "") + ".wav");
        form.set("voice_settings", JSON.stringify(isEl ? { stability: state.stability, similarity_boost: state.similarity_boost, style: state.style } : { speed: state.speed }));
        if (isEl) { form.set("model_id", state.model_id); form.set("remove_background_noise", String(state.remove_background_noise)); }
        else { form.set("mode", state.mode); if (state.mode === "convert") form.set("remove_background_noise", String(state.remove_background_noise && canIsolate)); }
        const out = await postAudio(`/v1/speech-to-speech/${encodeURIComponent(v.voice_id)}`, { body: form });
        player.play({ url: out.url, downloadUrl: `/v1/history/${out.historyId}/audio?download=1`, title: v.name, subtitle: "Voice changer", voiceId: v.voice_id });
        $("[data-transcript]", el).innerHTML = out.transcript ? String(html`<div class="notice">${icon("info")}<div><b>Heard:</b> “${decodeURIComponent(out.transcript)}”</div></div>`) : "";
        if (tab === "history") setTab("history");
        refreshUsage();
      } catch (e) { toastError(e); } finally { stop(); setLoading(go, false); }
    };
    return () => input.destroy();
  },
};

// ====================================================================== Voice Design
// [chip label, description]
const DESIGN_EXAMPLES = [
  ["Radio host", "A warm, deep male voice in his fifties, calm and reassuring, like a late-night radio host."],
  ["Upbeat presenter", "A bright, energetic young woman with a fast pace and a friendly American accent."],
  ["British storyteller", "An elderly British storyteller, soft and slightly raspy, speaking slowly with gentle pauses."],
  ["News anchor", "A confident news anchor, female, clear and formal with crisp pronunciation."],
];
const DESIGN_LANGS = ["auto", "english", "chinese", "japanese", "korean", "german", "french", "russian", "portuguese", "spanish", "italian"];

// The same card the "Design a voice" dialog used, shown as its own page.
export const voiceDesign = {
  match: /^\/app\/voice-design$/,
  title: "Voice Design",
  async render(el) {
    const settings = await store.loadSettings();
    if (!settings.qwen?.can_design) {
      el.innerHTML = String(html`<div class="page-inner"><div class="page-head"><h1 class="h1">Voice Design</h1></div>
        <div class="notice">${icon("info")}<div><b>Voice design isn't installed.</b> It needs the Qwen3-TTS 1.7B VoiceDesign model. See Settings → Providers and the README's Qwen3-TTS section.</div></div></div>`);
      return;
    }
    let preview = null;
    el.innerHTML = String(html`<div class="page-inner"><div class="modal wide" style="margin:24px auto;max-height:none" role="region" aria-label="Design a voice">
      <div class="modal-head"><h2 class="h2">Design a voice</h2></div>
      <div class="modal-body"><div class="field"><label for="vd-desc">Describe the voice</label><textarea class="textarea" id="vd-desc" data-desc maxlength="1000" style="min-height:90px" placeholder="Age, gender, tone, accent, pace… e.g. A calm, deep male narrator with a slight British accent." autofocus></textarea>
          <div class="chips" style="gap:6px">${DESIGN_EXAMPLES.map(([label], i) => html`<button class="chip" data-ex="${i}" style="height:26px;font-size:12px">${label}</button>`)}</div></div>
        <div class="field"><label for="vd-text">Preview text <span class="subtle">(optional)</span></label><textarea class="textarea" id="vd-text" data-text maxlength="500" style="min-height:60px" placeholder="Leave empty to use a standard sample sentence."></textarea></div>
        <div class="set-row"><label for="vd-lang">Language</label><select class="select" id="vd-lang" data-lang>${DESIGN_LANGS.map((l) => html`<option value="${l}">${l === "auto" ? "Detect from text" : cap(l)}</option>`)}</select></div>
        <div data-result></div>
        <div class="notice">${icon("info")}<div>Runs on this computer with the 1.7B model, so a preview takes a minute or two. The first one also loads the model.</div></div></div>
      <div class="modal-foot"><button class="btn btn-md" data-gen>${icon("sparkle")} Generate preview</button><button class="btn btn-primary btn-md" data-save disabled>Save voice</button></div>
    </div></div>`);
    const desc = $("[data-desc]", el), gen = $("[data-gen]", el), save = $("[data-save]", el), result = $("[data-result]", el);
    $$("[data-ex]", el).forEach((b) => b.onclick = () => { desc.value = DESIGN_EXAMPLES[b.dataset.ex][1]; desc.focus(); });
    gen.onclick = async () => {
      if (desc.value.trim().length < 10) return toast("Describe the voice in a bit more detail.", "error");
      setLoading(gen, true, "Designing…");
      const stop = elapsedLabel(gen, "Designing…");
      try {
        const out = await api("/v1/text-to-voice/design", { method: "POST", json: { voice_description: desc.value.trim(), text: $("[data-text]", el).value.trim() || undefined, language: $("[data-lang]", el).value } });
        preview = out.previews[0];
        save.disabled = true;
        const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(preview.audio_base_64), (c) => c.charCodeAt(0))], { type: preview.media_type }));
        result.innerHTML = String(html`<div class="file-pill">${orb(preview.generated_voice_id)}<span class="grow"><div class="h3">Preview ready</div><div class="small subtle">${preview.duration_secs.toFixed(1)} s · “${out.text.slice(0, 70)}${out.text.length > 70 ? "…" : ""}”</div></span><button class="icon-btn" data-play aria-label="Play preview">${icon("play")}</button></div>
          <div class="field mt"><label for="vd-name">Voice name</label><input class="input" id="vd-name" data-name maxlength="100" placeholder="e.g. Midnight Narrator"></div>`);
        $("[data-play]", result).onclick = () => player.play({ url, title: "Designed voice preview", subtitle: desc.value.trim(), voiceId: preview.generated_voice_id });
        player.play({ url, title: "Designed voice preview", subtitle: desc.value.trim(), voiceId: preview.generated_voice_id });
        const name = $("[data-name]", result);
        name.oninput = () => { save.disabled = !name.value.trim(); };
        name.focus();
        gen.dataset.label = String(html`${icon("refresh")} Try again`);
      } catch (e) { toastError(e); } finally { stop(); setLoading(gen, false); }
    };
    save.onclick = async () => {
      const name = $("[data-name]", el)?.value.trim();
      if (!preview || !name) return;
      setLoading(save, true, "Saving…");
      try {
        await api("/v1/text-to-voice", { method: "POST", json: { voice_name: name, voice_description: desc.value.trim(), generated_voice_id: preview.generated_voice_id } });
        store.voices = null;
        toast("Voice saved to My Voices");
        navigate("/app/voice-lab");
      } catch (e) { toastError(e); setLoading(save, false); }
    };
  },
};

// ====================================================================== Sound Effects
const SFX_CATEGORIES = [
  ["Ambience", "wave", "linear-gradient(140deg,#1d3557,#457b9d 60%,#a8dadc)", "Quiet night ambience with crickets and a distant breeze"],
  ["Weather", "sfx", "linear-gradient(140deg,#2b2d42,#5c6378 55%,#8d99ae)", "Heavy rain on a tin roof with rolling thunder"],
  ["Nature", "globe", "linear-gradient(140deg,#264d36,#4f9d69 60%,#c7e9b0)", "Forest birdsong at dawn with a gentle stream"],
  ["Sci-fi", "sparkle", "linear-gradient(140deg,#240046,#7b2cbf 55%,#e0aaff)", "Spaceship engine humming with soft computer beeps"],
  ["Impacts", "megaphone", "linear-gradient(140deg,#370617,#9d0208 55%,#f48c06)", "Deep cinematic boom with a long reverb tail"],
  ["Music loops", "film", "linear-gradient(140deg,#03045e,#0077b6 55%,#90e0ef)", "Upbeat synthwave drum loop at 110 bpm"],
  ["Animals", "smile", "linear-gradient(140deg,#6f1d1b,#bb9457 60%,#ffe6a7)", "A cat purring softly, close up"],
  ["Foley", "book", "linear-gradient(140deg,#3d405b,#81b29a 60%,#f2cc8f)", "Footsteps on a wooden floor, slow and creaky"],
];
const SFX_SUGGESTIONS = ["Rain on a window", "Cat purring", "Crackling campfire", "Ocean waves", "Busy café chatter", "Thunder rolling", "Door creaking open", "Keyboard typing"];

function sfxRows(items, { empty }) {
  if (!items.length) return html`<div class="lt-empty">${empty}</div>`;
  const cols = "grid-template-columns:minmax(0,1fr) 90px 110px 84px";
  return html`<div class="lt-head" style="${cols}"><span>Description</span><span>Duration</span><span>Created</span><span></span></div>
    ${items.map((h) => html`<div class="lt-row" data-id="${h.history_item_id}" style="${cols}">
      <div class="cell-main"><button class="play-circle" data-play aria-label="Play">${icon("play")}</button><div><div class="ti">${h.text}</div><div class="su">${h.model_id === "musicgen_small" ? "MusicGen · local" : h.model_id}${h.settings?.loop ? " · loop" : ""}</div></div></div>
      <span class="num">${h.duration ? `${h.duration.toFixed(1)}s` : "—"}</span><span class="num">${fmtAgo(h.date_unix)}</span>
      <div class="acts"><a class="icon-btn" href="/v1/history/${h.history_item_id}/audio?download=1" download title="Download" aria-label="Download">${icon("download")}</a><button class="icon-btn" data-del title="Delete" aria-label="Delete">${icon("trash")}</button></div></div>`)}`;
}

export const soundEffects = {
  match: /^\/app\/sound-effects$/,
  title: "Sound Effects",
  async render(el, { query }) {
    const [models, settings] = await Promise.all([store.loadModels(), store.loadSettings()]);
    const options = [...models.filter((m) => m.provider === "local" && m.can_do_sound_effects), ...(settings.elevenlabs.connected ? [{ model_id: "eleven_text_to_sound_v2", name: "Eleven Sound Effects v2" }] : [])];
    const state = { auto: true, duration_seconds: 5, prompt_influence: 0.3, loop: false, model_id: options[0].model_id, tab: query.get("tab") === "history" ? "history" : "explore", q: "" };
    const crumbs = () => setTopbar("Sound Effects", [["Sound Effects", "/app/sound-effects"], state.tab === "history" ? "History" : "Explore"]);
    crumbs();
    el.innerHTML = String(html`<div class="page-inner" style="max-width:1000px">
      <div class="page-head" style="margin-bottom:16px"><h1 class="h1">Sound Effects</h1></div>
      <div class="tabs"><button class="tab" data-tab="explore">Explore</button><button class="tab" data-tab="history">History</button></div>
      <div data-body style="min-height:40vh"></div>
      <div class="composer-wrap"><form class="composer" data-comp>
        <div class="sugg" data-sugg></div>
        <textarea data-prompt rows="1" maxlength="1000" placeholder="Describe a sound…" aria-label="Sound description"></textarea>
        <div class="comp-bar">
          <select class="ghost-select" data-model aria-label="Model">${options.map((m) => html`<option value="${m.model_id}">${m.name}</option>`)}</select>
          <button type="button" class="ghost-pill" data-loop title="Seamless loop">${icon("refresh")} <span>Off</span></button>
          <button type="button" class="ghost-pill" data-dur title="Duration">${icon("history")} <span>Auto</span></button>
          <button type="button" class="ghost-pill" data-infl title="Prompt influence">${icon("sparkle")} <span>30%</span></button>
          <span class="grow"></span><span class="small muted hide-sm" data-hint style="margin-right:8px"></span>
          <button class="send" data-go disabled aria-label="Generate">${icon("arrowUp")}</button>
        </div></form></div></div>`);
    const body = $("[data-body]", el);
    const prompt = $("[data-prompt]", el);
    const go = $("[data-go]", el);
    const onInput = () => {
      go.disabled = !prompt.value.trim();
      prompt.style.height = "auto";
      prompt.style.height = `${Math.min(prompt.scrollHeight, 160)}px`;
      $("[data-sugg]", el).hidden = Boolean(prompt.value.trim());
    };
    const renderSugg = () => {
      const picks = [...SFX_SUGGESTIONS].sort(() => Math.random() - 0.5).slice(0, 3);
      $("[data-sugg]", el).innerHTML = String(html`${picks.map((s) => html`<button type="button" class="chip" data-s="${s}">${icon("sfx")} ${s}</button>`)}`);
      $$("[data-s]", el).forEach((b) => b.onclick = () => { prompt.value = b.dataset.s; onInput(); prompt.focus(); });
    };
    const updHint = () => {
      $("[data-hint]", el).textContent = state.model_id === "musicgen_small" ? `~${Math.round((state.auto ? 5 : state.duration_seconds) * 4)}s on this computer` : "Uses ElevenLabs credits";
      $("[data-loop] span", el).textContent = state.loop ? "On" : "Off";
      $("[data-loop]", el).classList.toggle("on", state.loop);
      $("[data-dur] span", el).textContent = state.auto ? "Auto" : `${state.duration_seconds}s`;
      $("[data-infl] span", el).textContent = `${Math.round(state.prompt_influence * 100)}%`;
    };
    prompt.oninput = onInput;
    prompt.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("[data-comp]", el).requestSubmit(); } };
    $("[data-model]", el).onchange = (e) => { state.model_id = e.target.value; updHint(); };
    $("[data-loop]", el).onclick = () => { state.loop = !state.loop; updHint(); };
    $("[data-dur]", el).onclick = (e) => popover(e.currentTarget, html`<div class="stack">
        <label class="toggle-row"><span>Automatic duration</span><span class="switch"><input type="checkbox" data-a ${state.auto ? raw("checked") : ""}><span></span></span></label>
        <div data-sl ${state.auto ? raw("hidden") : ""}>${slider({ key: "duration_seconds", label: "Duration", min: 0.5, max: 30, step: 0.5, value: state.duration_seconds, left: "0.5s", right: "30s" })}</div></div>`,
      (p) => { wireSliders(p, state, (v) => `${v}s`); $("[data-a]", p).onchange = (ev) => { state.auto = ev.target.checked; $("[data-sl]", p).hidden = state.auto; updHint(); }; p.addEventListener("input", updHint); });
    $("[data-infl]", el).onclick = (e) => popover(e.currentTarget, slider({ key: "prompt_influence", label: "Prompt influence", min: 0, max: 1, step: 0.01, value: state.prompt_influence, left: "More creative", right: "Follow prompt" }),
      (p) => { wireSliders(p, state); p.addEventListener("input", updHint); });

    const load = async () => {
      let items = [];
      try { items = (await api("/v1/history?source=SFX&page_size=200")).history; } catch (e) { toastError(e); }
      $$("[data-tab]", el).forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
      if (state.tab === "explore") {
        body.innerHTML = String(html`<div style="position:relative;margin-top:24px"><button class="icon-btn outline" data-scroll="1" aria-label="Scroll right" style="position:absolute;right:8px;top:61px;z-index:2;border-radius:50%">${icon("chevron")}</button>
          <div class="cats" data-cats style="gap:8px">${SFX_CATEGORIES.map(([n, ic, bg], i) => html`<button class="cat-tile" data-cat="${i}" style="background:${bg}"><span class="lb">${icon(ic)} ${n}</span></button>`)}</div></div>
          <div class="section-head"><h2 class="h2">Recent sounds</h2>${items.length > 6 ? html`<button class="btn btn-ghost" data-all>View all</button>` : ""}</div>
          <div class="ltable" data-list>${sfxRows(items.slice(0, 6), { empty: "Your generated sounds will appear here." })}</div>`);
        $$("[data-scroll]", body).forEach((b) => b.onclick = () => $("[data-cats]", body).scrollBy({ left: Number(b.dataset.scroll) * 332, behavior: "smooth" }));
        $$("[data-cat]", body).forEach((b) => b.onclick = () => { prompt.value = SFX_CATEGORIES[b.dataset.cat][3]; onInput(); prompt.focus(); });
        $("[data-all]", body)?.addEventListener("click", () => { state.tab = "history"; crumbs(); load(); });
      } else {
        const list = items.filter((h) => !state.q || h.text.toLowerCase().includes(state.q));
        body.innerHTML = String(html`<div class="search mt">${icon("search")}<input class="input" data-q placeholder="Search sound effects…" value="${state.q}" aria-label="Search sound effects"></div>
          <div class="ltable" data-list>${sfxRows(list, { empty: state.q ? "No sounds match." : "Your generated sounds will appear here." })}</div>`);
        const qi = $("[data-q]", body);
        qi.oninput = () => {
          state.q = qi.value.trim().toLowerCase();
          const pos = qi.selectionStart;
          load().then(() => { const n = $("[data-q]", body); n?.focus(); n?.setSelectionRange(pos, pos); });
        };
      }
      const byId = Object.fromEntries(items.map((h) => [h.history_item_id, h]));
      $("[data-list]", body).onclick = async (e) => {
        const row = e.target.closest("[data-id]");
        if (!row) return;
        const h = byId[row.dataset.id];
        if (e.target.closest("[data-play]")) { playHistory(h); player.audio.loop = Boolean(h.settings?.loop); }
        else if (e.target.closest("[data-del]")) {
          if (!(await confirmDialog("Delete sound?", "This permanently removes the audio."))) return;
          try { await api(`/v1/history/${h.history_item_id}`, { method: "DELETE" }); toast("Deleted"); load(); } catch (err) { toastError(err); }
        }
      };
    };
    $$("[data-tab]", el).forEach((b) => b.onclick = () => {
      state.tab = b.dataset.tab;
      history.replaceState({}, "", state.tab === "history" ? "?tab=history" : location.pathname);
      crumbs();
      load();
    });
    $("[data-comp]", el).onsubmit = async (e) => {
      e.preventDefault();
      const text = prompt.value.trim();
      if (!text || go.disabled) return;
      go.disabled = true;
      go.innerHTML = '<span class="spinner"></span>';
      try {
        const out = await postAudio("/v1/sound-generation", { json: { text, model_id: state.model_id, duration_seconds: state.auto ? null : state.duration_seconds, prompt_influence: state.prompt_influence, loop: state.loop } });
        await player.play({ url: out.url, downloadUrl: `/v1/history/${out.historyId}/audio?download=1`, title: text, subtitle: state.loop ? "Sound effect · looping" : "Sound effect", voiceId: text });
        player.audio.loop = state.loop;
        prompt.value = "";
        onInput();
        renderSugg();
        load();
      } catch (err) { toastError(err); } finally { go.innerHTML = String(icon("arrowUp")); go.disabled = !prompt.value.trim(); }
    };
    renderSugg();
    updHint();
    await load();
    return () => { player.audio.loop = false; document.querySelector(".popover")?.remove(); };
  },
};

// ====================================================================== Speech to Text
const LANGS = [["", "Detect"], ["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"], ["nl", "Dutch"], ["pl", "Polish"], ["ru", "Russian"], ["uk", "Ukrainian"], ["tr", "Turkish"], ["ar", "Arabic"], ["hi", "Hindi"], ["ja", "Japanese"], ["ko", "Korean"], ["zh", "Chinese"], ["sv", "Swedish"], ["id", "Indonesian"], ["vi", "Vietnamese"]];
const sessionAudio = new Map(); // transcription_id -> object URL, kept for this tab session

// "speaker_0" -> "Speaker 1"
const speakerName = (id) => `Speaker ${Number(String(id).replace(/\D+/g, "") || 0) + 1}`;
const speakerIds = (words) => [...new Set(words.filter((w) => w.type === "word").map((w) => w.speaker_id || "speaker_0"))];
// Consecutive words by the same speaker, for the transcript view and TXT export.
function speakerTurns(words) {
  const turns = [];
  words.forEach((w, i) => {
    if (w.type !== "word") return;
    const id = w.speaker_id || "speaker_0";
    if (turns.at(-1)?.speaker !== id) turns.push({ speaker: id, start: w.start, items: [] });
    turns.at(-1).items.push(i);
  });
  return turns;
}

function toSrt(words) {
  const ws = words.filter((w) => w.type === "word");
  const many = speakerIds(words).length > 1;
  const cues = [];
  let cur = [];
  for (const w of ws) {
    if (cur.length && many && w.speaker_id !== cur[0].speaker_id) { cues.push(cur); cur = []; }
    cur.push(w);
    if (cur.length >= 10 || cur.at(-1).end - cur[0].start > 4 || /[.!?]$/.test(w.text)) { cues.push(cur); cur = []; }
  }
  if (cur.length) cues.push(cur);
  const ts = (s) => { const ms = Math.round(s * 1000); const p = (n, l = 2) => String(n).padStart(l, "0"); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
  return cues.map((c, i) => `${i + 1}\n${ts(c[0].start)} --> ${ts(c.at(-1).end)}\n${many ? `[${speakerName(c[0].speaker_id)}] ` : ""}${c.map((w) => w.text).join(" ")}\n`).join("\n");
}
function toTxt(t) {
  const words = t.words || [];
  if (speakerIds(words).length < 2) return t.text;
  return speakerTurns(words).map((turn) => `${speakerName(turn.speaker)}: ${turn.items.map((i) => words[i].text).join(" ")}`).join("\n\n");
}

const STT_NAME = { whisper_base: "Whisper Base", whisper_large_v3_turbo: "Whisper Large v3 Turbo" };
// What each transcription model is good at, shown under the model picker.
const STT_HINT = {
  whisper_base: "Fastest. Good for clear speech; no punctuation guarantees and no detected language.",
  whisper_large_v3_turbo: "Most accurate, with punctuation and the detected language. About as long as the audio on this computer; much faster on a GPU worker.",
};
function transcribeDialog(sttModels, settings) {
  let file = null;
  let rec = null;
  let timer = null;
  let mode = "upload";
  const canDiarize = (id) => (id.startsWith("scribe") ? true : Boolean(settings.qwen?.can_diarize));
  const saved = ls.get("stt_prefs", {});
  const firstModel = sttModels.some((m) => m.model_id === saved.model_id) ? saved.model_id : (sttModels.find((m) => m.model_id === "whisper_large_v3_turbo") || sttModels[0])?.model_id;
  modal({
    title: "Transcribe files",
    body: html`<div><div class="seg pills" data-modes><button class="active" data-m="upload">Upload</button><button data-m="record">Record</button></div></div>
      <div data-src></div>
      <div class="set-row"><label for="stt-lang">Primary language</label><select class="select" id="stt-lang" data-lang>${LANGS.map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></div>
      <div class="set-row"><label for="stt-model">Model</label><select class="select" id="stt-model" data-model>${sttModels.map((m) => html`<option value="${m.model_id}" ${m.model_id === firstModel ? raw("selected") : ""}>${m.name}</option>`)}</select></div>
      <div class="small muted" data-hint style="margin-top:-6px"></div>
      <div data-diar></div>`,
    foot: html`<button class="btn btn-primary btn-md" data-go disabled>${icon("upload")} Transcribe</button>`,
    onClose: () => { clearInterval(timer); rec?.stop(); },
    onMount: (m, close) => {
      const src = $("[data-src]", m);
      const go = $("[data-go]", m);
      const renderSrc = () => {
        clearInterval(timer);
        go.disabled = !file;
        if (file) {
          src.innerHTML = String(html`<div class="file-pill">${icon("wave")}<span class="grow"><div class="h3" style="overflow:hidden;text-overflow:ellipsis">${file.name}</div><div class="small subtle">${(file.size / 1024 / 1024).toFixed(2)} MB</div></span><button class="icon-btn" data-clear aria-label="Remove file">${icon("x")}</button></div>`);
          $("[data-clear]", src).onclick = () => { file = null; renderSrc(); };
          return;
        }
        if (mode === "upload") {
          src.innerHTML = String(html`<div class="iso-drop" data-drop role="button" tabindex="0" style="border:1px solid var(--border-input);background:var(--bg)">${icon("upload")}<span style="text-align:left"><span style="color:var(--fg);font-weight:500;display:block">Click or drag files here to upload</span><span class="small">Audio and video files, up to 50 MB</span></span><input type="file" accept="audio/*,video/*" hidden data-file></div>`);
          const drop = $("[data-drop]", src), fi = $("[data-file]", src);
          drop.onclick = (e) => { if (e.target !== fi) fi.click(); };
          fi.onchange = () => { if (fi.files[0]) { file = fi.files[0]; renderSrc(); } };
          drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
          drop.ondragleave = () => drop.classList.remove("over");
          drop.ondrop = (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) { file = e.dataTransfer.files[0]; renderSrc(); } };
        } else {
          src.innerHTML = String(html`<div class="iso-drop" style="flex-direction:column;gap:12px"><button class="play-circle" data-rec style="width:48px;height:48px" aria-label="${rec ? "Stop recording" : "Start recording"}">${rec ? html`<span class="rec-dot"></span>` : icon("mic")}</button><span data-t>${rec ? "Recording… 0:00" : "Press to start recording"}</span></div>`);
          $("[data-rec]", src).onclick = async () => {
            try {
              if (rec) { file = await rec.stop(); rec = null; renderSrc(); return; }
              rec = await startRecording();
              renderSrc();
            } catch (e) { toastError(e); }
          };
          if (rec) timer = setInterval(() => { const t = $("[data-t]", src); if (t && rec) t.textContent = `Recording… ${fmtTime((Date.now() - rec.started) / 1000)}`; }, 250);
        }
      };
      $$("[data-m]", m).forEach((b) => b.onclick = () => { mode = b.dataset.m; $$("[data-m]", m).forEach((x) => x.classList.toggle("active", x === b)); renderSrc(); });
      renderSrc();
      // Speaker detection: a switch, then how many speakers (or let it work that out).
      const modelSel = $("[data-model]", m), diar = $("[data-diar]", m);
      let diarOn = Boolean(saved.diarize), speakers = saved.num_speakers || "";
      const renderDiar = () => {
        const id = modelSel.value;
        $("[data-hint]", m).textContent = STT_HINT[id] || "";
        if (!canDiarize(id)) { diar.innerHTML = ""; return; }
        diar.innerHTML = String(html`<label class="toggle-row" style="font-weight:400"><span>Detect speakers <span class="small subtle">labels who said what</span></span><span class="switch"><input type="checkbox" data-diarize ${diarOn ? raw("checked") : ""}><span></span></span></label>
          ${diarOn ? html`<div class="set-row" style="margin-top:8px"><label for="stt-spk">Number of speakers</label><select class="select" id="stt-spk" data-spk><option value="">Detect automatically</option>${[2, 3, 4, 5, 6, 8].map((n) => html`<option value="${n}" ${String(n) === String(speakers) ? raw("selected") : ""}>${n}</option>`)}</select></div>` : ""}`);
        $("[data-diarize]", diar).onchange = (e) => { diarOn = e.target.checked; renderDiar(); };
        const spk = $("[data-spk]", diar);
        if (spk) spk.onchange = () => { speakers = spk.value; };
      };
      modelSel.onchange = renderDiar;
      renderDiar();
      go.onclick = async () => {
        if (!file) return;
        setLoading(go, true, "Preparing audio…");
        let stop = () => {};
        try {
          const model_id = $("[data-model]", m).value;
          const form = new FormData();
          let upload = file, name = file.name;
          if (!model_id.startsWith("scribe") && !/\.(wav|mp3)$/i.test(file.name)) { upload = (await toWav(file)).blob; name = file.name.replace(/\.\w+$/, "") + ".wav"; }
          form.set("file", upload, name);
          form.set("model_id", model_id);
          const lang = $("[data-lang]", m).value;
          if (lang) form.set("language_code", lang);
          const useDiar = diarOn && canDiarize(model_id);
          if (useDiar) { form.set("diarize", "true"); if (speakers) form.set("num_speakers", speakers); }
          ls.set("stt_prefs", { model_id, diarize: diarOn, num_speakers: speakers });
          setLoading(go, false);
          setLoading(go, true, "Transcribing…");
          stop = elapsedLabel(go, "Transcribing…");
          const t = await api("/v1/speech-to-text", { method: "POST", body: form });
          sessionAudio.set(t.transcription_id, URL.createObjectURL(file));
          close();
          navigate(`/app/speech-to-text/${t.transcription_id}`);
        } catch (e) { toastError(e); } finally { stop(); setLoading(go, false); }
      };
    },
  });
}

export const speechToText = {
  match: /^\/app\/speech-to-text(?:\/([\w-]+))?$/,
  title: "Speech to Text",
  crumbs: [["Speech to text", "/app/speech-to-text"], "Transcriptions"],
  async render(el, { params }) {
    if (params[0]) return renderTranscript(el, params[0]);
    const [models, settings, { transcripts }] = await Promise.all([store.loadModels(), store.loadSettings(), api("/api/transcripts")]);
    const sttModels = [...models.filter((m) => m.can_do_speech_to_text && m.provider === "local"), ...(settings.elevenlabs.connected ? [{ model_id: "scribe_v2", name: "Scribe v2 (ElevenLabs)" }] : [])];
    let q = "";
    el.innerHTML = String(html`<div class="page-inner" style="max-width:1000px">
      <div class="page-head" style="margin-bottom:12px"><div><h1 class="h1">Speech to text</h1><p>Transcribe audio and video on this computer, with word-level timestamps.</p></div>
        <button class="btn btn-primary btn-md" data-new>${icon("stt")} Transcribe files</button></div>
      <div class="tabs"><span class="tab active">Transcriptions</span></div>
      <div class="search mt">${icon("search")}<input class="input" data-q placeholder="Search transcripts…" aria-label="Search transcripts"></div>
      <div class="ltable" data-list></div></div>`);
    const list = $("[data-list]", el);
    const cols = "grid-template-columns:minmax(0,1fr) 90px 130px 44px";
    const dots = raw('<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>');
    const render = () => {
      const items = transcripts.filter((t) => !q || `${t.file_name} ${t.preview}`.toLowerCase().includes(q));
      list.innerHTML = items.length ? String(html`<div class="lt-head" style="${cols}"><span>Title</span><span>Duration</span><span>Created at</span><span></span></div>
        ${items.map((t) => html`<div class="lt-row link" data-id="${t.transcription_id}" style="${cols}"><div class="cell-main"><span class="file-circle">${icon("stt")}</span><div><div class="ti">${t.file_name || "Transcript"}</div><div class="su">${t.preview || ""}</div></div></div>
          <span class="num">${t.duration ? fmtTime(t.duration) : "—"}</span><span class="num">${fmtAgo(t.date_unix)}</span>
          <div class="acts"><button class="icon-btn" data-menu-row aria-label="More actions">${dots}</button></div></div>`)}`)
        : String(html`<div class="lt-empty">${q ? "No transcripts match." : html`No transcripts yet. <a href="#" data-new2 style="text-decoration:underline;color:var(--fg)">Transcribe your first file</a>.`}</div>`);
      $("[data-new2]", list)?.addEventListener("click", (e) => { e.preventDefault(); transcribeDialog(sttModels, settings); });
    };
    list.onclick = (e) => {
      const row = e.target.closest("[data-id]");
      if (!row) return;
      const id = row.dataset.id;
      const menu = e.target.closest("[data-menu-row]");
      if (!menu) return navigate(`/app/speech-to-text/${id}`);
      popover(menu, html`<div class="stack" style="gap:2px;margin:-6px"><button class="vp-row" data-open>${icon("stt")} Open</button><button class="vp-row" data-del style="color:var(--danger)">${icon("trash")} Delete</button></div>`, (p, close) => {
        $("[data-open]", p).onclick = () => { close(); navigate(`/app/speech-to-text/${id}`); };
        $("[data-del]", p).onclick = async () => {
          close();
          if (!(await confirmDialog("Delete transcript?", "This permanently removes the transcript."))) return;
          try {
            await api(`/v1/speech-to-text/transcripts/${id}`, { method: "DELETE" });
            transcripts.splice(transcripts.findIndex((t) => t.transcription_id === id), 1);
            render();
            toast("Deleted");
          } catch (err) { toastError(err); }
        };
      });
    };
    $("[data-q]", el).oninput = (e) => { q = e.target.value.trim().toLowerCase(); render(); };
    $("[data-new]", el).onclick = () => transcribeDialog(sttModels, settings);
    render();
    return () => document.querySelector(".popover")?.remove();
  },
};

async function renderTranscript(el, id) {
  let t;
  try { t = await api(`/v1/speech-to-text/transcripts/${id}`); } catch (e) { el.innerHTML = String(html`<div class="page-inner"><div class="notice warn">${e.message}</div></div>`); return; }
  const audioUrl = sessionAudio.get(id);
  const words = t.words || [];
  setTopbar(t.file_name || "Transcript", [["Speech to text", "/app/speech-to-text"], t.file_name || "Transcript"]);
  el.innerHTML = String(html`<div class="page-inner page-narrow">
    <div class="page-head"><div style="min-width:0"><h1 class="h1" style="overflow-wrap:anywhere">${t.file_name || "Transcript"}</h1>
      <p>${[t.duration ? fmtTime(t.duration) : null, t.language_code ? t.language_code.toUpperCase() : null, speakerIds(words).length > 1 ? `${speakerIds(words).length} speakers` : null, STT_NAME[t.model_id] || t.model_id, new Date(t.date_unix * 1000).toLocaleString()].filter(Boolean).join(" · ")}</p></div>
      <div class="row wrap">${audioUrl ? html`<button class="btn" data-play>${icon("play")} Play</button>` : ""}
        <button class="btn" data-copy>${icon("copy")} Copy</button><button class="btn" data-exp="txt">TXT</button><button class="btn" data-exp="srt">SRT</button><button class="btn" data-exp="json">JSON</button>
        <button class="icon-btn outline" data-del title="Delete transcript" aria-label="Delete transcript">${icon("trash")}</button></div></div>
    ${audioUrl ? html`<p class="small muted">Click any word to jump to it.</p>` : html`<div class="notice">${icon("info")}<div>Audio isn't stored with transcripts, so playback and word sync work only in the browser session where you uploaded the file.</div></div>`}
    <div class="card card-pad mt transcript" data-text>${!words.length ? t.text || html`<span class="subtle">No speech detected.</span>`
      : speakerIds(words).length > 1
        ? speakerTurns(words).map((turn) => html`<div class="turn"><div class="who spk-${Number(turn.speaker.replace(/\D+/g, "") || 0) % 6}">${speakerName(turn.speaker)} <span class="subtle">${fmtTime(turn.start)}</span></div>
            <p>${turn.items.map((i, k) => html`${k ? " " : ""}<span class="w" data-i="${i}" title="${fmtTime(words[i].start)}">${words[i].text}</span>`)}</p></div>`)
        : words.map((w, i) => (w.type === "word" ? html`<span class="w" data-i="${i}" title="${fmtTime(w.start)}">${w.text}</span>` : raw(" ")))}</div></div>`);
  const textEl = $("[data-text]", el);
  const base = (t.file_name || "transcript").replace(/\.\w+$/, "");
  $("[data-copy]", el).onclick = async () => { try { await navigator.clipboard.writeText(t.text); toast("Copied to clipboard"); } catch { toast("Couldn't access the clipboard.", "error"); } };
  $$("[data-exp]", el).forEach((b) => b.onclick = () => {
    const kind = b.dataset.exp;
    const body = kind === "txt" ? toTxt(t) : kind === "srt" ? toSrt(words) : JSON.stringify({ text: t.text, language_code: t.language_code, words }, null, 2);
    download(URL.createObjectURL(new Blob([body], { type: kind === "json" ? "application/json" : "text/plain" })), `${base}.${kind}`);
  });
  $("[data-del]", el).onclick = async () => {
    if (!(await confirmDialog("Delete transcript?", "This permanently removes the transcript."))) return;
    try { await api(`/v1/speech-to-text/transcripts/${id}`, { method: "DELETE" }); sessionAudio.delete(id); navigate("/app/speech-to-text"); } catch (e) { toastError(e); }
  };
  if (!audioUrl) return;
  const playIt = (at = 0) => {
    if (player.item?.url !== audioUrl) player.play({ url: audioUrl, title: t.file_name, subtitle: "Transcript audio" });
    player.seek(at);
  };
  $("[data-play]", el).onclick = () => playIt(0);
  textEl.onclick = (e) => { const w = e.target.closest("[data-i]"); if (w) playIt(words[w.dataset.i].start); };
  let last = null;
  const onTime = (e) => {
    if (e.detail.item?.url !== audioUrl) return;
    const i = words.findIndex((w) => w.type === "word" && e.detail.t >= w.start && e.detail.t < w.end + 0.05);
    if (i === -1) return;
    const span = textEl.querySelector(`[data-i="${i}"]`);
    if (span === last) return;
    last?.classList.remove("now");
    span?.classList.add("now");
    last = span;
  };
  document.addEventListener("player:time", onTime);
  return () => document.removeEventListener("player:time", onTime);
}

// ====================================================================== Voice Isolator
export const voiceIsolator = {
  match: /^\/app\/voice-isolator$/,
  title: "Voice Isolator",
  async render(el) {
    const s = await store.loadSettings();
    const connected = s.elevenlabs.connected;
    const localOk = s.qwen.can_isolate;
    const gpu = Boolean(s.qwen.remote?.connected);
    let provider = ls.get("iso_provider", localOk ? "local" : "elevenlabs");
    if (provider === "local" && !localOk) provider = "elevenlabs";
    if (provider === "elevenlabs" && !connected && localOk) provider = "local";
    const usable = () => (provider === "local" ? localOk : connected);
    let file = null;
    let rec = null;
    let q = "";
    el.innerHTML = String(html`<div class="page-inner" style="max-width:1000px">
      <div class="page-head" style="margin-bottom:12px"><h1 class="h1">Voice Isolator</h1></div>
      <div class="composer" style="width:100%;padding:4px">
        <div class="iso-drop" data-drop role="button" tabindex="0" style="min-height:112px;align-items:flex-start;padding-top:12px">Drop files here</div>
        <input type="file" accept="audio/*,video/*" hidden data-file>
        <div class="comp-bar" style="padding-top:6px">
          <button class="icon-btn" data-up title="Upload a file" aria-label="Upload a file">${icon("upload")}</button>
          <button class="icon-btn" data-rec title="Record" aria-label="Record">${icon("mic")}</button>
          <span class="grow"></span>
          ${localOk && connected ? html`<div class="seg" data-iso-prov style="margin-right:8px"><button data-p="local">${gpu ? "GPU worker" : "This computer"}</button><button data-p="elevenlabs">ElevenLabs</button></div>` : ""}
          <span class="small muted" style="margin-right:8px" data-iso-hint></span>
          <button class="send" data-go disabled aria-label="Isolate voice">${icon("arrowUp")}</button></div></div>
      <div class="search" style="margin-top:48px">${icon("search")}<input class="input" data-q placeholder="Search history" aria-label="Search history"></div>
      <div class="ltable" data-list></div></div>`);
    const drop = $("[data-drop]", el), fi = $("[data-file]", el), go = $("[data-go]", el), recBtn = $("[data-rec]", el);
    const showProvider = () => {
      $$("[data-iso-prov] [data-p]", el).forEach((b) => b.classList.toggle("active", b.dataset.p === provider));
      const hint = $("[data-iso-hint]", el);
      if (provider === "local" && localOk) hint.textContent = gpu ? "Runs on your GPU worker" : localOk && connected ? "Free · about 3× the clip's length" : "Runs on this computer · about 3× the clip's length";
      else if (connected) hint.textContent = "Uses ElevenLabs credits";
      else hint.innerHTML = String(html`Needs Demucs or an <a href="/app/settings#providers" data-link style="text-decoration:underline">ElevenLabs key</a>`);
      go.disabled = !file || !usable();
    };
    $$("[data-iso-prov] [data-p]", el).forEach((b) => b.onclick = () => { provider = b.dataset.p; ls.set("iso_provider", provider); showProvider(); });
    const setFile = (f) => {
      file = f;
      drop.innerHTML = f ? String(html`${icon("wave")} <span style="color:var(--fg);font-weight:500">${f.name}</span> <span class="small">${(f.size / 1024 / 1024).toFixed(2)} MB</span>`) : "Drop files here";
      go.disabled = !f || !usable();
    };
    showProvider();
    drop.onclick = () => fi.click();
    drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fi.click(); } };
    $("[data-up]", el).onclick = () => fi.click();
    fi.onchange = () => fi.files[0] && setFile(fi.files[0]);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); };
    recBtn.onclick = async () => {
      try {
        if (rec) { setFile(await rec.stop()); rec = null; recBtn.innerHTML = String(icon("mic")); return; }
        rec = await startRecording();
        recBtn.innerHTML = '<span class="rec-dot"></span>';
        drop.textContent = "Recording… press the microphone again to stop";
      } catch (e) { toastError(e); }
    };
    const cols = "grid-template-columns:minmax(0,1fr) 100px 80px 44px";
    const load = async () => {
      let items = [];
      try { items = (await api("/v1/history?source=VOICE_ISOLATOR&page_size=200")).history; } catch {}
      const list = items.filter((h) => !q || (h.text || "").toLowerCase().includes(q));
      $("[data-list]", el).innerHTML = list.length ? String(html`<div class="lt-head" style="${cols}"><span>Name</span><span>Created</span><span>Format</span><span></span></div>
        ${list.map((h) => html`<div class="lt-row" data-id="${h.history_item_id}" style="${cols}"><div class="cell-main"><button class="play-circle" data-play aria-label="Play">${icon("play")}</button><div class="ti">${h.text || "Isolated audio"}</div></div>
          <span class="num">${fmtAgo(h.date_unix)}</span><span class="num">${(h.content_type || "").split("/")[1]?.replace("mpeg", "mp3") || "—"}</span>
          <div class="acts"><a class="icon-btn" href="/v1/history/${h.history_item_id}/audio?download=1" download title="Download" aria-label="Download">${icon("download")}</a></div></div>`)}`)
        : String(html`<div class="lt-empty">${q ? "Nothing matches." : "Cleaned-up audio will appear here."}</div>`);
      $("[data-list]", el).onclick = (e) => { const r = e.target.closest("[data-id]"); if (r && e.target.closest("[data-play]")) playHistory(items.find((h) => h.history_item_id === r.dataset.id)); };
    };
    $("[data-q]", el).oninput = (e) => { q = e.target.value.trim().toLowerCase(); load(); };
    go.onclick = async () => {
      if (!file) return;
      go.disabled = true;
      go.innerHTML = '<span class="spinner"></span>';
      const name = file.name;
      let tick = null;
      try {
        const form = new FormData();
        if (provider === "local") {
          // The server decodes WAV and MP3 only, so the browser converts the file. It recognises the
          // format from the bytes, so the original name is kept for History.
          const { blob, duration } = await toWav(file, 44100);
          if (duration > 15 * 60) throw new Error("Local isolation handles up to 15 minutes at a time. Trim the file and try again.");
          form.set("audio", blob, name);
          form.set("provider", "local");
          const est = Math.max(5, Math.round(duration * (gpu ? 0.3 : 3.2)));
          const t0 = Date.now();
          const show = () => { drop.innerHTML = String(html`<span class="spinner"></span> <span style="color:var(--fg)">Isolating the voice in ${name}…</span> <span class="small">${Math.round((Date.now() - t0) / 1000)} s of about ${fmtTime(est)}</span>`); };
          show();
          tick = setInterval(show, 1000);
        } else {
          form.set("audio", file, name);
          form.set("provider", "elevenlabs");
        }
        const out = await postAudio("/v1/audio-isolation", { body: form });
        player.play({ url: out.url, downloadUrl: `/v1/history/${out.historyId}/audio?download=1`, title: name, subtitle: "Isolated voice" });
        setFile(null);
        load();
      } catch (e) { toastError(e); setFile(file); } finally { clearInterval(tick); go.innerHTML = String(icon("arrowUp")); }
    };
    await load();
    return () => rec?.stop();
  },
};

// ====================================================================== History
const HISTORY_TYPES = [["", "All"], ["TTS", "Text to Speech"], ["DIALOGUE", "Dialogue"], ["STS", "Voice Changer"], ["SFX", "Sound Effects"], ["VOICE_ISOLATOR", "Voice Isolator"]];
export const historyPage = {
  match: /^\/app\/history$/,
  title: "History",
  async render(el) {
    const f = { source: "", search: "" };
    let items = [];
    let cursor = null;
    let hasMore = false;
    const selected = new Set();
    const cols = "grid-template-columns:28px minmax(0,1fr) 130px 70px 100px 150px";
    el.innerHTML = String(html`<div class="page-inner" style="max-width:1100px">
      <div class="page-head" style="margin-bottom:12px"><div><h1 class="h1">History</h1><p>Everything you've generated, stored on this server.</p></div></div>
      <div class="chips scroll" data-src>${HISTORY_TYPES.map(([k, l]) => html`<button class="chip lg ${k === "" ? "on" : ""}" data-s="${k}">${l}</button>`)}</div>
      <div class="search mt">${icon("search")}<input class="input" data-q placeholder="Search by text or voice…" aria-label="Search history"></div>
      <div class="bulkbar mt" data-bulk hidden><b data-n></b><span style="flex:1"></span><button class="btn" data-bdl>${icon("download")} Download</button><button class="btn btn-danger" data-bdel>${icon("trash")} Delete</button></div>
      <div class="ltable" data-list></div>
      <div class="row mt" style="justify-content:center"><button class="btn" data-more hidden>Load more</button></div></div>`);
    const list = $("[data-list]", el);
    const updBulk = () => {
      $("[data-bulk]", el).hidden = !selected.size;
      $("[data-n]", el).textContent = `${selected.size} selected`;
      const all = $("[data-all]", el);
      if (all) all.checked = items.length > 0 && selected.size === items.length;
    };
    const row = (h) => html`<div class="lt-row" data-id="${h.history_item_id}" style="${cols}">
      <input type="checkbox" data-sel ${selected.has(h.history_item_id) ? raw("checked") : ""} aria-label="Select">
      <div class="cell-main"><button class="play-circle" data-play aria-label="Play">${icon("play")}</button><div><div class="ti">${h.text || h.voice_name || "—"}</div><div class="su">${[h.voice_name, h.duration ? fmtTime(h.duration) : null, h.model_id].filter(Boolean).join(" · ")}</div></div></div>
      <span class="hide-sm"><span class="badge">${SOURCE_LABEL[h.source] || h.source}</span></span>
      <span class="num hide-sm">${fmtNum(h.character_count)}</span>
      <span class="num" title="${new Date(h.date_unix * 1000).toLocaleString()}">${fmtAgo(h.date_unix)}</span>
      <div class="acts">
        <button class="icon-btn" data-fb="up" title="Good result" aria-label="Rate good" style="${h.feedback?.thumbs_up === true ? "color:var(--success)" : ""}">${icon("thumbUp")}</button>
        <button class="icon-btn" data-fb="down" title="Bad result" aria-label="Rate bad" style="${h.feedback?.thumbs_up === false ? "color:var(--danger)" : ""}">${icon("thumbDown")}</button>
        <a class="icon-btn" href="/v1/history/${h.history_item_id}/audio?download=1" download title="Download" aria-label="Download">${icon("download")}</a>
        <button class="icon-btn" data-del title="Delete" aria-label="Delete">${icon("trash")}</button></div></div>`;
    const draw = () => {
      list.innerHTML = items.length ? String(html`<div class="lt-head" style="${cols}"><input type="checkbox" data-all aria-label="Select all"><span>Content</span><span class="hide-sm">Type</span><span class="hide-sm">Chars</span><span>Created</span><span></span></div>${items.map(row)}`)
        : String(html`<div class="lt-empty">No history${f.source || f.search ? " matches these filters" : " yet"}.</div>`);
      $("[data-more]", el).hidden = !hasMore;
      const all = $("[data-all]", el);
      if (all) all.onchange = (e) => { selected.clear(); if (e.target.checked) items.forEach((h) => selected.add(h.history_item_id)); $$("[data-sel]", list).forEach((c) => (c.checked = e.target.checked)); updBulk(); };
      updBulk();
    };
    const load = async (reset) => {
      if (reset) { items = []; cursor = null; selected.clear(); }
      const qs = new URLSearchParams({ page_size: 50 });
      if (f.source) qs.set("source", f.source);
      if (f.search) qs.set("search", f.search);
      if (cursor) qs.set("start_after_history_item_id", cursor);
      try {
        const data = await api(`/v1/history?${qs}`);
        items.push(...data.history);
        cursor = data.last_history_item_id;
        hasMore = data.has_more;
      } catch (e) { toastError(e); }
      draw();
    };
    $$("[data-s]", el).forEach((b) => b.onclick = () => { f.source = b.dataset.s; $$("[data-s]", el).forEach((x) => x.classList.toggle("on", x === b)); load(true); });
    let deb;
    $("[data-q]", el).oninput = (e) => { clearTimeout(deb); deb = setTimeout(() => { f.search = e.target.value.trim(); load(true); }, 250); };
    $("[data-more]", el).onclick = () => load(false);
    list.addEventListener("click", async (e) => {
      const tr = e.target.closest("[data-id]");
      if (!tr) return;
      const h = items.find((x) => x.history_item_id === tr.dataset.id);
      if (e.target.closest("[data-sel]")) { e.target.checked ? selected.add(h.history_item_id) : selected.delete(h.history_item_id); updBulk(); }
      else if (e.target.closest("[data-play]")) playHistory(h);
      else if (e.target.closest("[data-fb]")) {
        const up = e.target.closest("[data-fb]").dataset.fb === "up";
        try { await api(`/api/history/${h.history_item_id}/feedback`, { method: "POST", json: { thumbs_up: up } }); h.feedback = { thumbs_up: up }; tr.outerHTML = String(row(h)); toast("Thanks for the feedback"); } catch (err) { toastError(err); }
      } else if (e.target.closest("[data-del]")) {
        if (!(await confirmDialog("Delete item?", "This permanently removes the audio."))) return;
        try { await api(`/v1/history/${h.history_item_id}`, { method: "DELETE" }); items = items.filter((x) => x !== h); selected.delete(h.history_item_id); draw(); refreshUsage(); } catch (err) { toastError(err); }
      }
    });
    $("[data-bdl]", el).onclick = async (e) => {
      const btn = e.currentTarget;
      setLoading(btn, true, "Preparing…");
      try {
        const res = await api("/v1/history/download", { method: "POST", json: { history_item_ids: [...selected] }, raw: true });
        const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "")?.[1] || "history.zip";
        download(URL.createObjectURL(await res.blob()), name);
      } catch (err) { toastError(err); } finally { setLoading(btn, false); }
    };
    $("[data-bdel]", el).onclick = async () => {
      if (!(await confirmDialog(`Delete ${selected.size} items?`, "This permanently removes the selected audio."))) return;
      let failed = 0;
      for (const id of selected) { try { await api(`/v1/history/${id}`, { method: "DELETE" }); } catch { failed++; } }
      toast(failed ? `Deleted with ${failed} error(s)` : "Deleted", failed ? "error" : "");
      load(true);
      refreshUsage();
    };
    await load(true);
  },
};
