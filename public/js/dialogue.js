// Dialogue (podcasts, interviews, scenes with several voices) and the Pronunciation dictionary.
import {
  html, raw, $, $$, icon, api, store, orb, toast, toastError, modal, confirmDialog, pickVoice, player, download, fmtNum, refreshUsage,
} from "./app.js";
import { ls, setLoading, elapsedLabel, postAudio, canStream, streamAudio, historyList, UI_FORMATS, voiceLabel, slider, wireSliders, tagChips, insertTag } from "./pages.js";

const MAX_CHARS = 20000;
const MAX_SPEAKERS = 8;
const uid = () => Math.random().toString(36).slice(2, 10);

const EXAMPLE = `Host: Welcome back to Small Wonders, the show about tiny things that changed the world. Today: the humble paperclip.
Guest: Thanks for having me. People laugh, but the paperclip is a perfect little machine.
Host: A machine? It's a bent piece of wire.
Guest: Exactly! One wire, three bends, and it holds paper without a single hole. That's elegant engineering.
Host: All right, I'm curious. Where does the story start?`;

// Picks voices for new speakers: different from the cast so far, alternating gender, Kokoro first (fastest).
function autoVoice(cast) {
  const used = new Set(cast.map((c) => c.voice_id));
  const lastGender = store.voice(cast.at(-1)?.voice_id)?.labels?.gender;
  const pool = store.voices.filter((v) => !used.has(v.voice_id) && v.provider !== "elevenlabs");
  const rank = (v) => (v.provider === "local" ? 0 : 1) + (lastGender && v.labels?.gender === lastGender ? 2 : 0);
  return [...pool].sort((a, b) => rank(a) - rank(b))[0]?.voice_id || store.voices[0]?.voice_id;
}

// "Name: line" scripts. A line without a name continues the previous speaker's line.
function parseScript(src) {
  const out = [];
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^([^:]{1,40}?)\s*:\s*(.+)$/);
    if (m && !/^https?$/i.test(m[1])) out.push({ name: m[1].replace(/^[*_\[\]]+|[*_\[\]]+$/g, "").trim(), text: m[2].trim() });
    else if (out.length) out.at(-1).text += " " + line;
    else out.push({ name: "", text: line });
  }
  return out;
}

// ====================================================================== Dialogue
export const dialoguePage = {
  match: /^\/app\/dialogue$/,
  title: "Dialogue",
  async render(el) {
    const [settings] = await Promise.all([store.loadSettings(), store.loadVoices()]);
    const saved = ls.get("dialogue_state", null);
    const state = saved?.cast?.length ? saved : { cast: [], lines: [], pause: 0.35, output_format: settings.default_output_format };
    if (!state.cast.length) {
      state.cast.push({ id: uid(), name: "Host", voice_id: store.voice(settings.default_voice_id) ? settings.default_voice_id : autoVoice([]) });
      state.cast.push({ id: uid(), name: "Guest", voice_id: autoVoice(state.cast) });
    }
    for (const c of state.cast) if (!store.voice(c.voice_id)) c.voice_id = autoVoice(state.cast.filter((x) => x !== c));
    if (!state.lines.length) state.lines.push({ id: uid(), speaker: state.cast[0].id, text: "" });
    let tab = "cast";
    let busy = false;
    const persist = () => ls.set("dialogue_state", state);
    const speaker = (id) => state.cast.find((c) => c.id === id) || state.cast[0];
    const spkClass = (id) => `spk-${Math.max(0, state.cast.findIndex((c) => c.id === id)) % 6}`;
    const chars = () => state.lines.reduce((n, l) => n + l.text.trim().length, 0);

    el.innerHTML = String(html`<div class="studio">
      <div class="studio-main">
        <div class="dlg-head"><div><h1 class="h2">Dialogue</h1><div class="small muted">Podcasts, interviews and scenes with several voices, in one recording.</div></div>
          <span class="grow"></span><button class="btn btn-sm" data-paste>${icon("copy")} Paste a script</button></div>
        <div class="dlg-lines" data-lines></div>
        <div class="studio-bar"><span class="small muted" data-count></span><span class="grow"></span>
          <span class="small muted hide-sm"><span class="kbd">Ctrl</span> <span class="kbd">Enter</span></span>
          <button class="btn btn-lg" data-stop hidden>${icon("stop")} Stop</button>
          <button class="btn btn-primary btn-lg" data-gen>Generate dialogue</button></div>
      </div>
      <aside class="studio-side"><div class="tabs"><button class="tab active" data-tab="cast">Cast</button><button class="tab" data-tab="history">History</button></div>
        <div class="side-body" data-side></div></aside></div>`);
    const linesEl = $("[data-lines]", el);
    const side = $("[data-side]", el);
    const genBtn = $("[data-gen]", el);
    const stopBtn = $("[data-stop]", el);
    let abort = null;
    stopBtn.onclick = () => abort?.abort();
    const countEl = $("[data-count]", el);

    const updateCount = () => {
      const n = chars();
      const filled = state.lines.filter((l) => l.text.trim()).length;
      countEl.textContent = `${filled} line${filled === 1 ? "" : "s"} · ${fmtNum(n)} / ${fmtNum(MAX_CHARS)} characters`;
      countEl.classList.toggle("danger", n > MAX_CHARS);
      if (!busy) genBtn.disabled = !filled || n > MAX_CHARS;
    };
    const grow = (ta) => { ta.style.height = "auto"; ta.style.height = `${ta.scrollHeight}px`; };

    const renderLines = (focusId, caretEnd = true) => {
      linesEl.innerHTML = String(html`${state.lines.map((l, i) => html`<div class="dlg-line" data-id="${l.id}">
          <div class="dlg-who ${spkClass(l.speaker)}">${orb(speaker(l.speaker).voice_id, "sm")}
            <select data-who aria-label="Speaker for line ${i + 1}">${state.cast.map((c) => html`<option value="${c.id}" ${c.id === l.speaker ? raw("selected") : ""}>${c.name}</option>`)}</select></div>
          <textarea data-text rows="1" maxlength="${MAX_CHARS}" placeholder="What does ${speaker(l.speaker).name} say?" aria-label="Line ${i + 1}">${l.text}</textarea>
          <div class="dlg-acts"><button class="icon-btn" data-up title="Move up" aria-label="Move line up" ${i ? "" : raw("disabled")}>${icon("arrowUp")}</button>
            <button class="icon-btn" data-del title="Delete line" aria-label="Delete line">${icon("trash")}</button></div></div>`)}
        <button class="btn btn-ghost btn-sm dlg-add" data-add>${icon("plus")} Add line <span class="subtle">· Enter in a line adds the next</span></button>`);
      $$("textarea", linesEl).forEach(grow);
      if (focusId) {
        const ta = $(`[data-id="${focusId}"] textarea`, linesEl);
        if (ta) { ta.focus(); const p = caretEnd ? ta.value.length : 0; ta.setSelectionRange(p, p); }
      }
      updateCount();
    };
    // Next speaker after a line: whoever spoke before it (back-and-forth), else the next in the cast.
    const nextSpeaker = (idx) => {
      const cur = state.lines[idx]?.speaker;
      const prev = state.lines.slice(0, idx).reverse().find((l) => l.speaker !== cur)?.speaker;
      if (prev) return prev;
      const ci = state.cast.findIndex((c) => c.id === cur);
      return state.cast[(ci + 1) % state.cast.length].id;
    };
    const addLine = (after = state.lines.length - 1, text = "") => {
      const line = { id: uid(), speaker: nextSpeaker(after), text };
      state.lines.splice(after + 1, 0, line);
      persist(); renderLines(line.id, false);
    };
    let lastLine = null; // where the tag buttons insert
    linesEl.addEventListener("focusin", (e) => { const row = e.target.closest("[data-id]"); if (row && e.target.matches("[data-text]")) lastLine = row.dataset.id; });
    linesEl.addEventListener("input", (e) => {
      const row = e.target.closest("[data-id]");
      if (!row || !e.target.matches("[data-text]")) return;
      state.lines.find((l) => l.id === row.dataset.id).text = e.target.value;
      grow(e.target); persist(); updateCount();
    });
    linesEl.addEventListener("change", (e) => {
      const row = e.target.closest("[data-id]");
      if (!row || !e.target.matches("[data-who]")) return;
      state.lines.find((l) => l.id === row.dataset.id).speaker = e.target.value;
      persist(); renderLines();
    });
    linesEl.addEventListener("keydown", (e) => {
      const ta = e.target.closest("[data-text]");
      if (!ta || e.ctrlKey || e.metaKey) return;
      const idx = state.lines.findIndex((l) => l.id === ta.closest("[data-id]").dataset.id);
      if (e.key === "Enter" && !e.shiftKey) {
        // Split at the caret: the rest of the text moves to the new line.
        e.preventDefault();
        const rest = ta.value.slice(ta.selectionEnd);
        state.lines[idx].text = ta.value.slice(0, ta.selectionStart).trimEnd();
        addLine(idx, rest.trimStart());
      } else if (e.key === "Backspace" && !ta.value && state.lines.length > 1) {
        e.preventDefault();
        state.lines.splice(idx, 1);
        persist(); renderLines(state.lines[Math.max(0, idx - 1)].id);
      }
    });
    linesEl.addEventListener("click", (e) => {
      if (e.target.closest("[data-add]")) return addLine();
      const row = e.target.closest("[data-id]");
      if (!row) return;
      const idx = state.lines.findIndex((l) => l.id === row.dataset.id);
      if (e.target.closest("[data-del]")) {
        if (state.lines.length === 1) state.lines[0].text = "";
        else state.lines.splice(idx, 1);
        persist(); renderLines();
      } else if (e.target.closest("[data-up]") && idx > 0) {
        [state.lines[idx - 1], state.lines[idx]] = [state.lines[idx], state.lines[idx - 1]];
        persist(); renderLines(state.lines[idx - 1].id);
      }
    });

    const renderCast = () => {
      const formats = UI_FORMATS.filter((f) => !(state.cast.some((c) => store.voice(c.voice_id)?.provider === "elevenlabs") && f.localOnly));
      if (!formats.find((f) => f.id === state.output_format)) state.output_format = formats[0].id;
      side.innerHTML = String(html`
        <div class="field"><span class="label">Speakers</span>
          <div class="dlg-cast">${state.cast.map((c, i) => html`<div class="dlg-member" data-c="${c.id}">
            <span class="dlg-dot spk-${i % 6}"></span>
            <input class="input" data-name value="${c.name}" maxlength="40" aria-label="Speaker name">
            <button class="voice-select" data-voice title="Change voice">${orb(c.voice_id, "xs")}<span class="name">${voiceLabel(store.voice(c.voice_id))}</span></button>
            <button class="icon-btn" data-rm title="Remove speaker" aria-label="Remove ${c.name}" ${state.cast.length > 1 ? "" : raw("disabled")}>${icon("x")}</button></div>`)}</div>
          ${state.cast.length < MAX_SPEAKERS ? html`<button class="btn btn-sm btn-ghost" data-add-spk style="align-self:flex-start">${icon("plus")} Add speaker</button>` : ""}</div>
        ${tagChips(null, "Adds the tag to the line you were last editing. Pauses work with every voice; emotions change the Qwen3 preset voices.")}
        ${slider({ key: "pause", label: "Pause between lines", min: 0, max: 1.5, step: 0.05, value: state.pause, left: "None", right: "Long" })}
        <div class="side-row"><label for="dlg-fmt">Output format</label><select class="pill-select" id="dlg-fmt" data-fmt>${formats.map((f) => html`<option value="${f.id}" ${f.id === state.output_format ? raw("selected") : ""}>${f.label}</option>`)}</select></div>
        <div class="notice">${icon("info")}<div>Names and words in your <a href="/app/pronunciation" data-link>pronunciation dictionary</a> are said the way you set them, for every speaker.</div></div>`);
      wireSliders(side, state, (v) => `${v.toFixed(2)} s`);
      $("input[type=range]", side).addEventListener("change", persist);
      $("[data-fmt]", side).onchange = (e) => { state.output_format = e.target.value; persist(); };
      $$("[data-tag]", side).forEach((b) => b.onclick = () => {
        const ta = $(`[data-id="${lastLine}"] textarea`, linesEl) || $$("textarea", linesEl).at(-1);
        if (ta) insertTag(ta, b.dataset.tag);
      });
      $$("[data-c]", side).forEach((row) => {
        const c = state.cast.find((x) => x.id === row.dataset.c);
        const name = $("[data-name]", row);
        name.oninput = () => { c.name = name.value; persist(); };
        name.onchange = () => { c.name = name.value.trim() || "Speaker"; persist(); renderLines(); renderCast(); };
        $("[data-voice]", row).onclick = async () => { const id = await pickVoice(c.voice_id); if (id) { c.voice_id = id; persist(); renderLines(); renderCast(); } };
        $("[data-rm]", row).onclick = async () => {
          const n = state.lines.filter((l) => l.speaker === c.id && l.text.trim()).length;
          if (n && !(await confirmDialog(`Remove ${c.name}?`, `Their ${n} line${n === 1 ? "" : "s"} will be deleted too.`, "Remove"))) return;
          state.cast = state.cast.filter((x) => x !== c);
          state.lines = state.lines.filter((l) => l.speaker !== c.id);
          if (!state.lines.length) state.lines.push({ id: uid(), speaker: state.cast[0].id, text: "" });
          persist(); renderLines(); renderCast();
        };
      });
      const add = $("[data-add-spk]", side);
      if (add) add.onclick = () => {
        state.cast.push({ id: uid(), name: `Speaker ${state.cast.length + 1}`, voice_id: autoVoice(state.cast) });
        persist(); renderLines(); renderCast();
        $$("[data-name]", side).at(-1)?.select();
      };
    };
    // Rebuilds the script from a history item, or from pasted "Name: line" text.
    const load = (entries) => {
      const cast = [];
      const byKey = new Map();
      const lines = entries.map((e) => {
        let c = byKey.get(e.key);
        if (!c) {
          c = state.cast.find((x) => x.name.toLowerCase() === e.name.toLowerCase() && !cast.includes(x));
          c = c ? { ...c } : { id: uid(), name: e.name, voice_id: e.voice_id };
          if (e.voice_id) c.voice_id = e.voice_id;
          if (!c.voice_id || !store.voice(c.voice_id)) c.voice_id = autoVoice(cast);
          cast.push(c); byKey.set(e.key, c);
        }
        return { id: uid(), speaker: c.id, text: e.text };
      });
      if (cast.length > MAX_SPEAKERS) return toast(`A dialogue can have at most ${MAX_SPEAKERS} speakers.`, "error");
      state.cast = cast; state.lines = lines.length ? lines : [{ id: uid(), speaker: cast[0]?.id, text: "" }];
      persist(); renderLines(); setTab("cast");
    };
    const pasteDialog = () => modal({
      title: "Paste a script", wide: true,
      body: html`<p class="muted small" style="margin:0">One line per turn, starting with the speaker's name and a colon. Each new name becomes a speaker with its own voice; you can change voices afterwards.</p>
        <textarea class="textarea" data-src style="min-height:240px" placeholder="${EXAMPLE}"></textarea>
        <div class="small subtle" data-sum>&nbsp;</div>`,
      foot: html`<button class="btn" data-example>Use the example</button><span class="grow"></span><button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-ok disabled>Replace script</button>`,
      onMount: (m, close) => {
        const src = $("[data-src]", m), ok = $("[data-ok]", m), sum = $("[data-sum]", m);
        const check = () => {
          const rows = parseScript(src.value);
          const names = [...new Set(rows.map((r) => r.name || "Speaker 1"))];
          ok.disabled = !rows.length || names.length > MAX_SPEAKERS;
          sum.textContent = rows.length ? `${rows.length} line${rows.length === 1 ? "" : "s"} · ${names.length > MAX_SPEAKERS ? `too many speakers (max ${MAX_SPEAKERS})` : names.join(", ")}` : " ";
        };
        src.oninput = check;
        $("[data-example]", m).onclick = () => { src.value = EXAMPLE; check(); };
        ok.onclick = () => {
          const rows = parseScript(src.value).map((r) => ({ ...r, name: r.name || "Speaker 1" }));
          load(rows.map((r) => ({ key: r.name.toLowerCase(), name: r.name, text: r.text })));
          close();
        };
      },
    });
    $("[data-paste]", el).onclick = pasteDialog;

    const renderHistory = () => historyList(side, {
      source: "DIALOGUE", empty: "Generated dialogues will appear here.",
      onUse: (h) => {
        const inputs = h.settings?.inputs || [];
        if (!inputs.length) return toast("This item has no script saved.", "error");
        load(inputs.map((x) => ({ key: x.speaker || x.voice_id, name: x.speaker || store.voice(x.voice_id)?.name || "Speaker", voice_id: x.voice_id, text: x.text })));
        if (h.settings?.pause_seconds !== undefined) { state.pause = h.settings.pause_seconds; persist(); renderCast(); }
      },
    });
    const setTab = (t) => { tab = t; $$("[data-tab]", el).forEach((b) => b.classList.toggle("active", b.dataset.tab === t)); side.onclick = null; t === "cast" ? renderCast() : renderHistory(); };
    $$("[data-tab]", el).forEach((b) => b.onclick = () => setTab(b.dataset.tab));

    const generate = async () => {
      const inputs = state.lines.filter((l) => l.text.trim()).map((l) => ({ text: l.text.trim(), voice_id: speaker(l.speaker).voice_id, speaker: speaker(l.speaker).name.trim() }));
      if (!inputs.length || busy || chars() > MAX_CHARS) return;
      busy = true;
      setLoading(genBtn, true, "Generating…");
      const stop = elapsedLabel(genBtn, "Generating…");
      try {
        const json = { inputs, settings: { pause_seconds: state.pause } };
        const names = [...new Set(state.lines.filter((l) => l.text.trim()).map((l) => speaker(l.speaker).name))];
        const meta = { title: "Dialogue", subtitle: names.join(", "), voiceId: inputs[0].voice_id };
        // MP3 starts playing with the first line; WAV waits for the whole recording.
        if (canStream() && state.output_format.startsWith("mp3_")) {
          abort = new AbortController();
          stopBtn.hidden = false;
          const out = await streamAudio(`/v1/text-to-dialogue/stream?output_format=${state.output_format}`, { json, signal: abort.signal, ...meta });
          if (out.stopped) toast(out.played ? "Stopped. The part that played isn't saved to history." : "Stopped.");
        } else {
          const out = await postAudio(`/v1/text-to-dialogue?output_format=${state.output_format}`, { json });
          player.play({ url: out.url, downloadUrl: `/v1/history/${out.historyId}/audio?download=1`, ...meta, id: out.historyId });
        }
        refreshUsage();
        if (tab === "history") renderHistory();
      } catch (e) { toastError(e); } finally { stop(); busy = false; abort = null; stopBtn.hidden = true; setLoading(genBtn, false); updateCount(); }
    };
    genBtn.onclick = generate;
    const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); generate(); } };
    document.addEventListener("keydown", onKey);
    // Line heights depend on the width, so measure again whenever the editor resizes.
    let lastWidth = 0;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w !== lastWidth) { lastWidth = w; $$("textarea", linesEl).forEach(grow); }
    });
    ro.observe(linesEl);
    renderLines();
    renderCast();
    return () => { document.removeEventListener("keydown", onKey); ro.disconnect(); };
  },
};

// ====================================================================== Pronunciation
// Reads "word,alias", "word = alias" or tab-separated lines; a header row is skipped.
function parseRuleFile(text) {
  try {
    const j = JSON.parse(text);
    const rows = Array.isArray(j) ? j : j.rules;
    if (Array.isArray(rows)) return rows;
  } catch {}
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^"?([^",=\t]+?)"?\s*(?:,|=|\t)\s*"?(.+?)"?$/);
    return m ? { word: m[1].trim(), alias: m[2].trim() } : null;
  }).filter((r) => r && !/^(word|grapheme|term)$/i.test(r.word));
}

export const pronunciationPage = {
  match: /^\/app\/pronunciation$/,
  title: "Pronunciation",
  async render(el) {
    const [settings] = await Promise.all([store.loadSettings(), store.loadVoices()]);
    let rules = [];
    let q = "";
    let voiceId = ls.get("pron_voice", ls.get("tts_state", {}).voice_id || settings.default_voice_id);
    if (!store.voice(voiceId)) voiceId = settings.default_voice_id;

    el.innerHTML = String(html`<div class="page-inner" style="max-width:900px">
      <div class="page-head"><div><h1 class="h1">Pronunciation</h1><p>Teach every voice how to say names, brands and abbreviations. Write each word the way it should sound.</p></div>
        <div class="row" style="gap:8px"><button class="btn btn-md" data-import>${icon("upload")} Import</button><button class="btn btn-md" data-export>${icon("download")} Export</button>
          <input type="file" accept=".json,.csv,.txt,.tsv" data-file hidden></div></div>
      <form class="card pron-add" data-add>
        <div class="field"><label for="pr-word">Word</label><input class="input" id="pr-word" name="word" maxlength="100" placeholder="e.g. Nguyen" autocomplete="off" required></div>
        <span class="pron-arrow">${icon("arrowR")}</span>
        <div class="field"><label for="pr-alias">Say it like</label><input class="input" id="pr-alias" name="alias" maxlength="200" placeholder="e.g. win" autocomplete="off" required></div>
        <label class="pron-case" title="Only match this exact capitalization, so 'US' changes but 'us' doesn't"><input type="checkbox" name="case_sensitive"> Match case</label>
        <button class="btn btn-primary btn-md">${icon("plus")} Add</button></form>
      <section class="card pron-test">
        <div class="row" style="gap:8px"><div class="h3 grow">Try it</div><button class="voice-chip" data-voice></button></div>
        <textarea class="textarea" data-try maxlength="1000" placeholder="Type a sentence with your words to hear how it sounds…" style="min-height:64px"></textarea>
        <div class="row" style="gap:10px"><div class="small muted grow" data-read>&nbsp;</div><button class="btn btn-md" data-listen disabled>${icon("play")} Listen</button></div>
      </section>
      <section data-list></section></div>`);
    const listEl = $("[data-list]", el);
    const tryEl = $("[data-try]", el);
    const readEl = $("[data-read]", el);
    const listenBtn = $("[data-listen]", el);
    tryEl.value = ls.get("pron_try", "");

    const renderVoice = () => {
      const chip = $("[data-voice]", el);
      chip.innerHTML = String(html`${orb(voiceId, "xs")}<span class="n">${voiceLabel(store.voice(voiceId))}</span>`);
      chip.onclick = async () => { const id = await pickVoice(voiceId); if (id) { voiceId = id; ls.set("pron_voice", id); renderVoice(); } };
    };
    let previewTimer = null;
    const preview = () => {
      clearTimeout(previewTimer);
      const t = tryEl.value.trim();
      listenBtn.disabled = !t;
      if (!t) { readEl.innerHTML = "&nbsp;"; return; }
      previewTimer = setTimeout(async () => {
        try {
          const { text } = await api("/api/pronunciation/apply", { method: "POST", json: { text: t } });
          readEl.innerHTML = String(text === t ? html`No dictionary words in this sentence.` : html`Read as: <span class="pron-read">${text}</span>`);
        } catch {}
      }, 250);
    };
    tryEl.oninput = () => { ls.set("pron_try", tryEl.value); preview(); };
    listenBtn.onclick = async () => {
      const t = tryEl.value.trim();
      if (!t) return;
      const voice = store.voice(voiceId);
      setLoading(listenBtn, true, "Generating…");
      try {
        const out = await postAudio(`/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, { json: { text: t } });
        player.play({ url: out.url, downloadUrl: `/v1/history/${out.historyId}/audio?download=1`, title: voice?.name || "Voice", subtitle: t, voiceId, id: out.historyId });
        refreshUsage();
      } catch (e) { toastError(e); } finally { setLoading(listenBtn, false); }
    };

    const renderList = () => {
      const shown = rules.filter((r) => !q || `${r.word} ${r.alias}`.toLowerCase().includes(q));
      listEl.innerHTML = String(rules.length ? html`
        <div class="row pron-list-head"><div class="h3 grow">${rules.length} word${rules.length === 1 ? "" : "s"}</div>
          ${rules.length > 8 ? html`<div class="search" style="max-width:260px">${icon("search")}<input class="input" data-q placeholder="Search words…" value="${q}"></div>` : ""}</div>
        <div class="card pron-rules">${shown.length ? shown.map((r) => html`<div class="pron-rule ${r.enabled ? "" : "off"}" data-id="${r.rule_id}">
            <input class="input pron-w" data-f="word" value="${r.word}" maxlength="100" aria-label="Word">
            <span class="pron-arrow">${icon("arrowR")}</span>
            <input class="input pron-a" data-f="alias" value="${r.alias}" maxlength="200" aria-label="Say it like">
            <button class="chip pron-flag ${r.case_sensitive ? "on" : ""}" data-case title="${r.case_sensitive ? "Matches this exact capitalization" : "Matches any capitalization"}">Aa</button>
            <label class="switch" title="${r.enabled ? "On" : "Off"}"><input type="checkbox" data-on ${r.enabled ? raw("checked") : ""} aria-label="Use this word"><span></span></label>
            <button class="icon-btn" data-try-rule title="Try it" aria-label="Try ${r.word}">${icon("play")}</button>
            <button class="icon-btn" data-del title="Delete" aria-label="Delete ${r.word}">${icon("trash")}</button></div>`)
          : html`<div class="empty">No words match.</div>`}</div>`
        : html`<div class="card studio-empty"><span class="art">${icon("pron")}</span><h2 class="h2">No words yet</h2>
          <p class="muted">Add a name or abbreviation above, like <b>SQL</b> said as <b>sequel</b>. It applies to Text to Speech, Dialogue, Studio and the API.</p></div>`);
      const qi = $("[data-q]", listEl);
      if (qi) qi.oninput = () => { q = qi.value.toLowerCase(); renderList(); const n = $("[data-q]", listEl); n.focus(); n.setSelectionRange(n.value.length, n.value.length); };
    };
    const load = async () => { rules = (await api("/api/pronunciation")).rules; renderList(); preview(); };
    const patch = async (id, body) => {
      try {
        const r = await api(`/api/pronunciation/${id}`, { method: "PATCH", json: body });
        rules = rules.map((x) => (x.rule_id === id ? r : x));
        preview();
        return r;
      } catch (e) { toastError(e); renderList(); }
    };
    listEl.addEventListener("change", async (e) => {
      const row = e.target.closest("[data-id]");
      if (!row) return;
      const id = row.dataset.id;
      if (e.target.matches("[data-f]")) {
        const cur = rules.find((r) => r.rule_id === id);
        const v = e.target.value.trim();
        if (!v) { e.target.value = cur[e.target.dataset.f]; return; }
        if (v !== cur[e.target.dataset.f] && await patch(id, { [e.target.dataset.f]: v })) toast("Saved");
      } else if (e.target.matches("[data-on]")) {
        await patch(id, { enabled: e.target.checked });
        row.classList.toggle("off", !e.target.checked);
      }
    });
    listEl.addEventListener("click", async (e) => {
      const row = e.target.closest("[data-id]");
      if (!row) return;
      const r = rules.find((x) => x.rule_id === row.dataset.id);
      if (e.target.closest("[data-case]")) { if (await patch(r.rule_id, { case_sensitive: !r.case_sensitive })) renderList(); }
      else if (e.target.closest("[data-try-rule]")) {
        tryEl.value = `Here is how I say ${r.word}.`;
        ls.set("pron_try", tryEl.value); preview(); listenBtn.click();
      } else if (e.target.closest("[data-del]")) {
        try { await api(`/api/pronunciation/${r.rule_id}`, { method: "DELETE" }); rules = rules.filter((x) => x !== r); renderList(); preview(); toast(`Removed ${r.word}`); } catch (err) { toastError(err); }
      }
    });
    $("[data-add]", el).onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api("/api/pronunciation", { method: "POST", json: { word: f.word.value, alias: f.alias.value, case_sensitive: f.case_sensitive.checked } });
        const word = f.word.value.trim();
        f.reset(); f.word.focus();
        await load();
        toast(`Added ${word}`);
      } catch (err) { toastError(err); }
    };
    $("[data-export]", el).onclick = () => {
      if (!rules.length) return toast("The dictionary is empty.", "error");
      const blob = new Blob([JSON.stringify({ rules: rules.map(({ word, alias, case_sensitive, enabled }) => ({ word, alias, case_sensitive, enabled })) }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      download(url, "pronunciation-dictionary.json");
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    };
    const fileIn = $("[data-file]", el);
    $("[data-import]", el).onclick = () => fileIn.click();
    fileIn.onchange = async () => {
      const file = fileIn.files[0];
      fileIn.value = "";
      if (!file) return;
      const rows = parseRuleFile(await file.text());
      if (!rows.length) return toast("No words found. Use a JSON export, or lines like: word, say it like", "error");
      try {
        const r = await api("/api/pronunciation/import", { method: "POST", json: { rules: rows } });
        await load();
        toast(`Imported ${r.added} new, updated ${r.updated}${r.errors.length ? `, skipped ${r.errors.length}` : ""}`, r.errors.length ? "error" : "");
      } catch (err) { toastError(err); }
    };
    renderVoice();
    await load();
  },
};
