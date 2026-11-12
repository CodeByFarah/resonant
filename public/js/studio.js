// Studio: long-form narration projects (audiobooks, articles, scripts), chapter by chapter.
import {
  html, $, $$, icon, api, store, orb, toast, toastError, modal, confirmDialog, pickVoice, player, download, fmtNum, fmtAgo, fmtTime, navigate, setTopbar,
} from "./app.js";
import { ls, setLoading, voiceLabel } from "./pages.js";

// About 15 characters per second of narration (150 words a minute).
const estSeconds = (chars) => chars / 15;
function fmtLong(s) {
  if (!s || !isFinite(s)) return "0 min";
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min` : `${Math.round(s)} s`;
}
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

// ====================================================================== Projects
export const studioList = {
  match: /^\/app\/studio$/,
  title: "Studio",
  async render(el) {
    let timer = null;
    const load = async () => {
      clearTimeout(timer);
      const { projects } = await api("/api/studio/projects");
      el.innerHTML = String(html`<div class="page-inner">
        <div class="page-head"><div><h1 class="h1">Studio</h1><p>Turn books, articles and scripts into narration, one chapter at a time.</p></div>
          <button class="btn btn-primary btn-md" data-new>${icon("plus")} New project</button></div>
        ${projects.length ? html`<div class="studio-cards">${projects.map((p) => html`<a class="card studio-card" href="/app/studio/${p.project_id}" data-link>
            <div class="studio-cover">${orb(p.project_id, "lg")}<span class="ic">${icon("book")}</span></div>
            <div class="studio-card-body"><div class="h3 clip">${p.title}</div>
              <div class="small subtle">${p.chapter_count} chapter${p.chapter_count === 1 ? "" : "s"} · ${fmtNum(p.char_count)} characters</div>
              <div class="meter"><i style="width:${pct(p.done_count, p.chapter_count)}%"></i></div>
              <div class="row small subtle" style="margin-top:8px;gap:6px"><span>${p.done_count} of ${p.chapter_count} ready${p.duration ? ` · ${fmtLong(p.duration)}` : ""}</span><span class="grow"></span>
                ${p.busy ? html`<span class="badge accent">Generating</span>` : html`<span>${fmtAgo(p.updated_unix)}</span>`}</div></div></a>`)}</div>`
          : html`<div class="card studio-empty"><span class="art">${icon("book")}</span><h2 class="h2">Make your first audiobook</h2>
            <p class="muted">Upload an EPUB, PDF, Markdown or text file and Resonant splits it into chapters for you. Or paste text, or start from a blank page.</p>
            <button class="btn btn-primary btn-md" data-new>${icon("plus")} New project</button></div>`}
      </div>`);
      $$("[data-new]", el).forEach((b) => b.onclick = () => newProjectDialog());
      if (projects.some((p) => p.busy)) timer = setTimeout(() => load().catch(() => {}), 4000);
    };
    await load();
    return () => clearTimeout(timer);
  },
};

async function newProjectDialog() {
  const settings = await store.loadSettings();
  await store.loadVoices();
  let voiceId = ls.get("studio_voice", settings.default_voice_id);
  if (!store.voice(voiceId)) voiceId = settings.default_voice_id;
  let source = "file";
  let parsed = null; // { title, chapters, char_count } from an upload
  modal({
    title: "New Studio project",
    wide: true,
    body: html`<div class="field"><label for="sp-title">Title</label><input class="input" id="sp-title" data-title maxlength="200" placeholder="e.g. The Lighthouse Keeper" autofocus></div>
      <div class="field"><label>Narrator</label><button type="button" class="chip lg" data-voice style="justify-content:flex-start"></button></div>
      <div class="field"><label>Start from</label><div><div class="seg" data-src>
        <button data-s="file" class="active">Upload a file</button><button data-s="paste">Paste text</button><button data-s="blank">Blank page</button></div></div></div>
      <div data-body></div>
      <label class="toggle-row" style="font-weight:400"><span>Read chapter titles aloud</span><span class="switch"><input type="checkbox" data-rt checked><span></span></span></label>`,
    foot: html`<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-create>Create project</button>`,
    onMount(m, close) {
      const body = $("[data-body]", m), title = $("[data-title]", m), create = $("[data-create]", m), vbtn = $("[data-voice]", m);
      const showVoice = () => { vbtn.innerHTML = String(html`${orb(voiceId, "sm")}<span>${voiceLabel(store.voice(voiceId))}</span>`); };
      showVoice();
      vbtn.onclick = async () => { const id = await pickVoice(voiceId); if (id) { voiceId = id; ls.set("studio_voice", id); showVoice(); } };
      const summary = () => {
        if (!parsed) return "";
        const titles = parsed.chapters.slice(0, 8).map((c) => c.title);
        return html`<div class="notice" style="margin-top:10px">${icon("book")}<div><b>Found ${parsed.chapters.length} chapter${parsed.chapters.length === 1 ? "" : "s"}</b> · ${fmtNum(parsed.char_count)} characters · about ${fmtLong(estSeconds(parsed.char_count))} of audio
          <div class="small" style="margin-top:4px">${titles.join(" · ")}${parsed.chapters.length > 8 ? ` · and ${parsed.chapters.length - 8} more` : ""}</div></div></div>`;
      };
      const renderBody = () => {
        if (source === "blank") { body.innerHTML = String(html`<p class="small muted" style="margin:0">You'll start with one empty chapter and can add more as you go.</p>`); return; }
        if (source === "paste") {
          body.innerHTML = String(html`<div class="field"><textarea class="textarea" data-text style="min-height:200px" placeholder="Paste your text. Lines like “Chapter 1” or “# Prologue” start a new chapter."></textarea></div>`);
          return;
        }
        body.innerHTML = String(html`<div class="up-card" data-drop role="button" tabindex="0" aria-label="Upload a document" style="padding:28px 16px">
          <span class="ib">${icon("upload")}</span><div class="t">${parsed ? "Choose a different file" : "Click to upload, or drag and drop"}</div><div class="s">EPUB, PDF, Markdown or plain text, up to 50 MB</div>
          <input type="file" accept=".epub,.pdf,.txt,.md,.markdown,text/plain,application/epub+zip,application/pdf" hidden data-file></div><div data-found>${summary()}</div>`);
        const drop = $("[data-drop]", body), fi = $("[data-file]", body);
        const take = async (f) => {
          if (!f) return;
          if (f.size > 50 * 1024 * 1024) return toast("That file is larger than 50 MB.", "error");
          $(".t", drop).innerHTML = String(html`<span class="spinner"></span> Reading ${f.name}…`);
          const form = new FormData();
          form.set("file", f, f.name);
          try {
            parsed = await api("/api/studio/import", { method: "POST", body: form });
            if (!title.value.trim()) title.value = parsed.title;
          } catch (e) { parsed = null; toastError(e); }
          renderBody();
        };
        drop.onclick = () => fi.click();
        drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fi.click(); } };
        fi.onchange = () => take(fi.files[0]);
        drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
        drop.ondragleave = () => drop.classList.remove("over");
        drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); take(e.dataTransfer.files[0]); };
      };
      renderBody();
      $$("[data-s]", m).forEach((b) => b.onclick = () => {
        source = b.dataset.s;
        $$("[data-s]", m).forEach((x) => x.classList.toggle("active", x === b));
        renderBody();
      });
      create.onclick = async () => {
        const payload = { title: title.value.trim(), voice_id: voiceId, read_titles: $("[data-rt]", m).checked };
        if (source === "file") {
          if (!parsed) return toast("Upload a file first, or choose Paste text or Blank page.", "error");
          payload.chapters = parsed.chapters;
        } else if (source === "paste") {
          payload.text = $("[data-text]", m).value;
          if (!payload.text.trim()) return toast("Paste some text first.", "error");
        }
        setLoading(create, true, "Creating…");
        try {
          const p = await api("/api/studio/projects", { method: "POST", json: payload });
          close();
          navigate(`/app/studio/${p.project_id}`);
        } catch (e) { toastError(e); setLoading(create, false); }
      };
    },
  });
}

// ====================================================================== Project editor
const STATUS = {
  draft: ["", "Not generated"],
  queued: ["wait", "Waiting"],
  generating: ["gen", "Generating"],
  done: ["done", "Ready"],
  failed: ["fail", "Failed"],
};
const chState = (c) => (c.status === "done" && c.outdated ? "out" : STATUS[c.status]?.[0] ?? "");

export const studioProject = {
  match: /^\/app\/studio\/([\w-]+)$/,
  title: "Studio",
  crumbs: [["Studio", "/app/studio"], "Project"],
  async render(el, { params: [pid] }) {
    let p;
    try { p = await api(`/api/studio/projects/${pid}`); } catch (e) {
      el.innerHTML = String(html`<div class="page-inner"><div class="notice warn">${icon("info")}<div><b>That project isn't here.</b> It may have been deleted. <a href="/app/studio" data-link>Back to Studio</a></div></div></div>`);
      return;
    }
    await store.loadVoices();
    let sel = ls.get(`studio_sel_${pid}`, null);
    if (!p.chapters.some((c) => c.chapter_id === sel)) sel = p.chapters[0]?.chapter_id ?? null;
    let poll = null, saveTimer = null, pending = null, alive = true;
    const crumbs = () => setTopbar(p.title, [["Studio", "/app/studio"], p.title]);
    crumbs();
    document.title = `${p.title} | Resonant`;
    const cur = () => p.chapters.find((c) => c.chapter_id === sel);

    el.innerHTML = String(html`<div class="page-inner studio-page">
      <div class="studio-head">
        <input class="studio-title" data-ptitle maxlength="200" aria-label="Project title">
        <div class="row wrap" style="gap:8px">
          <button class="chip lg" data-pvoice title="Narrator for every chapter"></button>
          <label class="chip lg studio-rt" title="Speak each chapter's title before its text"><span class="switch"><input type="checkbox" data-rt><span></span></span>Read titles</label>
          <span class="grow"></span>
          <button class="btn btn-md" data-export>${icon("download")} Export</button>
          <button class="btn btn-primary btn-md" data-genall></button>
          <button class="icon-btn" data-pdel title="Delete project" aria-label="Delete project">${icon("trash")}</button>
        </div>
        <div class="studio-summary" data-summary></div>
      </div>
      <div class="studio-grid">
        <aside class="card studio-side"><div class="studio-chlist" data-chlist role="list"></div>
          <button class="btn btn-sm studio-add" data-add>${icon("plus")} Add chapter</button></aside>
        <section class="card studio-editor" data-editor></section>
      </div></div>`);
    const $p = (s) => $(s, el);
    $p("[data-ptitle]").value = p.title;
    $p("[data-rt]").checked = p.read_titles;

    // ---------- header ----------
    const renderHead = () => {
      $p("[data-pvoice]").innerHTML = String(html`${orb(p.voice_id, "sm")}<span>${voiceLabel(store.voice(p.voice_id))}</span>`);
      const total = p.chapters.length;
      const ready = p.chapters.filter((c) => c.has_audio && !c.outdated).length;
      const active = p.chapters.filter((c) => c.status === "queued" || c.status === "generating");
      const left = p.chapters.filter((c) => !(c.has_audio && !c.outdated) && c.char_count).reduce((n, c) => n + c.char_count, 0);
      $p("[data-genall]").innerHTML = String(active.length ? html`${icon("stop")} Stop` : html`${icon("sparkle")} ${ready === total && total ? "Regenerate all" : "Generate all"}`);
      $p("[data-genall]").dataset.mode = active.length ? "stop" : ready === total && total ? "all" : "missing";
      $p("[data-summary]").innerHTML = String(html`<div class="row small subtle wrap" style="gap:6px 14px">
          <span><b class="fg">${ready}</b> of ${total} chapter${total === 1 ? "" : "s"} ready</span>
          ${p.duration ? html`<span>${fmtLong(p.duration)} of audio</span>` : ""}
          <span>${fmtNum(p.chapters.reduce((n, c) => n + c.char_count, 0))} characters</span>
          ${left && !active.length ? html`<span>about ${fmtLong(estSeconds(left))} still to narrate</span>` : ""}
          ${active.length ? html`<span class="badge accent"><span class="pulse"></span>${active.length} in progress</span>` : ""}</div>
        <div class="meter"><i style="width:${pct(ready, total)}%"></i></div>`);
    };

    // ---------- chapter list ----------
    const statusLine = (c) => {
      if (c.status === "generating") return `${Math.round(c.progress * 100)}% generated`;
      if (c.status === "queued") return "Waiting in line";
      if (c.status === "failed") return "Failed";
      if (c.has_audio) return `${c.outdated ? "Out of date · " : ""}${fmtTime(c.duration)}`;
      return c.char_count ? `${fmtNum(c.char_count)} characters` : "Empty";
    };
    const renderList = () => {
      $p("[data-chlist]").innerHTML = String(html`${p.chapters.map((c, i) => html`<button class="studio-ch ${c.chapter_id === sel ? "sel" : ""}" data-ch="${c.chapter_id}" role="listitem">
        <span class="num">${i + 1}</span><span class="grow" style="min-width:0"><span class="t">${c.title || "Untitled chapter"}</span><span class="s">${statusLine(c)}</span></span>
        <span class="st ${chState(c)}" title="${c.outdated && c.status === "done" ? "Out of date" : STATUS[c.status]?.[1] || ""}"></span></button>`)}`);
    };

    // ---------- editor ----------
    const stateArea = (c) => {
      if (c.status === "generating") {
        const elapsed = Date.now() / 1000 - (c.started_unix || Date.now() / 1000);
        const eta = c.progress > 0.03 ? (elapsed * (1 - c.progress)) / c.progress : null;
        return html`<div class="studio-gen"><div class="row small" style="gap:8px"><span class="spinner"></span><span>Generating… ${Math.round(c.progress * 100)}%${eta ? ` · about ${fmtLong(eta)} left` : ""}</span><span class="grow"></span>
          <button class="btn btn-sm" data-cstop>${icon("stop")} Stop</button></div><div class="meter"><i style="width:${c.progress * 100}%"></i></div></div>`;
      }
      if (c.status === "queued") return html`<div class="studio-gen"><div class="row small" style="gap:8px"><span class="spinner"></span><span>Waiting for the chapters ahead of it…</span><span class="grow"></span><button class="btn btn-sm" data-cstop>Cancel</button></div></div>`;
      return "";
    };
    const renderEditorState = () => {
      const c = cur();
      if (!c) return;
      const box = $("[data-cstate]", el);
      if (box) box.innerHTML = String(stateArea(c));
      const acts = $("[data-cacts]", el);
      if (acts) {
        const busy = c.status === "queued" || c.status === "generating";
        acts.innerHTML = String(html`${c.has_audio ? html`<button class="btn btn-md" data-cplay>${icon("play")} Play</button>
            <a class="icon-btn outline" href="/api/studio/chapters/${c.chapter_id}/audio?download=1" download title="Download chapter" aria-label="Download chapter">${icon("download")}</a>` : ""}
          <button class="btn btn-primary btn-md" data-cgen ${busy ? "disabled" : ""}>${icon("sparkle")} ${c.has_audio ? "Regenerate" : "Generate"}</button>`);
      }
      const notes = $("[data-cnotes]", el);
      if (notes) notes.innerHTML = String(html`${c.status === "failed" && c.error ? html`<div class="notice warn">${icon("info")}<div><b>This chapter failed.</b> ${c.error}</div></div>` : ""}
        ${c.status === "done" && c.outdated ? html`<div class="notice">${icon("info")}<div>The text or narrator changed after this audio was made. Regenerate it to bring it up to date.</div></div>` : ""}`);
    };
    const countLine = (c) => `${fmtNum(c.char_count)} characters · about ${fmtLong(estSeconds(c.char_count))}`;
    const renderEditor = () => {
      const ed = $p("[data-editor]");
      const c = cur();
      if (!c) {
        ed.innerHTML = String(html`<div class="empty">${icon("book")}<div>This project has no chapters. Add one to start writing.</div></div>`);
        return;
      }
      const i = p.chapters.indexOf(c);
      ed.innerHTML = String(html`<div class="studio-ed-head">
          <span class="small subtle">Chapter ${i + 1}</span>
          <input class="input studio-ch-title" data-ctitle maxlength="200" placeholder="Chapter title" aria-label="Chapter title">
          <button class="icon-btn" data-move="-1" title="Move up" aria-label="Move chapter up" ${i === 0 ? "disabled" : ""}>${icon("arrowUp")}</button>
          <button class="icon-btn flip" data-move="1" title="Move down" aria-label="Move chapter down" ${i === p.chapters.length - 1 ? "disabled" : ""}>${icon("arrowUp")}</button>
          <button class="icon-btn" data-cdel title="Delete chapter" aria-label="Delete chapter">${icon("trash")}</button></div>
        <textarea class="textarea studio-text" data-ctext placeholder="Write or paste this chapter's text. Leave a blank line between paragraphs; each paragraph gets a short pause." aria-label="Chapter text"></textarea>
        <div data-cnotes class="stack" style="gap:8px"></div>
        <div data-cstate></div>
        <div class="studio-ed-foot">
          <span class="row" style="gap:4px"><button class="chip" data-cvoice title="Narrator for this chapter"></button>${c.voice_id ? html`<button class="icon-btn" data-cvreset title="Use the project's narrator" aria-label="Use the project's narrator">${icon("x")}</button>` : ""}</span>
          <span class="small subtle" data-count>${countLine(c)}</span><span class="small subtle" data-saved></span>
          <span class="grow"></span><span class="row" style="gap:8px" data-cacts></span></div>`);
      $("[data-ctitle]", ed).value = c.title;
      $("[data-ctext]", ed).value = c.text;
      const v = c.voice_id || p.voice_id;
      $("[data-cvoice]", ed).innerHTML = String(html`${orb(v, "sm")}<span>${c.voice_id ? store.voice(v)?.name || v : `Project narrator · ${store.voice(v)?.name || v}`}</span>`);
      renderEditorState();
    };

    // ---------- saving ----------
    const markSaved = (t) => { const s = $("[data-saved]", el); if (s) s.textContent = t; };
    const flush = async () => {
      clearTimeout(saveTimer);
      if (!pending) return;
      const { id, patch } = pending;
      pending = null;
      try {
        const out = await api(`/api/studio/chapters/${id}`, { method: "PATCH", json: patch });
        const c = p.chapters.find((x) => x.chapter_id === id);
        if (c) Object.assign(c, { outdated: out.outdated, char_count: out.char_count });
        if (alive && sel === id) { markSaved("Saved"); renderEditorState(); }
        if (alive) { renderList(); renderHead(); }
      } catch (e) { toastError(e); markSaved("Not saved"); }
    };
    const queueSave = (patch) => {
      const c = cur();
      if (!c) return;
      if (pending && pending.id !== c.chapter_id) flush();
      pending = { id: c.chapter_id, patch: { ...(pending?.patch || {}), ...patch } };
      markSaved("Saving…");
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, 700);
    };

    // ---------- polling while chapters render ----------
    const refresh = async () => {
      const fresh = await api(`/api/studio/projects/${pid}?text=0`);
      for (const f of fresh.chapters) {
        const c = p.chapters.find((x) => x.chapter_id === f.chapter_id);
        if (c) Object.assign(c, { status: f.status, progress: f.progress, error: f.error, duration: f.duration, has_audio: f.has_audio, outdated: pending?.id === c.chapter_id ? c.outdated : f.outdated, started_unix: f.started_unix });
      }
      Object.assign(p, { duration: fresh.duration, busy: fresh.busy });
      if (!alive) return;
      renderList(); renderHead(); renderEditorState();
    };
    const schedule = () => {
      clearTimeout(poll);
      if (!alive) return;
      const busy = p.chapters.some((c) => c.status === "queued" || c.status === "generating");
      if (busy) poll = setTimeout(async () => { try { await refresh(); } catch {} schedule(); }, 2000);
    };

    renderHead(); renderList(); renderEditor(); schedule();

    // ---------- events ----------
    const mergeShape = (out) => {
      p.read_titles = out.read_titles;
      for (const f of out.chapters) { const c = p.chapters.find((x) => x.chapter_id === f.chapter_id); if (c) c.outdated = f.outdated; }
    };
    let titleTimer;
    $p("[data-ptitle]").oninput = (e) => {
      clearTimeout(titleTimer);
      titleTimer = setTimeout(async () => {
        try { const out = await api(`/api/studio/projects/${pid}`, { method: "PATCH", json: { title: e.target.value } }); p.title = out.title; if (alive) { crumbs(); document.title = `${p.title} | Resonant`; } } catch (err) { toastError(err); }
      }, 600);
    };
    $p("[data-pvoice]").onclick = async () => {
      const id = await pickVoice(p.voice_id);
      if (!id || id === p.voice_id) return;
      try { await flush(); const out = await api(`/api/studio/projects/${pid}`, { method: "PATCH", json: { voice_id: id } }); p.voice_id = id; mergeShape(out); renderHead(); renderList(); renderEditor(); toast("Narrator changed. Regenerate chapters to hear it."); } catch (e) { toastError(e); }
    };
    $p("[data-rt]").onchange = async (e) => {
      try { const out = await api(`/api/studio/projects/${pid}`, { method: "PATCH", json: { read_titles: e.target.checked } }); mergeShape(out); renderHead(); renderList(); renderEditorState(); } catch (err) { toastError(err); }
    };
    $p("[data-genall]").onclick = async (e) => {
      const btn = e.currentTarget;
      await flush();
      if (btn.dataset.mode === "stop") {
        try { await api(`/api/studio/projects/${pid}/cancel`, { method: "POST" }); toast("Stopped. Chapters already finished keep their audio."); await refresh(); } catch (err) { toastError(err); }
        return;
      }
      if (btn.dataset.mode === "all" && !(await confirmDialog("Regenerate every chapter?", "Every chapter is already up to date. Generating again replaces all of the audio.", "Regenerate all"))) return;
      try {
        const r = await api(`/api/studio/projects/${pid}/generate`, { method: "POST", json: { all: btn.dataset.mode === "all" } });
        toast(r.queued ? `Generating ${r.queued} chapter${r.queued === 1 ? "" : "s"}. You can leave this page; it keeps going.` : "Every chapter with text is already up to date.");
        await refresh(); schedule();
      } catch (err) { toastError(err); }
    };
    $p("[data-export]").onclick = () => {
      const ready = p.chapters.filter((c) => c.has_audio);
      if (!ready.length) return toast("Generate at least one chapter first.", "error");
      const missing = p.chapters.length - ready.length, stale = ready.filter((c) => c.outdated).length;
      modal({
        title: "Export audiobook",
        body: html`<div class="stack" style="gap:8px">
          <button class="studio-opt" data-fmt="mp3">${icon("wave")}<span class="grow"><b>One MP3 file</b><span class="small subtle">All chapters joined in order · ${fmtLong(ready.reduce((n, c) => n + (c.duration || 0), 0))}</span></span>${icon("download")}</button>
          <button class="studio-opt" data-fmt="zip">${icon("book")}<span class="grow"><b>ZIP with one MP3 per chapter</b><span class="small subtle">Numbered files, ready for an audiobook player</span></span>${icon("download")}</button>
          ${missing || stale ? html`<div class="notice">${icon("info")}<div>${missing ? `${missing} chapter${missing === 1 ? " has" : "s have"} no audio yet and will be left out. ` : ""}${stale ? `${stale} chapter${stale === 1 ? " is" : "s are"} out of date.` : ""}</div></div>` : ""}</div>`,
        onMount(m, close) {
          $$("[data-fmt]", m).forEach((b) => b.onclick = () => { download(`/api/studio/projects/${pid}/export?format=${b.dataset.fmt}`); close(); });
        },
      });
    };
    $p("[data-pdel]").onclick = async () => {
      if (!(await confirmDialog(`Delete “${p.title}”?`, "The project, its text and all of its generated audio are permanently deleted.", "Delete project"))) return;
      try { pending = null; await api(`/api/studio/projects/${pid}`, { method: "DELETE" }); toast("Project deleted"); navigate("/app/studio"); } catch (e) { toastError(e); }
    };
    $p("[data-add]").onclick = async () => {
      await flush();
      try {
        const c = await api(`/api/studio/projects/${pid}/chapters`, { method: "POST", json: { after: sel, title: `Chapter ${p.chapters.length + 1}`, text: "" } });
        const i = p.chapters.findIndex((x) => x.chapter_id === sel);
        p.chapters.splice(i >= 0 ? i + 1 : p.chapters.length, 0, c);
        sel = c.chapter_id; ls.set(`studio_sel_${pid}`, sel);
        renderHead(); renderList(); renderEditor();
        $("[data-ctitle]", el)?.select();
      } catch (e) { toastError(e); }
    };
    $p("[data-chlist]").onclick = async (e) => {
      const b = e.target.closest("[data-ch]");
      if (!b || b.dataset.ch === sel) return;
      await flush();
      sel = b.dataset.ch; ls.set(`studio_sel_${pid}`, sel);
      renderList(); renderEditor();
    };
    const ed = $p("[data-editor]");
    ed.addEventListener("input", (e) => {
      const c = cur();
      if (!c) return;
      if (e.target.matches("[data-ctitle]")) {
        c.title = e.target.value;
        const t = $(`[data-ch="${c.chapter_id}"] .t`, el);
        if (t) t.textContent = c.title || "Untitled chapter";
        queueSave({ title: c.title });
      } else if (e.target.matches("[data-ctext]")) {
        c.text = e.target.value; c.char_count = c.text.length;
        $("[data-count]", el).textContent = countLine(c);
        queueSave({ text: c.text });
      }
    });
    ed.addEventListener("click", async (e) => {
      const c = cur();
      if (!c) return;
      const t = e.target.closest("button, a");
      if (!t) return;
      if (t.matches("[data-cgen]")) {
        await flush();
        if (!c.text.trim()) return toast("Add some text to this chapter first.", "error");
        try { Object.assign(c, await api(`/api/studio/chapters/${c.chapter_id}/generate`, { method: "POST" }), { text: c.text }); renderList(); renderHead(); renderEditorState(); schedule(); } catch (err) { toastError(err); }
      } else if (t.matches("[data-cstop]")) {
        try { await api(`/api/studio/chapters/${c.chapter_id}/cancel`, { method: "POST" }); await refresh(); } catch (err) { toastError(err); }
      } else if (t.matches("[data-cplay]")) {
        player.play({ url: `/api/studio/chapters/${c.chapter_id}/audio?v=${Math.round((c.duration || 0) * 1000)}`, downloadUrl: `/api/studio/chapters/${c.chapter_id}/audio?download=1`, title: c.title || `Chapter ${p.chapters.indexOf(c) + 1}`, subtitle: p.title, voiceId: c.voice_id || p.voice_id });
      } else if (t.matches("[data-cvoice]")) {
        const id = await pickVoice(c.voice_id || p.voice_id);
        if (!id) return;
        try { await flush(); const out = await api(`/api/studio/chapters/${c.chapter_id}`, { method: "PATCH", json: { voice_id: id === p.voice_id ? null : id } }); Object.assign(c, { voice_id: out.voice_id, outdated: out.outdated }); renderList(); renderEditor(); } catch (err) { toastError(err); }
      } else if (t.matches("[data-cvreset]")) {
        try { await flush(); const out = await api(`/api/studio/chapters/${c.chapter_id}`, { method: "PATCH", json: { voice_id: null } }); Object.assign(c, { voice_id: null, outdated: out.outdated }); renderList(); renderEditor(); } catch (err) { toastError(err); }
      } else if (t.matches("[data-move]")) {
        await flush();
        try {
          await api(`/api/studio/chapters/${c.chapter_id}`, { method: "PATCH", json: { move: Number(t.dataset.move) } });
          const i = p.chapters.indexOf(c), j = i + Number(t.dataset.move);
          if (j >= 0 && j < p.chapters.length) { p.chapters.splice(i, 1); p.chapters.splice(j, 0, c); }
          renderList(); renderEditor();
        } catch (err) { toastError(err); }
      } else if (t.matches("[data-cdel]")) {
        if (!(await confirmDialog(`Delete “${c.title || "this chapter"}”?`, "Its text and audio are permanently deleted.", "Delete chapter"))) return;
        if (pending?.id === c.chapter_id) { clearTimeout(saveTimer); pending = null; }
        try {
          await api(`/api/studio/chapters/${c.chapter_id}`, { method: "DELETE" });
          const i = p.chapters.indexOf(c);
          p.chapters.splice(i, 1);
          sel = p.chapters[Math.min(i, p.chapters.length - 1)]?.chapter_id ?? null;
          ls.set(`studio_sel_${pid}`, sel);
          renderHead(); renderList(); renderEditor();
        } catch (err) { toastError(err); }
      }
    });
    // Keyboard: Ctrl/⌘+S saves now, Ctrl/⌘+Enter generates the open chapter.
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === "s") { e.preventDefault(); flush(); }
      if (e.key === "Enter" && e.target.closest?.("[data-editor]")) { e.preventDefault(); $("[data-cgen]", el)?.click(); }
    };
    document.addEventListener("keydown", onKey);
    const beforeUnload = (e) => { if (pending) { flush(); e.preventDefault(); } };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      alive = false;
      flush();
      clearTimeout(poll); clearTimeout(titleTimer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  },
};
