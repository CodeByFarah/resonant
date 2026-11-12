// Studio: long-form narration (audiobooks, articles, scripts) split into chapters.
// Chapters render one at a time in the background, paragraph by paragraph, straight to MP3 on
// disk, so a two-hour chapter never has to fit in memory and progress survives a page reload.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as dbm from "./db.mjs";
import * as el from "./engines/elevenlabs.mjs";
import { resample, silence, mp3Writer, pcm16ToFloat, httpError } from "./audio.mjs";
import { parseDocument, splitChapters } from "./importers.mjs";
import { apply as pronounce } from "./pronunciation.mjs";
import { toElevenLabs } from "./tags.mjs";

const db = dbm.database;
const DIR = path.join(dbm.DATA_DIR, "studio");
const RATE = 24000; // Kokoro and Qwen3-TTS both speak at 24 kHz
const KBPS = 96;
const PARAGRAPH_PAUSE = 0.6;
const TITLE_PAUSE = 1.2;
const MAX_CHAPTER_CHARS = 200_000;
fs.mkdirSync(DIR, { recursive: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS studio_projects (
    project_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    voice_id TEXT NOT NULL,
    read_titles INTEGER NOT NULL DEFAULT 1,
    created_unix INTEGER NOT NULL,
    updated_unix INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS studio_chapters (
    chapter_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    voice_id TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    progress REAL NOT NULL DEFAULT 0,
    error TEXT,
    audio_file TEXT,
    duration REAL,
    audio_hash TEXT,
    started_unix INTEGER,
    updated_unix INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS studio_chapters_project ON studio_chapters(project_id, idx);
`);

// ---------- data ----------
const getProject = (id) => db.prepare("SELECT * FROM studio_projects WHERE project_id = ?").get(id);
const getChapter = (id) => db.prepare("SELECT * FROM studio_chapters WHERE chapter_id = ?").get(id);
const chaptersOf = (pid) => db.prepare("SELECT * FROM studio_chapters WHERE project_id = ? ORDER BY idx").all(pid);
const touchProject = (pid) => db.prepare("UPDATE studio_projects SET updated_unix = ? WHERE project_id = ?").run(dbm.now(), pid);
const voiceOf = (ch, p) => ch.voice_id || p.voice_id;
// What the audio was made from, after the pronunciation dictionary; when it changes (new text,
// voice, or a dictionary word that appears in the chapter), the chapter's audio is out of date.
const hashOf = (ch, p) => crypto.createHash("sha1").update([voiceOf(ch, p), p.read_titles ? pronounce(ch.title) : "", pronounce(ch.text)].join("\u0000")).digest("hex");

function shapeChapter(ch, p, withText = true) {
  return {
    chapter_id: ch.chapter_id,
    idx: ch.idx,
    title: ch.title,
    ...(withText ? { text: ch.text } : {}),
    voice_id: ch.voice_id,
    status: ch.status,
    progress: ch.progress,
    error: ch.error,
    duration: ch.duration,
    has_audio: Boolean(ch.audio_file),
    outdated: Boolean(ch.audio_file) && ch.audio_hash !== hashOf(ch, p),
    char_count: ch.text.length,
    started_unix: ch.started_unix,
  };
}
function shapeProject(p, { withText = true } = {}) {
  const chapters = chaptersOf(p.project_id).map((c) => shapeChapter(c, p, withText));
  return {
    project_id: p.project_id,
    title: p.title,
    voice_id: p.voice_id,
    read_titles: Boolean(p.read_titles),
    created_unix: p.created_unix,
    updated_unix: p.updated_unix,
    chapter_count: chapters.length,
    char_count: chapters.reduce((n, c) => n + c.char_count, 0),
    done_count: chapters.filter((c) => c.has_audio && !c.outdated).length,
    duration: chapters.reduce((n, c) => n + (c.has_audio ? c.duration || 0 : 0), 0),
    busy: chapters.some((c) => c.status === "queued" || c.status === "generating"),
    chapters,
  };
}

function insertChapter(pid, idx, { title = "", text = "", voice_id = null } = {}) {
  const id = "ch_" + dbm.newId();
  db.prepare("INSERT INTO studio_chapters (chapter_id, project_id, idx, title, text, voice_id, updated_unix) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, pid, idx, String(title).slice(0, 200), String(text).slice(0, MAX_CHAPTER_CHARS), voice_id, dbm.now());
  return id;
}
function renumber(pid) {
  chaptersOf(pid).forEach((c, i) => db.prepare("UPDATE studio_chapters SET idx = ? WHERE chapter_id = ?").run(i, c.chapter_id));
}
function removeAudio(ch) {
  if (ch.audio_file) fs.rmSync(path.join(DIR, ch.project_id, ch.audio_file), { force: true });
}

// ---------- render queue (one chapter at a time) ----------
const queue = [];
let running = null; // chapter_id being rendered
const cancelled = new Set();

function enqueue(ids) {
  for (const id of ids) {
    if (queue.includes(id) || running === id) continue;
    queue.push(id);
    db.prepare("UPDATE studio_chapters SET status = 'queued', progress = 0, error = NULL WHERE chapter_id = ?").run(id);
  }
  kick();
}
// Takes chapters out of the queue (and stops the one rendering) without touching existing audio.
function dequeue(ids) {
  for (const id of ids) {
    const i = queue.indexOf(id);
    if (i >= 0) queue.splice(i, 1);
    if (running === id) cancelled.add(id);
    const ch = getChapter(id);
    if (ch && ch.status === "queued") db.prepare("UPDATE studio_chapters SET status = ?, progress = 0 WHERE chapter_id = ?").run(ch.audio_file ? "done" : "draft", id);
  }
}

let deps = null;
async function kick() {
  if (running || !deps) return;
  const id = queue.shift();
  if (!id) return;
  running = id;
  try { await render(id); } catch (e) { console.error("[studio]", e); }
  finally { running = null; cancelled.delete(id); setImmediate(kick); }
}

// Splits a chapter into what gets spoken, with the pause that follows each piece.
function pieces(ch, p) {
  const out = [];
  if (p.read_titles && ch.title.trim()) out.push({ text: ch.title.trim(), pause: TITLE_PAUSE });
  for (let para of ch.text.split(/\n\s*\n/)) {
    para = para.replace(/\s*\n\s*/g, " ").trim();
    if (/[\p{L}\p{N}]/u.test(para)) out.push({ text: para, pause: PARAGRAPH_PAUSE });
  }
  return out;
}

// Tags ([pause 1s], [whisper]) and the pronunciation dictionary work here like everywhere else.
async function* speak(voice, text) {
  if (voice.provider === "elevenlabs") {
    const out = await el.tts(voice.voice_id, { text: toElevenLabs(text, pronounce), model_id: "eleven_multilingual_v2" }, "pcm_24000");
    yield { samples: pcm16ToFloat(out.buffer), rate: 24000 };
    return;
  }
  yield* deps.speakParts(voice, text);
}

async function render(id) {
  let ch = getChapter(id);
  if (!ch) return;
  const p = getProject(ch.project_id);
  const dir = path.join(DIR, p.project_id);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${id}.part.mp3`);
  db.prepare("UPDATE studio_chapters SET status = 'generating', progress = 0, error = NULL, started_unix = ? WHERE chapter_id = ?").run(dbm.now(), id);
  let fd = null;
  try {
    const voice = await deps.findVoice(voiceOf(ch, p));
    const list = pieces(ch, p);
    if (!list.length) throw httpError(422, "This chapter has no text to read.");
    const total = list.reduce((n, x) => n + x.text.length, 0);
    const hash = hashOf(ch, p);
    const writer = mp3Writer(RATE, KBPS);
    fd = fs.openSync(tmp, "w");
    let done = 0, seconds = 0;
    for (const piece of list) {
      for await (const part of speak(voice, piece.text)) {
        if (cancelled.has(id)) throw Object.assign(new Error("cancelled"), { cancelled: true });
        const s = resample(part.samples, part.rate, RATE);
        fs.writeSync(fd, writer.write(s));
        seconds += s.length / RATE;
      }
      const gap = silence(piece.pause, RATE);
      fs.writeSync(fd, writer.write(gap));
      seconds += gap.length / RATE;
      done += piece.text.length;
      db.prepare("UPDATE studio_chapters SET progress = ? WHERE chapter_id = ?").run(done / total, id);
      if (cancelled.has(id)) throw Object.assign(new Error("cancelled"), { cancelled: true });
    }
    fs.writeSync(fd, writer.end());
    fs.closeSync(fd); fd = null;
    ch = getChapter(id);
    if (!ch) { fs.rmSync(tmp, { force: true }); return; } // deleted while rendering
    const file = `${id}.mp3`;
    fs.renameSync(tmp, path.join(dir, file));
    db.prepare("UPDATE studio_chapters SET status = 'done', progress = 1, audio_file = ?, duration = ?, audio_hash = ?, updated_unix = ? WHERE chapter_id = ?")
      .run(file, seconds, hash, dbm.now(), id);
    touchProject(p.project_id);
  } catch (e) {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    const cur = getChapter(id);
    if (!cur) return;
    if (e.cancelled) db.prepare("UPDATE studio_chapters SET status = ?, progress = 0 WHERE chapter_id = ?").run(cur.audio_file ? "done" : "draft", id);
    else db.prepare("UPDATE studio_chapters SET status = 'failed', progress = 0, error = ? WHERE chapter_id = ?").run(String(e.message || e).slice(0, 500), id);
  }
}

// ---------- routes ----------
export function registerStudio(d) {
  deps = d;
  const { route, readJson, readForm, formFile, json } = d;
  const project = (id) => { const p = getProject(id); if (!p) throw httpError(404, "Project not found"); return p; };
  const chapter = (id) => { const c = getChapter(id); if (!c) throw httpError(404, "Chapter not found"); return c; };
  const safeName = (s) => String(s || "audio").replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "audio";

  route("GET", "/api/studio/projects", async (req, res) => {
    const rows = db.prepare("SELECT * FROM studio_projects ORDER BY updated_unix DESC").all();
    json(res, 200, { projects: rows.map((p) => { const { chapters, ...rest } = shapeProject(p, { withText: false }); return rest; }) });
  });

  // Parses a document without saving anything, so the app can show what was found first.
  route("POST", "/api/studio/import", async (req, res) => {
    const form = await readForm(req);
    const file = await formFile(form, "file");
    const doc = await parseDocument(file.name, file.buffer);
    json(res, 200, { title: doc.title, chapters: doc.chapters, char_count: doc.chapters.reduce((n, c) => n + c.text.length, 0) });
  });

  route("POST", "/api/studio/projects", async (req, res) => {
    const body = await readJson(req);
    const title = String(body.title || "").trim().slice(0, 200) || "Untitled project";
    const voice = await d.findVoice(String(body.voice_id || ""));
    const pasted = String(body.text || "");
    const chapters = Array.isArray(body.chapters) && body.chapters.length ? body.chapters
      : pasted.trim() ? splitChapters(pasted, "Chapter 1") : [{ title: "Chapter 1", text: "" }];
    if (chapters.length > 2000) throw httpError(422, "A project can have up to 2000 chapters.");
    const pid = "pj_" + dbm.newId();
    db.prepare("INSERT INTO studio_projects VALUES (?, ?, ?, ?, ?, ?)").run(pid, title, voice.voice_id, body.read_titles === false ? 0 : 1, dbm.now(), dbm.now());
    chapters.forEach((c, i) => insertChapter(pid, i, { title: c.title ?? `Chapter ${i + 1}`, text: c.text ?? "" }));
    json(res, 200, shapeProject(getProject(pid)));
  });

  route("GET", "/api/studio/projects/:id", async (req, res, p, q) => json(res, 200, shapeProject(project(p.id), { withText: q.get("text") !== "0" })));

  route("PATCH", "/api/studio/projects/:id", async (req, res, p) => {
    const pr = project(p.id);
    const body = await readJson(req);
    if ("title" in body) db.prepare("UPDATE studio_projects SET title = ? WHERE project_id = ?").run(String(body.title).trim().slice(0, 200) || "Untitled project", pr.project_id);
    if ("voice_id" in body) { const v = await d.findVoice(String(body.voice_id)); db.prepare("UPDATE studio_projects SET voice_id = ? WHERE project_id = ?").run(v.voice_id, pr.project_id); }
    if ("read_titles" in body) db.prepare("UPDATE studio_projects SET read_titles = ? WHERE project_id = ?").run(body.read_titles ? 1 : 0, pr.project_id);
    touchProject(pr.project_id);
    json(res, 200, shapeProject(getProject(pr.project_id)));
  });

  route("DELETE", "/api/studio/projects/:id", async (req, res, p) => {
    const pr = project(p.id);
    dequeue(chaptersOf(pr.project_id).map((c) => c.chapter_id));
    db.prepare("DELETE FROM studio_chapters WHERE project_id = ?").run(pr.project_id);
    db.prepare("DELETE FROM studio_projects WHERE project_id = ?").run(pr.project_id);
    fs.rmSync(path.join(DIR, pr.project_id), { recursive: true, force: true });
    json(res, 200, { status: "ok" });
  });

  route("POST", "/api/studio/projects/:id/chapters", async (req, res, p) => {
    const pr = project(p.id);
    const body = await readJson(req);
    const list = chaptersOf(pr.project_id);
    const after = list.findIndex((c) => c.chapter_id === body.after);
    const idx = after >= 0 ? after + 1 : list.length;
    db.prepare("UPDATE studio_chapters SET idx = idx + 1 WHERE project_id = ? AND idx >= ?").run(pr.project_id, idx);
    const id = insertChapter(pr.project_id, idx, { title: body.title ?? `Chapter ${list.length + 1}`, text: body.text ?? "" });
    touchProject(pr.project_id);
    json(res, 200, shapeChapter(getChapter(id), getProject(pr.project_id)));
  });

  route("PATCH", "/api/studio/chapters/:id", async (req, res, p) => {
    const ch = chapter(p.id);
    const body = await readJson(req);
    if ("title" in body) db.prepare("UPDATE studio_chapters SET title = ? WHERE chapter_id = ?").run(String(body.title).slice(0, 200), ch.chapter_id);
    if ("text" in body) {
      const text = String(body.text);
      if (text.length > MAX_CHAPTER_CHARS) throw httpError(422, `A chapter can have up to ${MAX_CHAPTER_CHARS.toLocaleString()} characters. Split it into two.`);
      db.prepare("UPDATE studio_chapters SET text = ? WHERE chapter_id = ?").run(text, ch.chapter_id);
    }
    if ("voice_id" in body) {
      const v = body.voice_id ? (await d.findVoice(String(body.voice_id))).voice_id : null;
      db.prepare("UPDATE studio_chapters SET voice_id = ? WHERE chapter_id = ?").run(v, ch.chapter_id);
    }
    if ("move" in body) {
      const list = chaptersOf(ch.project_id);
      const i = list.findIndex((c) => c.chapter_id === ch.chapter_id);
      const j = Math.max(0, Math.min(list.length - 1, i + (body.move < 0 ? -1 : 1)));
      if (i !== j) { const [c] = list.splice(i, 1); list.splice(j, 0, c); list.forEach((c2, k) => db.prepare("UPDATE studio_chapters SET idx = ? WHERE chapter_id = ?").run(k, c2.chapter_id)); }
    }
    db.prepare("UPDATE studio_chapters SET updated_unix = ? WHERE chapter_id = ?").run(dbm.now(), ch.chapter_id);
    touchProject(ch.project_id);
    json(res, 200, shapeChapter(getChapter(ch.chapter_id), getProject(ch.project_id)));
  });

  route("DELETE", "/api/studio/chapters/:id", async (req, res, p) => {
    const ch = chapter(p.id);
    dequeue([ch.chapter_id]);
    removeAudio(ch);
    db.prepare("DELETE FROM studio_chapters WHERE chapter_id = ?").run(ch.chapter_id);
    renumber(ch.project_id);
    touchProject(ch.project_id);
    json(res, 200, { status: "ok" });
  });

  route("POST", "/api/studio/chapters/:id/generate", async (req, res, p) => {
    const ch = chapter(p.id);
    if (!ch.text.trim()) throw httpError(422, "Add some text to this chapter first.");
    const pr = getProject(ch.project_id);
    await d.findVoice(voiceOf(ch, pr)); // fail now, not in the background, if the voice is gone
    enqueue([ch.chapter_id]);
    json(res, 200, shapeChapter(getChapter(ch.chapter_id), pr, false));
  });

  // Renders every chapter that has no audio or whose audio is out of date (or all, with all: true).
  route("POST", "/api/studio/projects/:id/generate", async (req, res, p) => {
    const pr = project(p.id);
    const body = await readJson(req);
    const todo = chaptersOf(pr.project_id).filter((c) => c.text.trim() && (body.all || !c.audio_file || c.audio_hash !== hashOf(c, pr) || c.status === "failed"));
    for (const v of new Set(todo.map((c) => voiceOf(c, pr)))) await d.findVoice(v);
    enqueue(todo.map((c) => c.chapter_id));
    json(res, 200, { queued: todo.length });
  });

  route("POST", "/api/studio/chapters/:id/cancel", async (req, res, p) => {
    const ch = chapter(p.id);
    dequeue([ch.chapter_id]);
    json(res, 200, { status: "ok" });
  });

  route("POST", "/api/studio/projects/:id/cancel", async (req, res, p) => {
    const pr = project(p.id);
    dequeue(chaptersOf(pr.project_id).map((c) => c.chapter_id));
    json(res, 200, { status: "ok" });
  });

  route("GET", "/api/studio/chapters/:id/audio", async (req, res, p, q) => {
    const ch = chapter(p.id);
    if (!ch.audio_file) throw httpError(404, "This chapter hasn't been generated yet.");
    const file = path.join(DIR, ch.project_id, ch.audio_file);
    const pr = getProject(ch.project_id);
    const name = `${String(ch.idx + 1).padStart(2, "0")} - ${safeName(ch.title || pr.title)}.mp3`;
    res.writeHead(200, {
      "content-type": "audio/mpeg", "content-length": fs.statSync(file).size, "cache-control": "no-cache",
      ...(q.get("download") ? { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}` } : {}),
    });
    fs.createReadStream(file).pipe(res);
  });

  // The whole book: one MP3 (chapters joined in order) or a ZIP with one MP3 per chapter.
  route("GET", "/api/studio/projects/:id/export", async (req, res, p, q) => {
    const pr = project(p.id);
    const ready = chaptersOf(pr.project_id).filter((c) => c.audio_file);
    if (!ready.length) throw httpError(409, "Generate at least one chapter first.");
    const files = ready.map((c) => ({ c, file: path.join(DIR, pr.project_id, c.audio_file) }));
    const title = safeName(pr.title);
    if (q.get("format") === "zip") {
      const zip = d.makeZip(files.map(({ c, file }) => ({ name: `${String(c.idx + 1).padStart(2, "0")} - ${safeName(c.title || pr.title)}.mp3`, data: fs.readFileSync(file) })));
      res.writeHead(200, { "content-type": "application/zip", "content-length": zip.length, "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(title)}.zip` });
      return res.end(zip);
    }
    const size = files.reduce((n, f) => n + fs.statSync(f.file).size, 0);
    res.writeHead(200, { "content-type": "audio/mpeg", "content-length": size, "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(title)}.mp3` });
    for (const { file } of files) {
      await new Promise((resolve, reject) => { const s = fs.createReadStream(file); s.on("end", resolve); s.on("error", reject); s.pipe(res, { end: false }); });
    }
    res.end();
  });

  // Chapters that were waiting or rendering when the server stopped carry on.
  const pending = db.prepare("SELECT chapter_id FROM studio_chapters WHERE status IN ('queued', 'generating') ORDER BY project_id, idx").all();
  if (pending.length) { console.log(`[studio] resuming ${pending.length} chapter(s)`); enqueue(pending.map((r) => r.chapter_id)); }
}
