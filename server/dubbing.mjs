// Dubbing: puts the speech of a video or recording into another language, keeping who speaks
// when, each speaker's own voice (cloned from their lines with Qwen3-TTS), and optionally the
// music and sound behind them (Demucs).
//
// Pipeline, one job at a time in the background:
//   transcribe (Whisper, with speaker labels) -> translate (M2M100, sentence by sentence)
//   -> separate the background -> build a voice reference per speaker from their own lines
//   -> voice each line -> fit it into its time slot (speeding it up a little if needed) -> mix.
// After that, editing a line's translation or a speaker's voice only redoes the lines it touches.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as dbm from "./db.mjs";
import * as qwen from "./engines/qwen.mjs";
import * as local from "./engines/local.mjs";
import * as el from "./engines/elevenlabs.mjs";
import { translate, translatorName, LANGUAGES, languageName } from "./engines/translate.mjs";
import { apply as pronounce } from "./pronunciation.mjs";
import { toElevenLabs, parseTags } from "./tags.mjs";
import { decodeToMono, resample, encodeWav, encodeMp3, timeStretch, pcm16ToFloat, httpError } from "./audio.mjs";

const db = dbm.database;
const DIR = path.join(dbm.DATA_DIR, "dubbing");
const RATE = 24000; // working and mix rate (the voices speak at 24 kHz)
const MAX_SECONDS = 600;
const MAX_STRETCH = 1.3; // a line can be sped up by at most 30% to fit its slot
const REF_SECONDS = 12;
const LANG_CODES = new Set(LANGUAGES.map(([c]) => c));
const WORKING = ["queued", "transcribing", "translating", "separating", "voicing", "dubbing", "mixing"];
fs.mkdirSync(DIR, { recursive: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS dubs (
    dub_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source_lang TEXT,
    target_lang TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    progress REAL NOT NULL DEFAULT 0,
    error TEXT,
    duration REAL NOT NULL DEFAULT 0,
    keep_background INTEGER NOT NULL DEFAULT 1,
    num_speakers INTEGER,
    default_voice TEXT,
    speakers TEXT NOT NULL DEFAULT '[]',
    mixed INTEGER NOT NULL DEFAULT 0,
    created_unix INTEGER NOT NULL,
    updated_unix INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS dub_segments (
    seg_id TEXT PRIMARY KEY,
    dub_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    speaker_id TEXT NOT NULL,
    start REAL NOT NULL,
    end REAL NOT NULL,
    text TEXT NOT NULL,
    translation TEXT NOT NULL DEFAULT '',
    audio_hash TEXT,
    placed_start REAL,
    placed_end REAL,
    stretch REAL
  );
  CREATE INDEX IF NOT EXISTS dub_segments_dub ON dub_segments(dub_id, idx);
`);

let deps = null;
const dirOf = (id) => path.join(DIR, id);
const fileOf = (id, name) => path.join(dirOf(id), name);
const getDub = (id) => db.prepare("SELECT * FROM dubs WHERE dub_id = ?").get(id);
const segmentsOf = (id) => db.prepare("SELECT * FROM dub_segments WHERE dub_id = ? ORDER BY idx").all(id);
const speakersOf = (d) => JSON.parse(d.speakers || "[]");
const setDub = (id, fields) => {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE dubs SET ${keys.map((k) => `${k} = ?, `).join("")}updated_unix = ? WHERE dub_id = ?`).run(...keys.map((k) => fields[k]), dbm.now(), id);
};
const readWav = async (file) => (await decodeToMono(fs.readFileSync(file), RATE)).samples;
const writeWav = (file, samples) => fs.writeFileSync(file, encodeWav(samples, RATE));

// What a line's audio depends on; when it changes, the line is voiced again.
const voiceKey = (d, seg) => speakersOf(d).find((s) => s.speaker_id === seg.speaker_id)?.voice_id || `original:${seg.speaker_id}`;
const hashOf = (d, seg) => crypto.createHash("sha1").update([voiceKey(d, seg), d.target_lang, pronounce(seg.translation)].join("\u0000")).digest("hex");

function shapeDub(d, withSegments = false) {
  const segs = segmentsOf(d.dub_id);
  const outdated = segs.filter((s) => s.translation.trim() && s.audio_hash !== hashOf(d, s)).length;
  const out = {
    dub_id: d.dub_id, title: d.title, source_lang: d.source_lang, target_lang: d.target_lang,
    source_name: d.source_lang ? languageName(d.source_lang) : null, target_name: languageName(d.target_lang),
    status: d.status, progress: d.progress, error: d.error, duration: d.duration, keep_background: Boolean(d.keep_background),
    speakers: speakersOf(d), segment_count: segs.length, outdated_count: outdated, has_audio: Boolean(d.mixed) && fs.existsSync(fileOf(d.dub_id, "dub.wav")),
    has_background: fs.existsSync(fileOf(d.dub_id, "background.wav")),
    busy: WORKING.includes(d.status), created_unix: d.created_unix, updated_unix: d.updated_unix,
  };
  if (withSegments) {
    out.segments = segs.map((s) => ({
      seg_id: s.seg_id, idx: s.idx, speaker_id: s.speaker_id, start: s.start, end: s.end, text: s.text, translation: s.translation,
      has_audio: Boolean(s.audio_hash) && fs.existsSync(fileOf(d.dub_id, `seg_${s.seg_id}.wav`)),
      outdated: Boolean(s.translation.trim()) && s.audio_hash !== hashOf(d, s),
      placed_start: s.placed_start, placed_end: s.placed_end, stretch: s.stretch,
    }));
  }
  return out;
}

// ---------- queue ----------
const queue = []; // { id, kind: "full" | "render" }
let running = null;
const cancelled = new Set();
function enqueue(id, kind) {
  if (running?.id === id || queue.some((j) => j.id === id)) return;
  queue.push({ id, kind });
  setDub(id, { status: "queued", progress: 0, error: null });
  kick();
}
async function kick() {
  if (running || !queue.length) return;
  running = queue.shift();
  try { await run(running); } catch (e) {
    if (e.cancelled) { if (getDub(running.id)) setDub(running.id, { status: "cancelled", error: null }); }
    else { console.error(`[dubbing] ${running.id}:`, e.message); if (getDub(running.id)) setDub(running.id, { status: "failed", error: e.message }); }
  } finally { cancelled.delete(running.id); running = null; kick(); }
}
const stage = (id, status, progress = 0) => {
  if (cancelled.has(id) || !getDub(id)) throw Object.assign(new Error("cancelled"), { cancelled: true });
  setDub(id, { status, progress });
};

async function run({ id, kind }) {
  const t0 = Date.now();
  if (kind === "full") {
    await transcribeStage(id);
    await translateStage(id);
    await separateStage(id);
    await referenceStage(id);
  }
  await voiceStage(id);
  await mixStage(id);
  setDub(id, { status: "done", progress: 1, mixed: 1 });
  console.log(`[dubbing] ${id} ${kind} done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

// ---------- stages ----------
async function transcribeStage(id) {
  stage(id, "transcribing");
  const d = getDub(id);
  const samples16 = resample(await readWav(fileOf(id, "original.wav")), RATE, 16000);
  let words, speakers = null, lang = d.source_lang;
  if (qwen.canTranscribe()) {
    const out = await qwen.transcribe(samples16, { language: d.source_lang || null, diarize: qwen.canDiarize(), num_speakers: d.num_speakers });
    words = out.words; speakers = out.speakers; lang = d.source_lang || out.language;
  } else {
    if (!d.source_lang) throw httpError(422, "Pick the original language (detecting it needs Whisper large-v3-turbo).");
    const out = await local.transcribe(samples16, { language_code: d.source_lang });
    words = out.words.filter((w) => w.type === "word");
    if (qwen.canDiarize() && words.length) speakers = (await qwen.diarize(samples16, words, { num_speakers: d.num_speakers })).speakers;
  }
  if (!LANG_CODES.has(lang)) throw httpError(422, `The speech is in ${lang || "an unknown language"}. Dubbing works from ${LANGUAGES.map(([, n]) => n).join(", ")}.`);
  const segs = buildSegments(words, speakers, lang);
  if (!segs.length) throw httpError(422, "No speech was found in this file.");
  const order = [...new Set(segs.map((s) => s.speaker_id))];
  const prior = speakersOf(d);
  const list = order.map((sid, i) => ({ speaker_id: sid, name: `Speaker ${i + 1}`, voice_id: prior.find((p) => p.speaker_id === sid)?.voice_id ?? d.default_voice ?? null }));
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM dub_segments WHERE dub_id = ?").run(id);
    const ins = db.prepare("INSERT INTO dub_segments (seg_id, dub_id, idx, speaker_id, start, end, text) VALUES (?, ?, ?, ?, ?, ?, ?)");
    segs.forEach((s, i) => ins.run(dbm.newId(), id, i, s.speaker_id, s.start, s.end, s.text));
    db.prepare("UPDATE dubs SET source_lang = ?, speakers = ? WHERE dub_id = ?").run(lang, JSON.stringify(list), id);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

// Lines: a new one when the speaker changes, after a pause, or at a sentence end once a line is long.
export function buildSegments(words, speakers, lang) {
  const glue = ["zh", "ja"].includes(lang) ? "" : " ";
  const out = [];
  let cur = null;
  words.forEach((w, i) => {
    const text = String(w.text || "").trim();
    if (!text) return;
    const sp = speakers?.[i] || "speaker_0";
    const long = cur ? cur.end - cur.start : 0;
    const split = !cur || sp !== cur.speaker_id || w.start - cur.end > 0.8
      || (long > 8 && /[.!?。！？]$/.test(cur.text)) || long > 18;
    if (split) { cur = { speaker_id: sp, start: w.start, end: w.end, text }; out.push(cur); }
    else { cur.text += glue + text; cur.end = Math.max(cur.end, w.end); }
  });
  return out.filter((s) => /[\p{L}\p{N}]/u.test(s.text));
}

async function translateStage(id) {
  const d = getDub(id);
  const segs = segmentsOf(id);
  for (let i = 0; i < segs.length; i++) {
    stage(id, "translating", i / segs.length);
    const translation = await translate(segs[i].text, { from: d.source_lang, to: d.target_lang });
    db.prepare("UPDATE dub_segments SET translation = ? WHERE seg_id = ?").run(translation, segs[i].seg_id);
  }
}

// Background = original minus the isolated voices. Without Demucs (or when switched off) the
// dub has the new voices only.
async function separateStage(id) {
  const d = getDub(id);
  if (!d.keep_background || !qwen.canIsolate()) return;
  stage(id, "separating");
  const original = await readWav(fileOf(id, "original.wav"));
  const out = await qwen.isolate(original, RATE);
  const vocals = resample(out.samples, out.rate, RATE);
  const bg = new Float32Array(original.length);
  for (let i = 0; i < bg.length; i++) bg[i] = original[i] - (vocals[i] || 0);
  writeWav(fileOf(id, "vocals.wav"), vocals);
  writeWav(fileOf(id, "background.wav"), bg);
}

// A reference clip per speaker from their own longest lines (up to ~12 s), plus what they say in
// it; Qwen3-TTS clones the voice from that to speak the translation.
async function referenceStage(id) {
  const d = getDub(id);
  stage(id, "voicing");
  const src = await readWav(fs.existsSync(fileOf(id, "vocals.wav")) ? fileOf(id, "vocals.wav") : fileOf(id, "original.wav"));
  const segs = segmentsOf(id);
  // Every speaker gets a sample, so their own voice stays available after picking another one.
  for (const sp of speakersOf(d)) {
    const mine = segs.filter((s) => s.speaker_id === sp.speaker_id).sort((a, b) => (b.end - b.start) - (a.end - a.start));
    const picked = [];
    let total = 0;
    for (const s of mine) { if (total >= REF_SECONDS) break; picked.push(s); total += s.end - s.start; }
    picked.sort((a, b) => a.start - b.start);
    const parts = [];
    for (const s of picked) {
      const from = Math.max(0, Math.floor((s.start - 0.05) * RATE)), to = Math.min(src.length, Math.ceil((s.end + 0.1) * RATE));
      parts.push(src.subarray(from, to), new Float32Array(Math.round(0.25 * RATE)));
    }
    const clip = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) { clip.set(p, off); off += p.length; }
    writeWav(fileOf(id, `ref_${sp.speaker_id}.wav`), clip.subarray(0, Math.min(clip.length, 20 * RATE)));
    fs.writeFileSync(fileOf(id, `ref_${sp.speaker_id}.txt`), picked.map((s) => s.text).join(" "));
  }
}

async function voiceFor(d, speaker_id) {
  const sp = speakersOf(d).find((s) => s.speaker_id === speaker_id);
  if (sp?.voice_id) return deps.findVoice(sp.voice_id);
  const ref = fileOf(d.dub_id, `ref_${speaker_id}.wav`);
  if (!qwen.canClone()) throw httpError(503, "Keeping the original voices needs the Qwen3-TTS Base model. Pick a voice for each speaker instead.");
  if (!fs.existsSync(ref)) throw httpError(409, `No voice sample for ${sp?.name || speaker_id}. Pick a voice for this speaker.`);
  return { voice_id: `dub_${d.dub_id}_${speaker_id}`, name: sp?.name || speaker_id, provider: "qwen", style_instructions: false, qwen: { ref_audio: ref, ref_text: fs.readFileSync(fileOf(d.dub_id, `ref_${speaker_id}.txt`), "utf8") } };
}
async function speakLine(voice, text, lang) {
  if (voice.provider === "elevenlabs") {
    const out = await el.tts(voice.voice_id, { text: toElevenLabs(text, pronounce), model_id: "eleven_multilingual_v2", language_code: lang }, "pcm_24000");
    return pcm16ToFloat(out.buffer);
  }
  const chunks = [];
  for await (const p of deps.speakParts(voice, text, { language: lang })) chunks.push(resample(p.samples, p.rate, RATE));
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// Lines grouped by voice kind so Qwen models load once each, like Dialogue.
async function voiceStage(id) {
  const d = getDub(id);
  const todo = segmentsOf(id).filter((s) => parseTags(s.translation).some((x) => x.type === "speech")
    && (s.audio_hash !== hashOf(d, s) || !fs.existsSync(fileOf(id, `seg_${s.seg_id}.wav`))));
  const voices = new Map();
  for (const s of todo) if (!voices.has(s.speaker_id)) voices.set(s.speaker_id, await voiceFor(d, s.speaker_id));
  const group = (v) => (v.provider === "local" ? "0" : v.provider === "qwen" ? (v.style_instructions ? "1" : "2") : "3");
  todo.sort((a, b) => group(voices.get(a.speaker_id)).localeCompare(group(voices.get(b.speaker_id))) || a.idx - b.idx);
  for (let i = 0; i < todo.length; i++) {
    stage(id, "dubbing", i / todo.length);
    const s = todo[i];
    const audio = await speakLine(voices.get(s.speaker_id), s.translation, d.target_lang);
    writeWav(fileOf(id, `seg_${s.seg_id}.wav`), trimSilence(audio));
    db.prepare("UPDATE dub_segments SET audio_hash = ? WHERE seg_id = ?").run(hashOf(d, s), s.seg_id);
  }
}

function trimSilence(x, threshold = 0.01) {
  let a = 0, b = x.length - 1;
  while (a < b && Math.abs(x[a]) < threshold) a++;
  while (b > a && Math.abs(x[b]) < threshold) b--;
  const pad = Math.round(0.03 * RATE);
  return x.slice(Math.max(0, a - pad), Math.min(x.length, b + pad));
}

// Each line starts where the original did (or right after the previous dubbed line if that ran
// over). A line longer than the room before the next one is sped up by up to 30%.
async function mixStage(id) {
  stage(id, "mixing");
  const d = getDub(id);
  const segs = segmentsOf(id);
  const usable = (s) => s.translation.trim() && fs.existsSync(fileOf(id, `seg_${s.seg_id}.wav`));
  const placed = [];
  let cursor = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (!usable(s)) continue;
    let a = await readWav(fileOf(id, `seg_${s.seg_id}.wav`));
    const start = Math.max(s.start, cursor);
    const nextStart = segs.slice(i + 1).find(usable)?.start ?? Math.max(d.duration, s.end);
    const room = Math.max(0.3, nextStart - start);
    const factor = a.length / RATE > room ? Math.min(MAX_STRETCH, a.length / RATE / room) : 1;
    if (factor > 1.02) a = timeStretch(a, RATE, factor);
    const end = start + a.length / RATE;
    placed.push({ s, a, start, end, factor });
    cursor = end + 0.05;
  }
  const total = Math.max(d.duration, cursor);
  const mix = new Float32Array(Math.ceil(total * RATE) + 1);
  const bgFile = fileOf(id, "background.wav");
  if (d.keep_background && fs.existsSync(bgFile)) { const bg = await readWav(bgFile); mix.set(bg.subarray(0, Math.min(bg.length, mix.length))); }
  db.prepare("UPDATE dub_segments SET placed_start = NULL, placed_end = NULL, stretch = NULL WHERE dub_id = ?").run(id);
  const upd = db.prepare("UPDATE dub_segments SET placed_start = ?, placed_end = ?, stretch = ? WHERE seg_id = ?");
  for (const p of placed) {
    const off = Math.round(p.start * RATE);
    for (let i = 0; i < p.a.length && off + i < mix.length; i++) mix[off + i] += p.a[i];
    upd.run(p.start, p.end, Math.round(p.factor * 100) / 100, p.s.seg_id);
  }
  let peak = 0;
  for (let i = 0; i < mix.length; i++) peak = Math.max(peak, Math.abs(mix[i]));
  if (peak > 0.98) for (let i = 0; i < mix.length; i++) mix[i] *= 0.98 / peak;
  writeWav(fileOf(id, "dub.wav"), mix);
}

// ---------- subtitles ----------
const stamp = (t, sep) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(ms % 1000).padStart(3, "0")}`;
};
function subtitles(d, { format, original }) {
  const names = Object.fromEntries(speakersOf(d).map((s) => [s.speaker_id, s.name]));
  const multi = speakersOf(d).length > 1;
  const cues = segmentsOf(d.dub_id).filter((s) => (original ? s.text : s.translation).trim()).map((s, i) => {
    const start = original ? s.start : s.placed_start ?? s.start;
    const end = original ? s.end : s.placed_end ?? s.end;
    const words = parseTags(original ? s.text : s.translation).filter((x) => x.type === "speech").map((x) => x.text).join(" ");
    const text = multi ? `${names[s.speaker_id] || s.speaker_id}: ${words}` : words;
    return format === "vtt" ? `${stamp(start, ".")} --> ${stamp(end, ".")}\n${text}` : `${i + 1}\n${stamp(start, ",")} --> ${stamp(end, ",")}\n${text}`;
  });
  return (format === "vtt" ? "WEBVTT\n\n" : "") + cues.join("\n\n") + "\n";
}

// ---------- routes ----------
export function registerDubbing(d) {
  deps = d;
  const { route, readForm, readJson, json, formFile } = d;
  const dub = (id) => { const x = getDub(id); if (!x) throw httpError(404, "Dub not found"); return x; };
  const checkVoice = async (voice_id, target) => {
    if (!voice_id) { if (!qwen.canClone()) throw httpError(422, "Keeping the original voices needs the Qwen3-TTS Base model. Pick a voice instead."); return; }
    const v = await d.findVoice(voice_id);
    if (v.provider === "local" && target !== "en") throw httpError(422, `${v.name} speaks English only. Pick a Qwen3 or ElevenLabs voice for ${languageName(target)}.`);
  };
  const segOf = (x, sid) => {
    const s = db.prepare("SELECT * FROM dub_segments WHERE seg_id = ? AND dub_id = ?").get(sid, x.dub_id);
    if (!s) throw httpError(404, "Line not found");
    return s;
  };
  const shapeSeg = (id, sid) => shapeDub(getDub(id), true).segments.find((y) => y.seg_id === sid);

  route("GET", "/api/dubbing/meta", async (req, res) => json(res, 200, {
    languages: LANGUAGES.map(([code, name]) => ({ code, name })),
    can_detect: qwen.canTranscribe(), can_clone: qwen.canClone(), can_separate: qwen.canIsolate(), can_diarize: qwen.canDiarize(),
    max_seconds: MAX_SECONDS,
    // Which model translates each pair ("en>es": "Opus-MT"), shown in the New dub dialog.
    translators: Object.fromEntries(LANGUAGES.flatMap(([a]) => LANGUAGES.filter(([b]) => b !== a).map(([b]) => [`${a}>${b}`, translatorName(a, b)]))),
  }));
  route("GET", "/api/dubbing", async (req, res) => json(res, 200, { dubs: db.prepare("SELECT * FROM dubs ORDER BY updated_unix DESC").all().map((x) => shapeDub(x)) }));
  route("GET", "/api/dubbing/:id", async (req, res, p) => json(res, 200, shapeDub(dub(p.id), true)));

  route("POST", "/api/dubbing", async (req, res) => {
    const form = await readForm(req);
    const file = await formFile(form, "file");
    const target = String(form.get("target_lang") || "");
    const source = String(form.get("source_lang") || "") || null;
    if (!LANG_CODES.has(target)) throw httpError(422, `target_lang must be one of ${[...LANG_CODES].join(", ")}`);
    if (source && !LANG_CODES.has(source)) throw httpError(422, `source_lang must be one of ${[...LANG_CODES].join(", ")}, or empty to detect it`);
    if (!source && !qwen.canTranscribe()) throw httpError(422, "Pick the original language (detecting it needs Whisper large-v3-turbo).");
    const num = form.get("num_speakers") ? Number(form.get("num_speakers")) : null;
    if (num !== null && !(Number.isInteger(num) && num >= 1 && num <= 10)) throw httpError(422, "num_speakers must be a whole number from 1 to 10");
    const voice = String(form.get("voice_id") || "") || null; // empty: keep each speaker's own voice
    await checkVoice(voice, target);
    const decoded = await decodeToMono(file.buffer, RATE);
    if (decoded.duration > MAX_SECONDS + 1) throw httpError(422, `Files can be at most ${MAX_SECONDS / 60} minutes long`);
    if (decoded.duration < 1) throw httpError(422, "The file is too short to dub");
    const id = `dub_${dbm.newId()}`;
    fs.mkdirSync(dirOf(id), { recursive: true });
    writeWav(fileOf(id, "original.wav"), decoded.samples);
    const title = String(form.get("title") || file.name || "Dub").replace(/\.[a-z0-9]{2,4}$/i, "").trim().slice(0, 120) || "Dub";
    const keep = !["false", "0", "off"].includes(String(form.get("keep_background") ?? "true"));
    db.prepare("INSERT INTO dubs (dub_id, title, source_lang, target_lang, duration, keep_background, num_speakers, default_voice, created_unix, updated_unix) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, title, source, target, decoded.duration, keep ? 1 : 0, num, voice, dbm.now(), dbm.now());
    enqueue(id, "full");
    json(res, 200, shapeDub(getDub(id), true));
  });

  route("PATCH", "/api/dubbing/:id", async (req, res, p) => {
    const x = dub(p.id);
    const body = await readJson(req);
    if ("title" in body) {
      const t = String(body.title || "").trim().slice(0, 120);
      if (!t) throw httpError(422, "title can't be empty");
      setDub(x.dub_id, { title: t });
    }
    if (Array.isArray(body.speakers)) {
      const cur = speakersOf(x);
      for (const s of body.speakers) {
        const c = cur.find((y) => y.speaker_id === s?.speaker_id);
        if (!c) throw httpError(422, `Unknown speaker '${s?.speaker_id}'`);
        if ("name" in s) c.name = String(s.name || "").trim().slice(0, 40) || c.name;
        if ("voice_id" in s) {
          const v = s.voice_id || null;
          await checkVoice(v, x.target_lang);
          if (!v && segmentsOf(x.dub_id).length && !fs.existsSync(fileOf(x.dub_id, `ref_${c.speaker_id}.wav`))) throw httpError(422, `There's no sample of ${c.name}'s own voice. Pick a voice instead.`);
          c.voice_id = v;
        }
      }
      setDub(x.dub_id, { speakers: JSON.stringify(cur) });
    }
    json(res, 200, shapeDub(getDub(x.dub_id), true));
  });

  route("PATCH", "/api/dubbing/:id/segments/:sid", async (req, res, p) => {
    const x = dub(p.id);
    const s = segOf(x, p.sid);
    const body = await readJson(req);
    if ("translation" in body) db.prepare("UPDATE dub_segments SET translation = ? WHERE seg_id = ?").run(String(body.translation ?? "").slice(0, 2000), s.seg_id);
    if ("speaker_id" in body) {
      if (!speakersOf(x).some((y) => y.speaker_id === body.speaker_id)) throw httpError(422, `Unknown speaker '${body.speaker_id}'`);
      db.prepare("UPDATE dub_segments SET speaker_id = ? WHERE seg_id = ?").run(body.speaker_id, s.seg_id);
    }
    setDub(x.dub_id, {});
    json(res, 200, shapeSeg(x.dub_id, s.seg_id));
  });

  route("POST", "/api/dubbing/:id/segments/:sid/retranslate", async (req, res, p) => {
    const x = dub(p.id);
    const s = segOf(x, p.sid);
    const translation = await translate(s.text, { from: x.source_lang, to: x.target_lang });
    db.prepare("UPDATE dub_segments SET translation = ? WHERE seg_id = ?").run(translation, s.seg_id);
    json(res, 200, shapeSeg(x.dub_id, s.seg_id));
  });

  // Voices the lines that changed and mixes again (or starts over if it never got that far).
  route("POST", "/api/dubbing/:id/render", async (req, res, p) => {
    const x = dub(p.id);
    if (WORKING.includes(x.status)) throw httpError(409, "This dub is still being made. Wait for it to finish or cancel it.");
    enqueue(x.dub_id, segmentsOf(x.dub_id).some((s) => s.translation) ? "render" : "full");
    json(res, 200, shapeDub(getDub(x.dub_id)));
  });
  route("POST", "/api/dubbing/:id/cancel", async (req, res, p) => {
    const x = dub(p.id);
    const i = queue.findIndex((j) => j.id === x.dub_id);
    if (i >= 0) { queue.splice(i, 1); setDub(x.dub_id, { status: "cancelled" }); }
    if (running?.id === x.dub_id) cancelled.add(x.dub_id);
    json(res, 200, { status: "ok" });
  });
  route("DELETE", "/api/dubbing/:id", async (req, res, p) => {
    const x = dub(p.id);
    const i = queue.findIndex((j) => j.id === x.dub_id);
    if (i >= 0) queue.splice(i, 1);
    if (running?.id === x.dub_id) cancelled.add(x.dub_id);
    db.prepare("DELETE FROM dub_segments WHERE dub_id = ?").run(x.dub_id);
    db.prepare("DELETE FROM dubs WHERE dub_id = ?").run(x.dub_id);
    fs.rmSync(dirOf(x.dub_id), { recursive: true, force: true });
    json(res, 200, { status: "ok" });
  });

  // Answers Range requests too: a browser can only seek in audio served that way.
  const sendFile = (res, buf, type, name, download, req) => {
    const disp = download ? { "content-disposition": `attachment; filename="${name.replace(/[^\w .()-]+/g, "_")}"` } : {};
    const head = { "content-type": type, "cache-control": "no-store", "accept-ranges": "bytes", ...disp };
    const m = req?.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : Math.max(0, buf.length - Number(m[2]));
      let end = m[1] && m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
      if (start >= buf.length || start > end) { res.writeHead(416, { "content-range": `bytes */${buf.length}` }); return res.end(); }
      res.writeHead(206, { ...head, "content-range": `bytes ${start}-${end}/${buf.length}`, "content-length": end - start + 1 });
      return res.end(buf.subarray(start, end + 1));
    }
    res.writeHead(200, { ...head, "content-length": buf.length });
    res.end(buf);
  };
  route("GET", "/api/dubbing/:id/audio", async (req, res, p, q) => {
    const x = dub(p.id);
    const file = fileOf(x.dub_id, "dub.wav");
    if (!x.mixed || !fs.existsSync(file)) throw httpError(404, "This dub has no audio yet");
    const name = `${x.title} (${languageName(x.target_lang)})`;
    if (q.get("format") === "wav") return sendFile(res, fs.readFileSync(file), "audio/wav", `${name}.wav`, q.get("download"), req);
    sendFile(res, encodeMp3(await readWav(file), RATE, 128), "audio/mpeg", `${name}.mp3`, q.get("download"), req);
  });
  route("GET", "/api/dubbing/:id/segments/:sid/audio", async (req, res, p) => {
    const file = fileOf(dub(p.id).dub_id, `seg_${p.sid}.wav`);
    if (!fs.existsSync(file)) throw httpError(404, "This line has no audio yet");
    sendFile(res, fs.readFileSync(file), "audio/wav", "line.wav", false, req);
  });
  route("GET", "/api/dubbing/:id/subtitles", async (req, res, p, q) => {
    const x = dub(p.id);
    const format = q.get("format") === "vtt" ? "vtt" : "srt";
    const original = q.get("original") === "1";
    const lang = languageName(original ? x.source_lang : x.target_lang);
    sendFile(res, Buffer.from(subtitles(x, { format, original })), format === "vtt" ? "text/vtt; charset=utf-8" : "application/x-subrip; charset=utf-8", `${x.title} (${lang}).${format}`, q.get("download"));
  });

  // Picks up work that was waiting or running when the server stopped.
  for (const x of db.prepare(`SELECT dub_id FROM dubs WHERE status IN (${WORKING.map(() => "?").join(",")}) ORDER BY updated_unix`).all(...WORKING)) {
    enqueue(x.dub_id, segmentsOf(x.dub_id).some((s) => s.translation) ? "render" : "full");
  }
}
