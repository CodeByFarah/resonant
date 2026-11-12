// Dubbing: a list of dubs, a "new dub" dialog, and the editor (preview, speakers, lines, export).
// Only the audio goes to the server; the video stays in this browser (IndexedDB) for the preview
// and for exporting a dubbed video.
import {
  html, raw, $, $$, icon, api, store, orb, toast, toastError, modal, confirmDialog, pickVoice, toWav, download, fmtTime, fmtAgo, navigate, setTopbar,
} from "./app.js";
import { ls, setLoading, voiceLabel } from "./pages.js";

const STAGE = {
  queued: "Waiting to start", transcribing: "Transcribing and finding speakers", translating: "Translating",
  separating: "Separating the background", voicing: "Sampling each speaker's voice", dubbing: "Voicing the lines", mixing: "Mixing",
  done: "Ready", failed: "Failed", cancelled: "Stopped",
};
const MAX_VIDEO = 2 * 1024 ** 3;

// ---------- video kept in this browser ----------
const idb = () => new Promise((resolve, reject) => {
  const r = indexedDB.open("resonant-dubbing", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("videos");
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
async function saveVideo(id, file) {
  try {
    const db = await idb();
    await new Promise((res, rej) => { const t = db.transaction("videos", "readwrite"); t.objectStore("videos").put(file, id); t.oncomplete = res; t.onerror = () => rej(t.error); });
    return true;
  } catch { return false; }
}
async function loadVideo(id) {
  try { const db = await idb(); return await new Promise((res) => { const g = db.transaction("videos").objectStore("videos").get(id); g.onsuccess = () => res(g.result || null); g.onerror = () => res(null); }); } catch { return null; }
}
async function dropVideo(id) {
  try { const db = await idb(); db.transaction("videos", "readwrite").objectStore("videos").delete(id); } catch {}
}
const isVideo = (f) => f && (f.type?.startsWith("video/") || /\.(mp4|mov|webm|mkv|m4v|avi)$/i.test(f.name || ""));

let metaCache = null;
const meta = async () => (metaCache ||= await api("/api/dubbing/meta"));

// ====================================================================== List
export const dubbingList = {
  match: /^\/app\/dubbing$/,
  title: "Dubbing",
  async render(el) {
    let timer = null;
    const load = async () => {
      clearTimeout(timer);
      const { dubs } = await api("/api/dubbing");
      el.innerHTML = String(html`<div class="page-inner">
        <div class="page-head"><div><h1 class="h1">Dubbing</h1><p>Translate the speech in a video or recording into another language, in the speakers' own voices.</p></div>
          <button class="btn btn-primary btn-md" data-new>${icon("plus")} New dub</button></div>
        ${dubs.length ? html`<div class="card dub-list">${dubs.map((d) => html`<a class="dub-row" href="/app/dubbing/${d.dub_id}" data-link>
            <span class="dub-ic">${icon("film")}</span>
            <span class="grow"><span class="h3 clip">${d.title}</span>
              <span class="small subtle">${d.source_name || "Detecting"} → ${d.target_name} · ${fmtTime(d.duration)}${d.speakers.length ? ` · ${d.speakers.length} speaker${d.speakers.length === 1 ? "" : "s"}` : ""}</span></span>
            ${d.busy ? html`<span class="badge accent">${STAGE[d.status]}${d.status !== "queued" ? ` · ${Math.round(stageShare(d) * 100)}%` : ""}</span>`
              : d.status === "failed" ? html`<span class="badge red">Failed</span>`
              : d.outdated_count ? html`<span class="badge amber">${d.outdated_count} change${d.outdated_count === 1 ? "" : "s"} to apply</span>`
              : html`<span class="small subtle">${fmtAgo(d.updated_unix)}</span>`}</a>`)}</div>`
          : html`<div class="card studio-empty"><span class="art">${icon("film")}</span><h2 class="h2">Dub your first video</h2>
            <p class="muted">Upload a video or recording. Resonant finds who speaks when, translates every line, and speaks it in each speaker's own voice, keeping the music and sound behind them.</p>
            <button class="btn btn-primary btn-md" data-new>${icon("plus")} New dub</button></div>`}</div>`);
      $$("[data-new]", el).forEach((b) => b.onclick = () => newDubDialog());
      if (dubs.some((d) => d.busy)) timer = setTimeout(() => load().catch(() => {}), 3000);
    };
    await load();
    return () => clearTimeout(timer);
  },
};

async function newDubDialog() {
  const m = await meta();
  await store.loadVoices();
  let file = null;
  let voiceMode = m.can_clone ? "original" : "pick";
  let voiceId = ls.get("dub_voice", null);
  const lastTarget = ls.get("dub_target", "es");
  const voiceRow = () => {
    const v = store.voice(voiceId);
    return voiceMode === "original"
      ? html`<span class="hint">Each speaker keeps their own voice, cloned from their lines (Qwen3-TTS).</span>`
      : html`<button type="button" class="chip lg" data-voice style="justify-content:flex-start">${v ? html`${orb(v.voice_id, "xs")} ${voiceLabel(v)}` : "Choose a voice…"}</button>
        <span class="hint">Every speaker gets this voice; you can change each one later. Kokoro voices speak English only.</span>`;
  };
  modal({
    title: "New dub",
    wide: true,
    body: html`<div class="dub-drop" data-drop tabindex="0" role="button" aria-label="Choose a file"><span class="ib">${icon("upload")}</span>
        <div class="t" data-fname>Choose a video or audio file</div><div class="s" data-fsub>MP4, MOV, WebM, MP3, WAV… up to ${m.max_seconds / 60} minutes</div>
        <input type="file" accept="video/*,audio/*" data-file hidden></div>
      <div class="dub-grid">
        <div class="field"><label for="dub-src">Original language</label><select class="select" id="dub-src" data-src>
          ${m.can_detect ? html`<option value="">Detect</option>` : ""}${m.languages.map((l) => html`<option value="${l.code}" ${!m.can_detect && l.code === "en" ? raw("selected") : ""}>${l.name}</option>`)}</select></div>
        <div class="field"><label for="dub-tgt">Dub into</label><select class="select" id="dub-tgt" data-tgt>${m.languages.map((l) => html`<option value="${l.code}" ${l.code === lastTarget ? raw("selected") : ""}>${l.name}</option>`)}</select></div>
        ${m.can_diarize ? html`<div class="field"><label for="dub-n">Speakers</label><select class="select" id="dub-n" data-n><option value="">Detect</option>${[1, 2, 3, 4, 5, 6].map((n) => html`<option value="${n}">${n}</option>`)}</select></div>` : ""}
      </div>
      <span class="hint" data-trhint style="margin-top:-6px"></span>
      <div class="field"><span class="label">Voices</span>
        ${m.can_clone ? html`<div><div class="seg" data-vmode><button type="button" data-m="original" class="active">Keep original voices</button><button type="button" data-m="pick">Use a library voice</button></div></div>` : ""}
        <div data-vrow class="rows" style="gap:6px">${voiceRow()}</div></div>
      ${m.can_separate ? html`<label class="toggle-row"><span>Keep music and background sound<span class="small muted" style="display:block;font-weight:400">Separates the voices from everything else, then puts the new voices on top.</span></span><span class="switch"><input type="checkbox" data-bg checked><span></span></span></label>` : ""}
      <div class="notice">${icon("info")}<div>Without a GPU, dubbing takes several minutes per minute of speech, longer when keeping the original voices. You can leave this page while it works.</div></div>`,
    foot: html`<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-create disabled>Start dubbing</button>`,
    onMount: (box, close) => {
      const createBtn = $("[data-create]", box);
      const fileIn = $("[data-file]", box);
      const drop = $("[data-drop]", box);
      const ready = () => { createBtn.disabled = !file || (voiceMode === "pick" && !store.voice(voiceId)); };
      const setFile = (f) => {
        if (!f) return;
        if (f.size > MAX_VIDEO) return toast("That file is larger than 2 GB.", "error");
        file = f;
        $("[data-fname]", box).textContent = f.name;
        $("[data-fsub]", box).textContent = `${(f.size / 1024 / 1024).toFixed(1)} MB · ${isVideo(f) ? "video" : "audio"}`;
        drop.classList.add("has");
        ready();
      };
      drop.onclick = () => fileIn.click();
      drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileIn.click(); } };
      fileIn.onchange = () => setFile(fileIn.files[0]);
      drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
      drop.ondragleave = () => drop.classList.remove("over");
      drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); setFile(e.dataTransfer.files[0]); };
      const wireVoice = () => {
        const b = $("[data-voice]", box);
        if (b) b.onclick = async () => { const id = await pickVoice(voiceId); if (id) { voiceId = id; ls.set("dub_voice", id); $("[data-vrow]", box).innerHTML = String(voiceRow()); wireVoice(); ready(); } };
      };
      $$("[data-vmode] [data-m]", box).forEach((b) => b.onclick = () => {
        voiceMode = b.dataset.m;
        $$("[data-vmode] [data-m]", box).forEach((x) => x.classList.toggle("active", x === b));
        $("[data-vrow]", box).innerHTML = String(voiceRow()); wireVoice(); ready();
      });
      wireVoice();
      // Says which model will translate, so a rougher pair (into Japanese or Korean) isn't a surprise.
      const trHint = () => {
        const a = $("[data-src]", box).value, b = $("[data-tgt]", box).value;
        const name = a && m.translators?.[`${a}>${b}`];
        $("[data-trhint]", box).textContent = !a ? (b === "en" ? "" : "The translation model depends on the language detected.")
          : a === b ? "Same language: the words stay as they are; only the voices change."
          : name === "M2M100 418M" ? "Translated with M2M100, which is rougher for this pair. Check the lines in the editor before exporting."
          : name ? `Translated with ${name}.` : "";
      };
      $("[data-src]", box).onchange = $("[data-tgt]", box).onchange = trHint;
      trHint();
      createBtn.onclick = async () => {
        setLoading(createBtn, true, "Reading the audio…");
        try {
          const { blob: wav, duration } = await toWav(file, 24000);
          if (duration > m.max_seconds + 1) throw new Error(`This file is ${fmtTime(duration)} long. Dubbing takes up to ${m.max_seconds / 60} minutes; trim it first.`);
          createBtn.lastChild.textContent = " Uploading…";
          const form = new FormData();
          form.set("file", wav, `${file.name.replace(/\.[^.]+$/, "")}.wav`);
          form.set("title", file.name.replace(/\.[^.]+$/, ""));
          form.set("source_lang", $("[data-src]", box).value);
          form.set("target_lang", $("[data-tgt]", box).value);
          ls.set("dub_target", $("[data-tgt]", box).value);
          const n = $("[data-n]", box)?.value;
          if (n) form.set("num_speakers", n);
          if (voiceMode === "pick") form.set("voice_id", voiceId);
          const bg = $("[data-bg]", box);
          form.set("keep_background", bg ? String(bg.checked) : "false");
          const d = await api("/api/dubbing", { method: "POST", body: form });
          if (isVideo(file)) await saveVideo(d.dub_id, file);
          close();
          navigate(`/app/dubbing/${d.dub_id}`);
        } catch (e) { toastError(e); setLoading(createBtn, false); }
      };
    },
  });
}

// Share of the whole job done, for progress bars.
const STAGE_SPAN = { queued: [0, 0], transcribing: [0, 0.15], translating: [0.15, 0.3], separating: [0.3, 0.4], voicing: [0.4, 0.45], dubbing: [0.45, 0.95], mixing: [0.95, 1] };
function stageShare(d) {
  const [a, b] = STAGE_SPAN[d.status] || [1, 1];
  return a + (b - a) * (d.progress || 0);
}

// ====================================================================== Editor
export const dubbingEditor = {
  match: /^\/app\/dubbing\/([\w-]+)$/,
  title: "Dubbing",
  crumbs: [["Dubbing", "/app/dubbing"], "Dub"],
  async render(el, { params: [id] }) {
    let d;
    try { d = await api(`/api/dubbing/${id}`); } catch {
      el.innerHTML = String(html`<div class="page-inner"><div class="notice warn">${icon("info")}<div><b>That dub isn't here.</b> It may have been deleted. <a href="/app/dubbing" data-link>Back to Dubbing</a></div></div></div>`);
      return;
    }
    const m = await meta();
    await store.loadVoices();
    let video = await loadVideo(id);
    let videoUrl = video ? URL.createObjectURL(video) : null;
    let timer = null;
    let mode = "dub"; // which sound the preview plays
    const crumbs = () => setTopbar(d.title, [["Dubbing", "/app/dubbing"], d.title]);
    crumbs();

    el.innerHTML = String(html`<div class="page-inner dub-page">
      <div class="dub-head"><input class="dub-title" data-title maxlength="120" aria-label="Title">
        <span class="small muted" data-langs></span><span class="grow"></span>
        <div class="row" style="gap:8px"><button class="icon-btn" data-del title="Delete dub" aria-label="Delete dub">${icon("trash")}</button>
          <button class="btn btn-md" data-export>${icon("download")} Export</button>
          <button class="btn btn-primary btn-md" data-apply>Apply changes</button></div></div>
      <div data-status></div>
      <div class="dub-top">
        <div class="card dub-preview" data-preview></div>
        <div class="card dub-speakers"><div class="h3">Speakers</div><div data-speakers class="rows" style="gap:8px"></div></div>
      </div>
      <div class="card dub-lines"><div class="dub-lines-head"><div class="h3 grow">Lines</div><span class="small muted" data-lcount></span></div><div data-lines></div></div></div>`);
    const titleIn = $("[data-title]", el);
    titleIn.onchange = async () => {
      const t = titleIn.value.trim();
      if (!t) { titleIn.value = d.title; return; }
      try { d = await api(`/api/dubbing/${id}`, { method: "PATCH", json: { title: t } }); crumbs(); } catch (e) { toastError(e); }
    };
    const audioUrl = () => `/api/dubbing/${id}/audio?format=wav&v=${d.updated_unix}`;
    const spkIndex = (sid) => Math.max(0, d.speakers.findIndex((s) => s.speaker_id === sid)) % 6;

    // ---------- status ----------
    const renderStatus = () => {
      if (document.activeElement !== titleIn) titleIn.value = d.title;
      $("[data-langs]", el).textContent = `${d.source_name || "Detecting language"} → ${d.target_name} · ${fmtTime(d.duration)}`;
      const s = $("[data-status]", el);
      if (d.busy) {
        s.innerHTML = String(html`<div class="dub-progress"><span class="spinner"></span><div class="grow"><div class="h3">${STAGE[d.status]}${d.status !== "queued" && d.progress ? ` · ${Math.round(d.progress * 100)}%` : ""}</div>
          <div class="meter"><i style="width:${Math.round(stageShare(d) * 100)}%"></i></div></div><button class="btn btn-sm" data-cancel>Stop</button></div>`);
        $("[data-cancel]", s).onclick = async () => { await api(`/api/dubbing/${id}/cancel`, { method: "POST" }).catch(toastError); refresh(); };
      } else if (d.status === "failed") s.innerHTML = String(html`<div class="notice warn">${icon("info")}<div><b>Dubbing stopped with an error.</b> ${d.error || ""}</div></div>`);
      else if (d.status === "cancelled") s.innerHTML = String(html`<div class="notice">${icon("info")}<div>Stopped. Press Apply changes to carry on.</div></div>`);
      else s.innerHTML = "";
      const apply = $("[data-apply]", el);
      apply.disabled = d.busy || (d.status === "done" && !d.outdated_count);
      apply.textContent = d.busy ? "Working…" : d.status === "done" ? (d.outdated_count ? `Apply ${d.outdated_count} change${d.outdated_count === 1 ? "" : "s"}` : "Up to date") : "Apply changes";
      $("[data-export]", el).disabled = !d.has_audio;
    };

    // ---------- preview ----------
    const renderPreview = () => {
      const p = $("[data-preview]", el);
      if (!d.has_audio) mode = "orig";
      else if (!videoUrl) mode = "dub";
      p.innerHTML = String(html`${videoUrl ? html`<video data-video src="${videoUrl}" playsinline controls></video>`
          : html`<div class="dub-novideo">${icon("film")}<div class="small muted">${d.has_audio ? "Attach the original video to watch it with the new voices." : "Attach the original video to preview it here."}</div>
            <button class="btn btn-sm" data-attach>${icon("upload")} Attach video</button><input type="file" accept="video/*" data-vfile hidden></div>`}
        <audio data-dub preload="auto" ${d.has_audio ? raw(`src="${audioUrl()}"`) : ""} ${videoUrl || !d.has_audio ? "" : raw("controls")}></audio>
        ${videoUrl ? html`<div class="row" style="gap:8px;margin-top:10px"><div class="seg" data-mode><button data-m="dub" class="${mode === "dub" ? "active" : ""}" ${d.has_audio ? "" : raw("disabled")}>${d.target_name}</button><button data-m="orig" class="${mode === "orig" ? "active" : ""}">Original</button></div>
          <span class="grow"></span><button class="btn btn-sm btn-ghost" data-detach>${icon("x")} Remove video</button></div>` : ""}`);
      const v = $("[data-video]", p), a = $("[data-dub]", p);
      if (v) {
        const sync = () => { if (mode === "dub" && Math.abs(a.currentTime - v.currentTime) > 0.15) a.currentTime = v.currentTime; };
        const applyMode = () => { v.muted = mode === "dub"; if (mode !== "dub") a.pause(); else if (!v.paused) { sync(); a.play().catch(() => {}); } };
        v.onplay = () => { if (mode === "dub") { sync(); a.play().catch(() => {}); } };
        v.onpause = () => a.pause();
        v.onseeked = sync;
        v.ontimeupdate = () => { sync(); highlight(v.currentTime); };
        v.onratechange = () => { a.playbackRate = v.playbackRate; };
        applyMode();
        $$("[data-mode] [data-m]", p).forEach((b) => b.onclick = () => { mode = b.dataset.m; $$("[data-mode] [data-m]", p).forEach((x) => x.classList.toggle("active", x === b)); applyMode(); });
        $("[data-detach]", p).onclick = async () => { await dropVideo(id); URL.revokeObjectURL(videoUrl); video = null; videoUrl = null; renderPreview(); };
      } else {
        a.ontimeupdate = () => highlight(a.currentTime);
        const fi = $("[data-vfile]", p);
        $("[data-attach]", p).onclick = () => fi.click();
        fi.onchange = async () => {
          const f = fi.files[0];
          if (!f) return;
          video = f; videoUrl = URL.createObjectURL(f);
          if (!(await saveVideo(id, f))) toast("This browser couldn't keep the video; attach it again next time.");
          renderPreview();
        };
      }
    };
    const media = () => $("[data-video]", el) || ($("[data-dub]", el)?.src ? $("[data-dub]", el) : null);
    const seek = (t) => { const x = media(); if (!x) return; x.currentTime = t; if (x.paused) x.play().catch(() => {}); };
    let lastHi = null;
    const highlight = (t) => {
      const dub = mode === "dub";
      const seg = d.segments?.find((s) => t >= (dub ? s.placed_start ?? s.start : s.start) && t < (dub ? s.placed_end ?? s.end : s.end));
      if (seg?.seg_id === lastHi) return;
      lastHi = seg?.seg_id;
      $$(".dub-line.now", el).forEach((x) => x.classList.remove("now"));
      if (seg) $(`[data-seg="${seg.seg_id}"]`, el)?.classList.add("now");
    };

    // ---------- speakers ----------
    const renderSpeakers = () => {
      const box = $("[data-speakers]", el);
      if (box.contains(document.activeElement) && document.activeElement.matches("input")) return;
      if (!d.speakers.length) { box.innerHTML = String(html`<div class="small muted">Speakers appear once the audio is transcribed.</div>`); return; }
      box.innerHTML = String(html`${d.speakers.map((s, i) => {
        const v = s.voice_id ? store.voice(s.voice_id) : null;
        return html`<div class="dub-spk" data-sid="${s.speaker_id}"><span class="dlg-dot spk-${i % 6}"></span>
          <input class="input" data-sname value="${s.name}" maxlength="40" aria-label="Speaker name">
          <button class="voice-select" data-svoice ${d.busy ? raw("disabled") : ""} title="Change voice">${v ? html`${orb(v.voice_id, "xs")}<span class="name">${voiceLabel(v)}</span>` : html`<span class="dub-own">${icon("clone")}</span><span class="name">Own voice</span>`}</button>
          ${v && m.can_clone ? html`<button class="icon-btn" data-sown title="Use their own voice again" aria-label="Use their own voice" ${d.busy ? raw("disabled") : ""}>${icon("refresh")}</button>` : html`<span></span>`}</div>`;
      })}`);
      $$("[data-sid]", box).forEach((row) => {
        const sid = row.dataset.sid;
        const save = async (patch) => {
          try { d = await api(`/api/dubbing/${id}`, { method: "PATCH", json: { speakers: [{ speaker_id: sid, ...patch }] } }); renderAll(true); } catch (e) { toastError(e); renderSpeakers(); }
        };
        $("[data-sname]", row).onchange = (e) => save({ name: e.target.value });
        $("[data-svoice]", row).onclick = async () => { const vid = await pickVoice(d.speakers.find((s) => s.speaker_id === sid).voice_id); if (vid) save({ voice_id: vid }); };
        const own = $("[data-sown]", row);
        if (own) own.onclick = () => save({ voice_id: null });
      });
    };

    // ---------- lines ----------
    const flags = (s) => html`${s.outdated ? html`<span class="badge amber">Changed</span>` : ""}${s.stretch > 1.02 ? html`<span class="badge" title="Sped up to fit before the next line">${s.stretch.toFixed(2)}× faster</span>` : ""}`;
    const lineHtml = (s) => html`<div class="dub-line ${s.outdated ? "changed" : ""}" data-seg="${s.seg_id}">
      <button class="dub-time" data-seek title="Play from here">${fmtTime(s.start)}</button>
      <select class="dub-who spk-${spkIndex(s.speaker_id)}" data-who aria-label="Speaker" ${d.busy ? raw("disabled") : ""}>${d.speakers.map((p) => html`<option value="${p.speaker_id}" ${p.speaker_id === s.speaker_id ? raw("selected") : ""}>${p.name}</option>`)}</select>
      <div class="dub-texts"><div class="dub-orig">${s.text}</div>
        <textarea class="dub-tr" data-tr rows="1" maxlength="2000" placeholder="${d.busy && !s.translation ? "Translating…" : "Translation"}" aria-label="Translation" ${d.busy ? raw("readonly") : ""}>${s.translation}</textarea>
        <div class="dub-flags">${flags(s)}</div></div>
      <div class="dub-acts"><button class="icon-btn" data-play title="Play this line" aria-label="Play this line" ${s.has_audio ? "" : raw("disabled")}>${icon("play")}</button>
        <button class="icon-btn" data-retr title="Translate again" aria-label="Translate again" ${d.busy ? raw("disabled") : ""}>${icon("globe")}</button></div></div>`;
    const grow = (ta) => { if (!ta) return; ta.style.height = "auto"; ta.style.height = `${ta.scrollHeight}px`; };
    const linesBox = $("[data-lines]", el);
    const renderLines = (force) => {
      if (!force && linesBox.contains(document.activeElement) && document.activeElement.matches("textarea")) return; // don't replace a line being edited
      $("[data-lcount]", el).textContent = d.segments.length ? `${d.segments.length} line${d.segments.length === 1 ? "" : "s"}` : "";
      linesBox.innerHTML = String(d.segments.length ? html`${d.segments.map(lineHtml)}` : html`<div class="empty">${d.busy ? "Lines appear once the audio is transcribed." : "No lines."}</div>`);
      $$("textarea", linesBox).forEach(grow);
    };
    const segById = (sid) => d.segments.find((s) => s.seg_id === sid);
    const updateSeg = (seg, { rebuild = true } = {}) => {
      Object.assign(segById(seg.seg_id), seg);
      d.outdated_count = d.segments.filter((s) => s.outdated).length;
      const row = $(`[data-seg="${seg.seg_id}"]`, linesBox);
      if (row && rebuild) { const fresh = document.createElement("div"); fresh.innerHTML = String(lineHtml(seg)); row.replaceWith(fresh.firstElementChild); grow($(`[data-seg="${seg.seg_id}"] textarea`, linesBox)); }
      else if (row) { row.classList.toggle("changed", seg.outdated); $(".dub-flags", row).innerHTML = String(flags(seg)); }
      renderStatus();
    };
    const saveTimers = new Map();
    const saveTr = async (sid, value) => {
      clearTimeout(saveTimers.get(sid));
      saveTimers.delete(sid);
      try { updateSeg(await api(`/api/dubbing/${id}/segments/${sid}`, { method: "PATCH", json: { translation: value } }), { rebuild: false }); } catch (e) { toastError(e); }
    };
    linesBox.addEventListener("input", (e) => {
      if (!e.target.matches("[data-tr]")) return;
      grow(e.target);
      const sid = e.target.closest("[data-seg]").dataset.seg;
      clearTimeout(saveTimers.get(sid));
      saveTimers.set(sid, setTimeout(() => saveTr(sid, e.target.value), 700));
    });
    linesBox.addEventListener("change", async (e) => {
      if (!e.target.matches("[data-who]")) return;
      const sid = e.target.closest("[data-seg]").dataset.seg;
      try { updateSeg(await api(`/api/dubbing/${id}/segments/${sid}`, { method: "PATCH", json: { speaker_id: e.target.value } })); } catch (err) { toastError(err); }
    });
    const lineAudio = new Audio();
    linesBox.addEventListener("click", async (e) => {
      const row = e.target.closest("[data-seg]");
      if (!row) return;
      const s = segById(row.dataset.seg);
      if (e.target.closest("[data-seek]")) seek(mode === "dub" ? s.placed_start ?? s.start : s.start);
      else if (e.target.closest("[data-play]")) {
        media()?.pause();
        lineAudio.src = `/api/dubbing/${id}/segments/${s.seg_id}/audio?v=${Date.now()}`;
        lineAudio.play().catch(toastError);
      } else if (e.target.closest("[data-retr]")) {
        const b = e.target.closest("[data-retr]");
        b.disabled = true;
        try { updateSeg(await api(`/api/dubbing/${id}/segments/${s.seg_id}/retranslate`, { method: "POST" })); } catch (err) { toastError(err); b.disabled = false; }
      }
    });

    // ---------- apply, export, polling ----------
    $("[data-apply]", el).onclick = async () => {
      for (const sid of [...saveTimers.keys()]) { const ta = $(`[data-seg="${sid}"] textarea`, linesBox); if (ta) await saveTr(sid, ta.value); }
      try { d = { ...d, ...(await api(`/api/dubbing/${id}/render`, { method: "POST" })) }; renderAll(true); poll(); } catch (e) { toastError(e); }
    };
    $("[data-export]", el).onclick = () => exportDialog(d, video);
    $("[data-del]", el).onclick = async () => {
      if (!(await confirmDialog("Delete this dub?", "Its lines, voices and audio are removed for good. Your original video file isn't touched."))) return;
      try { await api(`/api/dubbing/${id}`, { method: "DELETE" }); await dropVideo(id); toast("Dub deleted"); navigate("/app/dubbing"); } catch (e) { toastError(e); }
    };
    const renderAll = (force) => { renderStatus(); renderSpeakers(); renderLines(force); };
    let wasBusy = d.busy;
    const refresh = async () => {
      d = await api(`/api/dubbing/${id}`);
      renderAll(wasBusy && !d.busy);
      if (wasBusy && !d.busy) renderPreview();
      wasBusy = d.busy;
    };
    const poll = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => { try { await refresh(); } catch {} if (d.busy) poll(); }, 2500);
    };
    renderAll(true);
    renderPreview();
    if (d.busy) poll();
    return () => { clearTimeout(timer); lineAudio.pause(); if (videoUrl) URL.revokeObjectURL(videoUrl); };
  },
};

// ---------- export ----------
function exportDialog(d, video) {
  const base = `/api/dubbing/${d.dub_id}`;
  const canRecord = Boolean(video) && typeof MediaRecorder !== "undefined" && "captureStream" in HTMLMediaElement.prototype;
  const canMp4 = Boolean(video) && typeof AudioEncoder !== "undefined";
  modal({
    title: "Export",
    body: html`<div class="rows" style="gap:8px">
      <button class="studio-opt" data-x="mp3">${icon("wave")}<span class="grow"><b>Dubbed audio (MP3)</b><span class="small muted">The new voices${d.keep_background ? " with the background" : ""}, 128 kbps</span></span></button>
      <button class="studio-opt" data-x="wav">${icon("wave")}<span class="grow"><b>Dubbed audio (WAV)</b><span class="small muted">Uncompressed, 24 kHz, for video editors</span></span></button>
      <button class="studio-opt" data-x="srt">${icon("stt")}<span class="grow"><b>Subtitles in ${d.target_name} (SRT)</b><span class="small muted">Timed to the dubbed lines</span></span></button>
      <button class="studio-opt" data-x="srt-orig">${icon("stt")}<span class="grow"><b>Subtitles in ${d.source_name} (SRT)</b><span class="small muted">The original words</span></span></button>
      <button class="studio-opt" data-x="mp4" ${canMp4 ? "" : raw("disabled")}>${icon("film")}<span class="grow"><b>Dubbed video (MP4)</b><span class="small muted">${canMp4 ? "The original picture with the new sound, in a few seconds. Opens in video editors and on phones" : video ? "This browser can't encode audio; use Chrome or Edge" : "Attach the original video on this page first"}</span></span></button>
      ${video ? html`<button class="studio-opt" data-x="video" ${canRecord ? "" : raw("disabled")}>${icon("film")}<span class="grow"><b>Dubbed video (WebM)</b><span class="small muted">Records in real time. Use it if the MP4 export doesn't work with this video</span></span></button>` : ""}</div>`,
    onMount: (box, close) => {
      $$("[data-x]", box).forEach((b) => b.onclick = () => {
        const x = b.dataset.x;
        close();
        if (x === "mp3") download(`${base}/audio?format=mp3&download=1`);
        else if (x === "wav") download(`${base}/audio?format=wav&download=1`);
        else if (x === "srt") download(`${base}/subtitles?format=srt&download=1`);
        else if (x === "srt-orig") download(`${base}/subtitles?format=srt&original=1&download=1`);
        else if (x === "video") recordVideo(d, video);
        else if (x === "mp4") exportMp4(d, video);
      });
    },
  });
}

// Builds an MP4 in the browser with Mediabunny (MPL-2.0), and nothing is uploaded. H.264 and HEVC
// video (MP4, MOV) is copied as is, which takes seconds. Other video (VP8/VP9 from WebM) is
// re-encoded to H.264, because iPhones and QuickTime don't play VP8/VP9 in an MP4. The dubbed
// audio is encoded to AAC (Opus if this browser can't encode AAC).
function exportMp4(d, video) {
  let cancelled = false;
  modal({
    title: "Exporting the dubbed video",
    body: html`<div class="meter"><i data-bar style="width:0%"></i></div><div class="small muted" data-msg style="margin-top:8px">Reading the video…</div>`,
    foot: html`<button class="btn" data-close>Cancel</button>`,
    onClose: () => { cancelled = true; },
    onMount: async (box, close) => {
      const msg = (t) => { $("[data-msg]", box).textContent = t; };
      const bar = (p) => { $("[data-bar]", box).style.width = `${Math.round(p * 100)}%`; };
      let input;
      try {
        const mb = await import("/vendor/mediabunny.mjs");
        input = new mb.Input({ source: new mb.BlobSource(video), formats: mb.ALL_FORMATS });
        const track = await input.getPrimaryVideoTrack();
        if (!track) throw new Error("This file has no video track.");
        const codec = await track.getCodec();
        const format = new mb.Mp4OutputFormat({ fastStart: "in-memory" });
        const copy = codec === "avc" || codec === "hevc";
        if (!copy && !(await track.canDecode())) throw new Error(`This browser can't read this video's format (${codec || "unknown"}). Use the WebM export instead.`);
        if (!copy && !(await mb.canEncodeVideo("avc", { width: track.codedWidth, height: track.codedHeight }))) throw new Error("This browser can't encode H.264 video. Use the WebM export instead.");
        const audioCodec = (await mb.canEncodeAudio("aac", { numberOfChannels: 1, sampleRate: 48000 })) ? "aac" : "opus";
        const duration = await input.computeDuration([track]);
        msg("Preparing the new sound…");
        const ctx = new OfflineAudioContext(1, 1, 48000);
        const dub = await ctx.decodeAudioData(await (await fetch(`/api/dubbing/${d.dub_id}/audio?format=wav`)).arrayBuffer());
        if (cancelled) return;
        const output = new mb.Output({ format, target: new mb.BufferTarget() });
        const vsrc = copy ? new mb.EncodedVideoPacketSource(codec) : new mb.VideoSampleSource({ codec: "avc", bitrate: mb.QUALITY_HIGH });
        output.addVideoTrack(vsrc, { rotation: await track.getRotation() });
        const asrc = new mb.AudioBufferSource({ codec: audioCodec, bitrate: 160_000 });
        output.addAudioTrack(asrc);
        await output.start();
        // Audio goes in one-second slices, kept just ahead of the video, so the file stays interleaved.
        const rate = dub.sampleRate, step = rate;
        let at = 0;
        const addAudioUntil = async (t) => {
          while (at < dub.length && at / rate <= t) {
            const n = Math.min(step, dub.length - at);
            const slice = new AudioBuffer({ length: n, numberOfChannels: 1, sampleRate: rate });
            slice.copyToChannel(dub.getChannelData(0).subarray(at, at + n), 0);
            await asrc.add(slice);
            at += n;
          }
        };
        msg(copy ? "Writing the MP4…" : "Converting the picture to H.264…");
        if (copy) {
          const config = await track.getDecoderConfig();
          let first = true;
          for await (const packet of new mb.EncodedPacketSink(track).packets()) {
            if (cancelled) { await output.cancel(); return; }
            await addAudioUntil(packet.timestamp + 1);
            await vsrc.add(packet, first ? { decoderConfig: config } : undefined);
            first = false;
            bar(duration ? Math.min(1, packet.timestamp / duration) : 0);
          }
        } else {
          for await (const sample of new mb.VideoSampleSink(track).samples()) {
            if (cancelled) { sample.close(); await output.cancel(); return; }
            await addAudioUntil(sample.timestamp + 1);
            await vsrc.add(sample);
            bar(duration ? Math.min(1, sample.timestamp / duration) : 0);
            sample.close();
          }
        }
        await addAudioUntil(Infinity);
        vsrc.close(); asrc.close();
        await output.finalize();
        const url = URL.createObjectURL(new Blob([output.target.buffer], { type: "video/mp4" }));
        download(url, `${d.title} (${d.target_name}).mp4`);
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        toast("Video saved");
        close();
      } catch (e) { if (!cancelled) { toastError(e); close(); } } finally { input?.dispose?.(); }
    },
  });
}

// Plays the video silently next to the dubbed audio and records both into a WebM file.
function recordVideo(d, video) {
  const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
  if (!mime) return toast("This browser can't record video.", "error");
  let stop = null;
  modal({
    title: "Recording the dubbed video",
    body: html`<video data-rv playsinline muted style="width:100%;border-radius:8px;background:#000"></video>
      <div class="meter" style="margin-top:12px"><i data-bar style="width:0%"></i></div><div class="small muted" data-msg>Preparing…</div>`,
    foot: html`<button class="btn" data-close>Cancel</button>`,
    onClose: () => stop?.(true),
    onMount: async (box, close) => {
      const v = $("[data-rv]", box);
      const url = URL.createObjectURL(video);
      v.src = url;
      let ctx;
      try {
        await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error("This browser can't play the video file.")); });
        ctx = new AudioContext();
        const buf = await ctx.decodeAudioData(await (await fetch(`/api/dubbing/${d.dub_id}/audio?format=wav`)).arrayBuffer());
        const dest = ctx.createMediaStreamDestination();
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(dest);
        const stream = new MediaStream([...v.captureStream().getVideoTracks(), ...dest.stream.getAudioTracks()]);
        const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
        const chunks = [];
        rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        const done = new Promise((res) => { rec.onstop = res; });
        let aborted = false;
        stop = (abort) => { aborted = abort; stop = null; try { src.stop(); } catch {} v.pause(); if (rec.state !== "inactive") rec.stop(); };
        v.currentTime = 0;
        await v.play();
        rec.start(1000);
        src.start(0, v.currentTime);
        v.ontimeupdate = () => {
          $("[data-bar]", box).style.width = `${Math.round((v.currentTime / v.duration) * 100)}%`;
          $("[data-msg]", box).textContent = `${fmtTime(v.currentTime)} of ${fmtTime(v.duration)}`;
        };
        v.onended = () => stop?.(false);
        await done;
        if (!aborted) {
          const out = URL.createObjectURL(new Blob(chunks, { type: "video/webm" }));
          download(out, `${d.title} (${d.target_name}).webm`);
          setTimeout(() => URL.revokeObjectURL(out), 10_000);
          toast("Video saved");
          close();
        }
      } catch (e) { toastError(e); close(); } finally { URL.revokeObjectURL(url); ctx?.close(); }
    },
  });
}
