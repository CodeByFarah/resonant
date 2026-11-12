// SQLite persistence (node:sqlite) for history, transcripts, voices and settings.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// The data folder sits next to the code (<Resonant>/data), whatever folder the server is started
// from. RESONANT_DATA_DIR moves it elsewhere; the desktop app points it at the user's app-data folder.
export const DATA_DIR = process.env.RESONANT_DATA_DIR
  ? path.resolve(process.env.RESONANT_DATA_DIR)
  : path.join(import.meta.dirname, "..", "data");
export const AUDIO_DIR = path.join(DATA_DIR, "audio");
fs.mkdirSync(AUDIO_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "resonant.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS history (
    history_item_id TEXT PRIMARY KEY,
    date_unix INTEGER NOT NULL,
    source TEXT NOT NULL,
    voice_id TEXT,
    voice_name TEXT,
    voice_category TEXT,
    model_id TEXT,
    text TEXT,
    settings TEXT,
    content_type TEXT NOT NULL,
    audio_file TEXT NOT NULL,
    character_count INTEGER NOT NULL DEFAULT 0,
    duration REAL,
    feedback TEXT
  );
  CREATE INDEX IF NOT EXISTS history_date ON history(date_unix DESC);
  CREATE TABLE IF NOT EXISTS transcripts (
    transcription_id TEXT PRIMARY KEY,
    date_unix INTEGER NOT NULL,
    file_name TEXT,
    language_code TEXT,
    text TEXT NOT NULL,
    words TEXT NOT NULL,
    duration REAL,
    model_id TEXT
  );
  CREATE TABLE IF NOT EXISTS voice_meta (
    voice_id TEXT PRIMARY KEY,
    in_my_voices INTEGER NOT NULL DEFAULT 0,
    favorite INTEGER NOT NULL DEFAULT 0,
    date_unix INTEGER
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS cloned_voices (
    voice_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    labels TEXT,
    ref_file TEXT NOT NULL,
    ref_text TEXT,
    date_unix INTEGER NOT NULL
  );
`);

// Shared handle for modules that keep their own tables (server/studio.mjs).
export const database = db;
export const newId = () => crypto.randomBytes(15).toString("base64url").slice(0, 20);
export const now = () => Math.floor(Date.now() / 1000);

export function getSetting(key, fallback = null) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? JSON.parse(row.value) : fallback;
}
export function setSetting(key, value) {
  if (value === null || value === undefined) db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  else db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
}

export function saveAudio(id, ext, buf) {
  const file = `${id}.${ext}`;
  fs.writeFileSync(path.join(AUDIO_DIR, file), buf);
  return file;
}

export function addHistory(item) {
  const id = item.id || newId();
  const file = saveAudio(id, item.ext, item.audio);
  db.prepare(`INSERT INTO history (history_item_id, date_unix, source, voice_id, voice_name, voice_category, model_id, text, settings, content_type, audio_file, character_count, duration)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, now(), item.source, item.voice_id ?? null, item.voice_name ?? null, item.voice_category ?? null, item.model_id ?? null,
    item.text ?? null, JSON.stringify(item.settings ?? {}), item.content_type, file, item.character_count ?? 0, item.duration ?? null);
  return id;
}

function shapeHistory(r) {
  return {
    history_item_id: r.history_item_id,
    request_id: r.history_item_id,
    date_unix: r.date_unix,
    source: r.source,
    voice_id: r.voice_id,
    voice_name: r.voice_name,
    voice_category: r.voice_category,
    model_id: r.model_id,
    text: r.text,
    settings: JSON.parse(r.settings || "{}"),
    content_type: r.content_type,
    character_count: r.character_count,
    duration: r.duration,
    feedback: r.feedback ? JSON.parse(r.feedback) : null,
    state: "created",
  };
}

export function listHistory({ page_size = 100, start_after_history_item_id, voice_id, model_id, source, search, sort_direction = "desc" } = {}) {
  const where = [];
  const args = [];
  const dir = sort_direction === "asc" ? "ASC" : "DESC";
  if (start_after_history_item_id) {
    const ref = db.prepare("SELECT date_unix, rowid FROM history WHERE history_item_id = ?").get(start_after_history_item_id);
    if (ref) { where.push(`(date_unix, rowid) ${dir === "DESC" ? "<" : ">"} (?, ?)`); args.push(ref.date_unix, ref.rowid); }
  }
  if (voice_id) { where.push("voice_id = ?"); args.push(voice_id); }
  if (model_id) { where.push("model_id = ?"); args.push(model_id); }
  if (source) { where.push("source = ?"); args.push(source); }
  if (search) { where.push("(text LIKE ? OR voice_name LIKE ?)"); args.push(`%${search}%`, `%${search}%`); }
  const size = Math.min(Math.max(Number(page_size) || 100, 1), 1000);
  const rows = db.prepare(`SELECT * FROM history ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY date_unix ${dir}, rowid ${dir} LIMIT ?`).all(...args, size + 1);
  const has_more = rows.length > size;
  const history = rows.slice(0, size).map(shapeHistory);
  return { history, has_more, last_history_item_id: history.at(-1)?.history_item_id ?? null, scanned_until: history.at(-1)?.date_unix ?? null };
}

export function getHistory(id) {
  const r = db.prepare("SELECT * FROM history WHERE history_item_id = ?").get(id);
  return r ? { ...shapeHistory(r), audio_file: r.audio_file } : null;
}

export function deleteHistory(id) {
  const r = db.prepare("SELECT audio_file FROM history WHERE history_item_id = ?").get(id);
  if (!r) return false;
  db.prepare("DELETE FROM history WHERE history_item_id = ?").run(id);
  fs.rmSync(path.join(AUDIO_DIR, r.audio_file), { force: true });
  return true;
}

export function setHistoryFeedback(id, feedback) {
  return db.prepare("UPDATE history SET feedback = ? WHERE history_item_id = ?").run(JSON.stringify(feedback), id).changes > 0;
}

export function characterUsage(sinceUnix = 0) {
  return db.prepare("SELECT COALESCE(SUM(character_count), 0) AS n FROM history WHERE date_unix >= ?").get(sinceUnix).n;
}

export function historyStats() {
  return db.prepare("SELECT source, COUNT(*) AS n FROM history GROUP BY source").all();
}

export function addTranscript(t) {
  const id = newId();
  db.prepare("INSERT INTO transcripts VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    id, now(), t.file_name ?? null, t.language_code ?? null, t.text, JSON.stringify(t.words), t.duration ?? null, t.model_id ?? null);
  return id;
}
export function listTranscripts() {
  return db.prepare("SELECT transcription_id, date_unix, file_name, language_code, substr(text, 1, 200) AS preview, duration, model_id FROM transcripts ORDER BY date_unix DESC").all();
}
export function getTranscript(id) {
  const r = db.prepare("SELECT * FROM transcripts WHERE transcription_id = ?").get(id);
  return r ? { ...r, words: JSON.parse(r.words) } : null;
}
export function deleteTranscript(id) {
  return db.prepare("DELETE FROM transcripts WHERE transcription_id = ?").run(id).changes > 0;
}

export const VOICE_DIR = path.join(DATA_DIR, "voices");
fs.mkdirSync(VOICE_DIR, { recursive: true });

export function addClonedVoice({ name, description, labels, ref_audio, ref_text }) {
  const voice_id = "clone_" + newId();
  const ref_file = `${voice_id}.wav`;
  fs.writeFileSync(path.join(VOICE_DIR, ref_file), ref_audio);
  db.prepare("INSERT INTO cloned_voices VALUES (?, ?, ?, ?, ?, ?, ?)").run(voice_id, name, description ?? null, JSON.stringify(labels ?? {}), ref_file, ref_text ?? null, now());
  setVoiceMeta(voice_id, { in_my_voices: true });
  return voice_id;
}
export function listClonedVoices() {
  return db.prepare("SELECT * FROM cloned_voices ORDER BY date_unix DESC").all()
    .map((r) => ({ ...r, labels: JSON.parse(r.labels || "{}"), ref_path: path.join(VOICE_DIR, r.ref_file) }));
}
export function deleteClonedVoice(voice_id) {
  const r = db.prepare("SELECT ref_file FROM cloned_voices WHERE voice_id = ?").get(voice_id);
  if (!r) return false;
  db.prepare("DELETE FROM cloned_voices WHERE voice_id = ?").run(voice_id);
  db.prepare("DELETE FROM voice_meta WHERE voice_id = ?").run(voice_id);
  fs.rmSync(path.join(VOICE_DIR, r.ref_file), { force: true });
  return true;
}

export function voiceMeta() {
  return Object.fromEntries(db.prepare("SELECT * FROM voice_meta").all().map((r) => [r.voice_id, r]));
}
export function setVoiceMeta(voice_id, patch) {
  const cur = db.prepare("SELECT * FROM voice_meta WHERE voice_id = ?").get(voice_id) || { in_my_voices: 0, favorite: 0, date_unix: now() };
  const next = { ...cur, ...patch };
  db.prepare(`INSERT INTO voice_meta(voice_id, in_my_voices, favorite, date_unix) VALUES(?, ?, ?, ?)
    ON CONFLICT(voice_id) DO UPDATE SET in_my_voices = excluded.in_my_voices, favorite = excluded.favorite`).run(
    voice_id, next.in_my_voices ? 1 : 0, next.favorite ? 1 : 0, next.date_unix ?? now());
}
