// HTTP server: ElevenLabs-compatible REST API plus the web app's static files.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as db from "./db.mjs";
import * as local from "./engines/local.mjs";
import * as el from "./engines/elevenlabs.mjs";
import * as qwen from "./engines/qwen.mjs";
import { registerStudio } from "./studio.mjs";
import { registerDubbing } from "./dubbing.mjs";
import { registerPronunciation, apply as pronounce } from "./pronunciation.mjs";
import * as system from "./system.mjs";
import { parseTags, spokenLength, toElevenLabs } from "./tags.mjs";
import { parseOutputFormat, encode, encodeMp3, encodeWav, mp3Writer, decodeToMono, concat, resample, silence, pcm16ToFloat, httpError } from "./audio.mjs";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const VERSION = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, "..", "package.json"), "utf8")).version;
const PREVIEW_DIR = path.join(db.DATA_DIR, "previews");
const MAX_BODY = 50 * 1024 * 1024;
const MAX_TTS_CHARS = 20000;
// First streamed piece: about one sentence, so the first audio arrives in a fraction of the full time.
const STREAM_FIRST_CHARS = 80;
const MAX_CLONE_REF_SECONDS = 20;
fs.mkdirSync(PREVIEW_DIR, { recursive: true });

// Optional single-user auth: set RESONANT_API_KEY to require it on every API call.
const REQUIRED_KEY = process.env.RESONANT_API_KEY || null;

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  routes.push({ method, re, keys, handler });
};

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const audio = (res, buf, contentType, extra = {}) => {
  res.writeHead(200, { "content-type": contentType, "content-length": buf.length, "access-control-expose-headers": "history-item-id, x-transcript", ...extra });
  res.end(buf);
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw httpError(413, "Request body too large (max 50 MB)");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString("utf8")); } catch { throw httpError(400, "Invalid JSON body"); }
}
async function readForm(req) {
  const buf = await readBody(req);
  const r = new Request("http://x/", { method: "POST", headers: { "content-type": req.headers["content-type"] || "" }, body: buf });
  try { return await r.formData(); } catch { throw httpError(400, "Expected multipart/form-data"); }
}
async function formFile(form, field) {
  const f = form.get(field);
  if (!f || typeof f === "string") throw httpError(422, `Missing file field '${field}'`);
  return { buffer: Buffer.from(await f.arrayBuffer()), name: f.name || "audio", type: f.type };
}

// ---------- voices ----------
let kokoroVoiceCache = null;
function clonedVoices() {
  return db.listClonedVoices().map((c) => ({
    voice_id: c.voice_id,
    name: c.name,
    category: c.labels?.designed ? "generated" : "cloned",
    provider: "qwen",
    description: c.description || (c.labels?.designed ? "Your designed voice" : "Your cloned voice"),
    labels: { ...c.labels, language: "multilingual" },
    preview_url: `/v1/voices/${c.voice_id}/preview`,
    settings: {},
    high_quality_base_model_ids: [qwen.model().model_id],
    style_instructions: false,
    date_unix: c.date_unix,
    qwen: { ref_audio: c.ref_path, ref_text: c.ref_text },
  }));
}
async function localVoices() {
  if (!kokoroVoiceCache) kokoroVoiceCache = await local.listVoices();
  return [...kokoroVoiceCache, ...qwen.presetVoices(), ...qwen.libraryVoices(), ...clonedVoices()];
}
// Internal fields (reference file paths) never leave the server.
const publicVoice = ({ qwen: _q, ...v }) => v;
let elVoiceCache = { at: 0, voices: [] };
async function remoteVoices({ fresh = false } = {}) {
  if (!el.enabled()) return [];
  if (fresh || Date.now() - elVoiceCache.at > 5 * 60_000) elVoiceCache = { at: Date.now(), voices: await el.listVoices() };
  return elVoiceCache.voices;
}
async function allVoices() {
  const meta = db.voiceMeta();
  let remote = [];
  try { remote = await remoteVoices(); } catch (e) { console.warn("[elevenlabs] voices:", e.message); }
  return [...(await localVoices()), ...remote].map((v) => ({
    ...publicVoice(v),
    is_favorite: Boolean(meta[v.voice_id]?.favorite),
    // Voices you made (cloned, designed, or in your ElevenLabs account) are always in My Voices.
    in_my_voices: Boolean(meta[v.voice_id]?.in_my_voices) || v.category !== "premade",
  }));
}
async function findVoice(id) {
  const v = (await localVoices()).find((x) => x.voice_id === id);
  if (v) return v;
  const r = (await remoteVoices()).find((x) => x.voice_id === id);
  if (r) return r;
  throw httpError(404, `Voice '${id}' not found`);
}

route("GET", "/v2/voices", async (req, res, p, q) => {
  let voices = await allVoices();
  const search = (q.get("search") || "").toLowerCase();
  if (search) voices = voices.filter((v) => [v.name, v.description, ...Object.values(v.labels || {})].join(" ").toLowerCase().includes(search));
  for (const k of ["gender", "accent", "language"]) if (q.get(k)) voices = voices.filter((v) => v.labels?.[k] === q.get(k));
  if (q.get("category")) voices = voices.filter((v) => v.category === q.get("category"));
  if (q.get("provider")) voices = voices.filter((v) => v.provider === q.get("provider"));
  if (q.get("voice_type") === "personal") voices = voices.filter((v) => v.in_my_voices);
  if (q.get("voice_type") === "favorite") voices = voices.filter((v) => v.is_favorite);
  const size = Math.min(Number(q.get("page_size")) || 100, 500);
  const start = Number(q.get("next_page_token")) || 0;
  json(res, 200, { voices: voices.slice(start, start + size), has_more: start + size < voices.length, total_count: voices.length, next_page_token: start + size < voices.length ? String(start + size) : null });
});
route("GET", "/v1/voices", async (req, res) => json(res, 200, { voices: await allVoices() }));
route("GET", "/v1/voices/:id", async (req, res, p) => json(res, 200, publicVoice(await findVoice(p.id))));

// ---------- local synthesis (Kokoro or Qwen3-TTS, by voice) ----------
const QWEN_LANGS = { en: "english", zh: "chinese", ja: "japanese", ko: "korean", de: "german", fr: "french", ru: "russian", pt: "portuguese", es: "spanish", it: "italian" };
function localEngine(voice, { speed, language, instructions, first, signal } = {}) {
  if (voice.provider === "qwen") {
    const lang = QWEN_LANGS[language] || language || "auto";
    return { model_id: qwen.model().model_id, parts: (text) => qwen.synthesize(text, voice, { language: lang, instruct: instructions, first, signal }) };
  }
  return { model_id: local.MODELS.tts.model_id, parts: (text) => local.synthesize(text, { voice_id: voice.voice_id, speed, first }) };
}
async function synthesizeAll(parts) {
  const chunks = [];
  let rate = 24000;
  for await (const p of parts) { chunks.push(p.samples); rate = p.rate; }
  return { samples: concat(chunks), rate };
}
// Speaks text that may hold inline tags with a local voice: [pause 1s] becomes silence, and
// style tags ([whisper], [excited]) become the instruction for Qwen3 preset voices. Voices that
// can't take instructions read the same words in their usual style. The pronunciation
// dictionary is applied to the words only, never to the tags.
async function* speakParts(voice, text, { speed, language, instructions, first, signal } = {}) {
  const segs = parseTags(text);
  const engineFor = (seg) => localEngine(voice, { speed, language, first, signal, instructions: voice.style_instructions ? seg.style || instructions : undefined });
  // Plain text streams chunk by chunk, as before.
  if (segs.length === 1 && segs[0].type === "speech") { yield* engineFor(segs[0]).parts(pronounce(segs[0].text)); return; }
  // With tags, each piece is spoken whole and the silence the voices leave at its edges is cut,
  // so [pause 2s] is two seconds and not two plus the padding on either side.
  let rate = 24000;
  for (const seg of segs) {
    if (seg.type === "pause") { if (seg.seconds > 0) yield { samples: silence(seg.seconds, rate), rate }; continue; }
    const out = await synthesizeAll(engineFor(seg).parts(pronounce(seg.text)));
    rate = out.rate;
    yield { samples: trimEdges(out.samples, rate), rate };
  }
}
function trimEdges(x, rate, threshold = 0.01) {
  let a = 0, b = x.length - 1;
  while (a < b && Math.abs(x[a]) < threshold) a++;
  while (b > a && Math.abs(x[b]) < threshold) b--;
  const pad = Math.round(0.08 * rate);
  return x.subarray(Math.max(0, a - pad), Math.min(x.length, b + pad + 1));
}
function checkSpeakable(text) {
  if (!parseTags(text).some((s) => s.type === "speech")) throw httpError(422, "There's nothing to say: the text only has tags");
}

route("GET", "/v1/voices/:id/preview", async (req, res, p) => {
  const v = await findVoice(p.id);
  if (v.provider === "elevenlabs") {
    if (!v.preview_url) throw httpError(404, "No preview for this voice");
    res.writeHead(302, { location: v.preview_url });
    return res.end();
  }
  // A cloned voice previews with the sample it was cloned from.
  if (v.qwen?.ref_audio) return audio(res, fs.readFileSync(v.qwen.ref_audio), "audio/wav", { "cache-control": "private, max-age=3600" });
  const file = path.join(PREVIEW_DIR, `${v.voice_id}.mp3`);
  if (!fs.existsSync(file)) {
    const out = await synthesizeAll(localEngine(v).parts(local.previewText.replace("Hello!", `Hello, I'm ${v.name}.`)));
    fs.writeFileSync(file, encodeMp3(out.samples, out.rate, 96));
  }
  audio(res, fs.readFileSync(file), "audio/mpeg", { "cache-control": "public, max-age=86400" });
});

route("POST", "/api/voices/:id/meta", async (req, res, p) => {
  await findVoice(p.id);
  const body = await readJson(req);
  const patch = {};
  if ("favorite" in body) patch.favorite = Boolean(body.favorite);
  if ("in_my_voices" in body) patch.in_my_voices = Boolean(body.in_my_voices);
  db.setVoiceMeta(p.id, patch);
  json(res, 200, { status: "ok" });
});

route("POST", "/v1/voices/add", async (req, res) => {
  const form = await readForm(req);
  const name = String(form.get("name") || "").trim();
  if (!name) throw httpError(422, "name is required");
  const files = [];
  for (const f of form.getAll("files")) if (typeof f !== "string") files.push({ buffer: Buffer.from(await f.arrayBuffer()), name: f.name, type: f.type });
  if (!files.length) throw httpError(422, "At least one audio sample is required");
  let labels;
  try { labels = form.get("labels") ? JSON.parse(form.get("labels")) : undefined; } catch { throw httpError(422, "labels must be JSON"); }
  const provider = String(form.get("provider") || (qwen.canClone() ? "qwen" : "elevenlabs"));
  if (provider === "elevenlabs") {
    const out = await el.addVoice(name, form.get("description"), files, labels);
    await remoteVoices({ fresh: true });
    return json(res, 200, out);
  }
  if (!qwen.canClone()) throw httpError(503, "Local cloning needs the Qwen3-TTS Base model and its Python environment. See README → Qwen3-TTS.");
  // Join the samples into one reference clip; the model works best with 5–20 s of clean speech.
  const clips = [];
  for (const f of files) clips.push((await decodeToMono(f.buffer, 24000)).samples);
  const ref = concat(clips).subarray(0, 24000 * MAX_CLONE_REF_SECONDS);
  if (ref.length < 24000 * 3) throw httpError(422, "Samples are too short. Provide at least 3 seconds of speech.");
  let ref_text = String(form.get("transcript") || "").trim();
  if (!ref_text) ref_text = (await local.transcribe(resample(ref, 24000, 16000))).text;
  const voice_id = db.addClonedVoice({ name, description: form.get("description"), labels, ref_audio: encodeWav(ref, 24000), ref_text });
  json(res, 200, { voice_id, requires_verification: false, transcript: ref_text });
});

// ---------- voice design (Qwen3-TTS 1.7B VoiceDesign) ----------
// A design is a short spoken preview in a voice generated from a description. Saving it
// stores that preview as the reference clip of a new voice, which the Base model then reuses.
const DESIGN_DIR = path.join(db.DATA_DIR, "designs");
fs.mkdirSync(DESIGN_DIR, { recursive: true });
const DESIGN_SAMPLE = "Hello there. This is what my voice sounds like when I read a few sentences out loud for you.";
route("POST", "/v1/text-to-voice/design", async (req, res, p, q) => {
  const body = await readJson(req);
  const description = String(body.voice_description || "").trim();
  if (description.length < 10) throw httpError(422, "Describe the voice in at least 10 characters (age, gender, tone, accent, pace…)");
  if (description.length > 1000) throw httpError(422, "voice_description must be 1000 characters or fewer");
  const text = String(body.text || "").trim() || DESIGN_SAMPLE;
  if (text.length > 500) throw httpError(422, "Preview text must be 500 characters or fewer");
  const fmt = parseOutputFormat(q.get("output_format") || "mp3_44100_128");
  const out = await qwen.design(text, { description, language: body.language });
  for (const f of fs.readdirSync(DESIGN_DIR)) {
    const p = path.join(DESIGN_DIR, f);
    if (Date.now() - fs.statSync(p).mtimeMs > 24 * 3600_000) fs.rmSync(p, { force: true });
  }
  const generated_voice_id = "design_" + db.newId();
  fs.writeFileSync(path.join(DESIGN_DIR, `${generated_voice_id}.wav`), encodeWav(resample(out.samples, out.rate, 24000), 24000));
  fs.writeFileSync(path.join(DESIGN_DIR, `${generated_voice_id}.json`), JSON.stringify({ text, description, language: body.language || "auto" }));
  const audio = encode(out.samples, out.rate, fmt);
  json(res, 200, {
    previews: [{ generated_voice_id, audio_base_64: audio.toString("base64"), media_type: fmt.contentType, duration_secs: out.samples.length / out.rate }],
    text,
  });
});
route("POST", "/v1/text-to-voice", async (req, res) => {
  const body = await readJson(req);
  const name = String(body.voice_name || "").trim();
  if (!name) throw httpError(422, "voice_name is required");
  const id = String(body.generated_voice_id || "");
  if (!/^design_[\w-]+$/.test(id) || !fs.existsSync(path.join(DESIGN_DIR, `${id}.wav`))) throw httpError(404, "That preview has expired. Generate it again.");
  const meta = JSON.parse(fs.readFileSync(path.join(DESIGN_DIR, `${id}.json`), "utf8"));
  const voice_id = db.addClonedVoice({
    name: name.slice(0, 100),
    description: String(body.voice_description || meta.description).slice(0, 500),
    labels: { designed: true },
    ref_audio: fs.readFileSync(path.join(DESIGN_DIR, `${id}.wav`)),
    ref_text: meta.text,
  });
  for (const ext of ["wav", "json"]) fs.rmSync(path.join(DESIGN_DIR, `${id}.${ext}`), { force: true });
  json(res, 200, publicVoice(await findVoice(voice_id)));
});
route("DELETE", "/v1/voices/:id", async (req, res, p) => {
  const v = await findVoice(p.id);
  if (v.qwen?.ref_audio && v.category !== "premade") {
    db.deleteClonedVoice(v.voice_id);
    fs.rmSync(path.join(PREVIEW_DIR, `${v.voice_id}.mp3`), { force: true });
    return json(res, 200, { status: "ok" });
  }
  if (v.provider !== "elevenlabs") throw httpError(400, "Built-in voices cannot be deleted. Remove it from My Voices instead.");
  await el.deleteVoice(p.id);
  await remoteVoices({ fresh: true });
  json(res, 200, { status: "ok" });
});

// ---------- models ----------
route("GET", "/v1/models", async (req, res) => {
  const models = Object.values(local.MODELS).map(({ repo, ...m }) => ({ ...m, provider: "local", source: repo }));
  if (qwen.available()) models.splice(1, 0, { ...qwen.model(), provider: "qwen" });
  if (qwen.canTranscribe()) models.splice(models.findIndex((m) => m.model_id === local.MODELS.stt.model_id) + 1, 0, TURBO);
  if (el.enabled()) {
    try { models.push(...(await el.listModels())); } catch (e) { console.warn("[elevenlabs] models:", e.message); }
  }
  json(res, 200, models);
});

// ---------- text to speech ----------
const isRemote = (voice, model_id) => voice.provider === "elevenlabs" || String(model_id || "").startsWith("eleven_");

async function tts(req, res, p, q, streaming) {
  const body = await readJson(req);
  const text = String(body.text || "").trim();
  if (!text) throw httpError(422, "text is required");
  if (text.length > MAX_TTS_CHARS) throw httpError(422, `text exceeds ${MAX_TTS_CHARS} characters`);
  const limit = db.getSetting("character_limit", null);
  if (limit && db.characterUsage(monthStart()) + text.length > limit) throw httpError(429, "Monthly character limit reached. Raise it in Settings → Usage.");
  const voice = await findVoice(p.voice_id);
  const fmt = parseOutputFormat(q.get("output_format") || "mp3_44100_128");
  const settings = { ...voice.settings, ...(body.voice_settings || {}) };
  checkSpeakable(text);
  // History keeps what was typed; the voice reads the dictionary's version, and tags aren't counted.
  const record = { source: "TTS", voice_id: voice.voice_id, voice_name: voice.name, voice_category: voice.category, text, settings, character_count: spokenLength(text) };

  if (isRemote(voice, body.model_id)) {
    if (voice.provider !== "elevenlabs") throw httpError(400, `ElevenLabs models need an ElevenLabs voice; '${voice.name}' is a local voice.`);
    const model_id = body.model_id?.startsWith("eleven_") ? body.model_id : "eleven_multilingual_v2";
    const out = await el.tts(voice.voice_id, { text: toElevenLabs(text, pronounce), model_id, voice_settings: body.voice_settings, language_code: body.language_code, seed: body.seed }, q.get("output_format") || "mp3_44100_128");
    const id = db.addHistory({ ...record, model_id, audio: out.buffer, ext: fmt.ext, content_type: out.contentType });
    return audio(res, out.buffer, out.contentType, { "history-item-id": id, "request-id": id });
  }

  const model_id = localEngine(voice).model_id;
  if (body.model_id && body.model_id !== model_id) throw httpError(400, `Model '${body.model_id}' can't be used with voice '${voice.name}' (use ${model_id})`);
  if (body.instructions) record.settings = { ...record.settings, instructions: String(body.instructions).slice(0, 500) };
  // When streaming, the first piece is kept short (about one sentence) so playback starts sooner.
  const listener = new AbortController();
  if (streaming) res.on("close", () => { if (!res.writableFinished) listener.abort(); });
  const speak = () => speakParts(voice, text, { speed: settings.speed, language: body.language_code, instructions: body.instructions, first: streaming ? STREAM_FIRST_CHARS : undefined, signal: listener.signal });
  if (!streaming) {
    const out = await synthesizeAll(speak());
    const buf = encode(out.samples, out.rate, fmt);
    const id = db.addHistory({ ...record, model_id, audio: buf, ext: fmt.ext, content_type: fmt.contentType, duration: out.samples.length / out.rate });
    return audio(res, buf, fmt.contentType, { "history-item-id": id, "request-id": id });
  }
  // Stream piece by piece. MP3 goes through one encoder for the whole request, so there are no
  // gaps where pieces meet; raw PCM concatenates as is. The history id is sent up front (the item
  // is saved once the audio is complete), and generation stops if the client disconnects.
  if (fmt.codec === "wav") throw httpError(400, "Streaming supports mp3_* and pcm_* formats");
  const id = db.newId();
  const mp3 = fmt.codec === "mp3" ? mp3Writer(fmt.rate, fmt.kbps) : null;
  const parts = [];
  let seconds = 0;
  let gone = false;
  res.on("close", () => { if (!res.writableFinished) gone = true; });
  res.writeHead(200, { "content-type": fmt.contentType, "cache-control": "no-store", "x-accel-buffering": "no", "history-item-id": id, "request-id": id });
  res.flushHeaders();
  const send = (buf) => { if (!buf.length) return; parts.push(buf); res.write(buf); };
  // A disconnect is only noticed when the event loop gets a turn, and a finished piece resolves
  // straight into the next step, so let it run once before each check.
  const stillThere = async () => { await new Promise(setImmediate); return !gone; };
  for await (const part of speak()) {
    if (!(await stillThere())) return;
    seconds += part.samples.length / part.rate;
    send(mp3 ? mp3.write(resample(part.samples, part.rate, fmt.rate)) : encode(part.samples, part.rate, fmt));
  }
  if (!(await stillThere())) return;
  if (mp3) send(mp3.end());
  res.end();
  db.addHistory({ ...record, id, model_id, audio: Buffer.concat(parts), ext: fmt.ext, content_type: fmt.contentType, duration: seconds });
}
route("POST", "/v1/text-to-speech/:voice_id", (req, res, p, q) => tts(req, res, p, q, false));
route("POST", "/v1/text-to-speech/:voice_id/stream", (req, res, p, q) => tts(req, res, p, q, true));

// ---------- dialogue ----------
// Several voices in one recording (podcasts, interviews, scenes). Same request shape as
// ElevenLabs' text-to-dialogue: { inputs: [{ text, voice_id }], settings? }.
const MAX_DIALOGUE_LINES = 300;
const DIALOGUE_RATE = 24000;
// Lines are spoken in script order. A script that mixes Qwen preset voices and cloned voices is
// spoken grouped by model instead (presets, then clones) and put back in order, because each
// switch between those two models reloads several GB.
const engineGroup = (v) => (v.provider === "qwen" ? (v.style_instructions ? "qwen-preset" : "qwen-ref") : v.provider);

async function prepareDialogue(req, q) {
  const body = await readJson(req);
  const inputs = Array.isArray(body.inputs) ? body.inputs : null;
  if (!inputs?.length) throw httpError(422, "inputs is required: a list of { text, voice_id }");
  if (inputs.length > MAX_DIALOGUE_LINES) throw httpError(422, `A dialogue can have at most ${MAX_DIALOGUE_LINES} lines`);
  const lines = inputs.map((x, i) => {
    const text = String(x?.text ?? "").trim();
    if (!text) throw httpError(422, `Line ${i + 1} has no text`);
    if (!x?.voice_id) throw httpError(422, `Line ${i + 1} has no voice_id`);
    try { checkSpeakable(text); } catch { throw httpError(422, `Line ${i + 1} only has tags`); }
    const speaker = String(x.speaker ?? "").trim().slice(0, 40) || undefined; // optional display name ("Host")
    return { text, voice_id: String(x.voice_id), speaker, instructions: x.instructions ? String(x.instructions).slice(0, 500) : undefined };
  });
  const chars = lines.reduce((n, l) => n + spokenLength(l.text), 0);
  if (chars > MAX_TTS_CHARS) throw httpError(422, `The script exceeds ${MAX_TTS_CHARS} characters`);
  const limit = db.getSetting("character_limit", null);
  if (limit && db.characterUsage(monthStart()) + chars > limit) throw httpError(429, "Monthly character limit reached. Raise it in Settings → Usage.");
  const fmt = parseOutputFormat(q.get("output_format") || "mp3_44100_128");
  const pause = Math.min(3, Math.max(0, Number(body.settings?.pause_seconds ?? 0.35) || 0));
  const voices = new Map();
  for (const l of lines) if (!voices.has(l.voice_id)) voices.set(l.voice_id, await findVoice(l.voice_id));
  for (const v of voices.values()) {
    if (v.provider === "elevenlabs" && !el.enabled()) throw httpError(400, `'${v.name}' is an ElevenLabs voice; add an ElevenLabs key in Settings.`);
  }
  return { body, lines, voices, fmt, pause, chars, models: new Set() };
}

// Yields { i, samples, last }: pieces of line i's audio at DIALOGUE_RATE, in the order they're
// made. `first` keeps each line's first piece short, for streaming.
async function* dialoguePieces(d, { first, signal } = {}) {
  const { lines, voices, body, models } = d;
  const groups = new Set(lines.map((l) => engineGroup(voices.get(l.voice_id))));
  const order = lines.map((l, i) => i);
  if (groups.has("qwen-preset") && groups.has("qwen-ref")) order.sort((a, b) => engineGroup(voices.get(lines[a].voice_id)).localeCompare(engineGroup(voices.get(lines[b].voice_id))) || a - b);
  for (const i of order) {
    const l = lines[i];
    const voice = voices.get(l.voice_id);
    if (voice.provider === "elevenlabs") {
      const out = await el.tts(voice.voice_id, { text: toElevenLabs(l.text, pronounce), model_id: "eleven_multilingual_v2", language_code: body.language_code }, "pcm_24000");
      models.add("eleven_multilingual_v2");
      yield { i, samples: pcm16ToFloat(out.buffer), last: true };
      continue;
    }
    models.add(localEngine(voice).model_id);
    let prev = null;
    if (signal?.aborted) return;
    for await (const part of speakParts(voice, l.text, { language: body.language_code, instructions: l.instructions, first, signal })) {
      if (prev) yield { i, samples: prev, last: false };
      prev = resample(part.samples, part.rate, DIALOGUE_RATE);
    }
    yield { i, samples: prev || new Float32Array(0), last: true };
  }
}

function saveDialogue(d, { id, audio, duration }) {
  const { lines, voices, pause, chars, fmt, models } = d;
  const names = [...new Set(lines.map((l) => voices.get(l.voice_id).name))];
  const first = voices.get(lines[0].voice_id);
  return db.addHistory({
    id, source: "DIALOGUE", voice_id: first.voice_id, voice_name: names.join(", "), voice_category: first.category,
    model_id: [...models].join("+"), text: lines.map((l) => `${l.speaker || voices.get(l.voice_id).name}: ${l.text}`).join("\n"),
    settings: { pause_seconds: pause, inputs: lines.map(({ text, voice_id, speaker, instructions }) => ({ text, voice_id, ...(speaker ? { speaker } : {}), ...(instructions ? { instructions } : {}) })) },
    character_count: chars, audio, ext: fmt.ext, content_type: fmt.contentType, duration,
  });
}

route("POST", "/v1/text-to-dialogue", async (req, res, p, q) => {
  const d = await prepareDialogue(req, q);
  const audioOf = d.lines.map(() => []);
  for await (const piece of dialoguePieces(d)) audioOf[piece.i].push(piece.samples);
  const gap = silence(d.pause, DIALOGUE_RATE);
  const samples = concat(audioOf.flatMap((a, i) => (i ? [gap, ...a] : a)));
  const buf = encode(samples, DIALOGUE_RATE, d.fmt);
  const id = saveDialogue(d, { audio: buf, duration: samples.length / DIALOGUE_RATE });
  audio(res, buf, d.fmt.contentType, { "history-item-id": id, "request-id": id });
});

// The same, sent while it's made (MP3 or PCM), like /v1/text-to-speech/:id/stream. Lines go out in
// script order, each as soon as every line before it is done.
route("POST", "/v1/text-to-dialogue/stream", async (req, res, p, q) => {
  const d = await prepareDialogue(req, q);
  if (d.fmt.codec === "wav") throw httpError(400, "Streaming supports mp3_* and pcm_* formats");
  const id = db.newId();
  const mp3 = d.fmt.codec === "mp3" ? mp3Writer(d.fmt.rate, d.fmt.kbps) : null;
  const parts = [];
  let seconds = 0, gone = false;
  const listener = new AbortController();
  res.on("close", () => { if (!res.writableFinished) { gone = true; listener.abort(); } });
  res.writeHead(200, { "content-type": d.fmt.contentType, "cache-control": "no-store", "x-accel-buffering": "no", "history-item-id": id, "request-id": id });
  res.flushHeaders();
  const stillThere = async () => { await new Promise(setImmediate); return !gone; };
  const write = (buf) => { if (buf.length) { parts.push(buf); res.write(buf); } };
  const send = (samples) => {
    if (!samples.length) return;
    seconds += samples.length / DIALOGUE_RATE;
    write(mp3 ? mp3.write(resample(samples, DIALOGUE_RATE, d.fmt.rate)) : encode(samples, DIALOGUE_RATE, d.fmt));
  };
  const gap = silence(d.pause, DIALOGUE_RATE);
  const ready = d.lines.map(() => ({ pieces: [], done: false, started: false }));
  let next = 0;
  for await (const piece of dialoguePieces(d, { first: STREAM_FIRST_CHARS, signal: listener.signal })) {
    if (!(await stillThere())) return;
    ready[piece.i].pieces.push(piece.samples);
    if (piece.last) ready[piece.i].done = true;
    // Send whatever is ready, in script order.
    while (next < ready.length && ready[next].pieces.length) {
      const cur = ready[next];
      if (!cur.started) { if (next) send(gap); cur.started = true; }
      for (const x of cur.pieces.splice(0)) send(x);
      if (!cur.done) break;
      next++;
    }
  }
  if (!(await stillThere())) return;
  if (mp3) write(mp3.end());
  res.end();
  saveDialogue(d, { id, audio: Buffer.concat(parts), duration: seconds });
});

// ---------- speech to text ----------
// Whisper large-v3-turbo runs in the Python worker (faster-whisper); Whisper Base runs in Node.
const TURBO = {
  model_id: "whisper_large_v3_turbo", name: "Whisper Large v3 Turbo", provider: "local", source: "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
  description: "Most accurate local transcription: punctuation, 99 languages, detected language, optional speaker labels.", can_do_speech_to_text: true,
};
// Words in ElevenLabs Scribe's shape: a "spacing" entry between words, every entry with a speaker_id.
function scribeWords(words, speakers) {
  const out = [];
  words.forEach((w, i) => {
    const speaker_id = speakers?.[i] || "speaker_0";
    if (out.length) { const prev = out.at(-1); out.push({ text: " ", start: prev.end, end: Math.max(prev.end, w.start), type: "spacing", speaker_id: prev.speaker_id, logprob: 0 }); }
    out.push({ text: w.text, start: w.start, end: w.end, type: "word", speaker_id, logprob: w.logprob ?? 0 });
  });
  return out;
}
const truthy = (v) => ["true", "1", "on", "yes"].includes(String(v ?? "").toLowerCase());

route("POST", "/v1/speech-to-text", async (req, res) => {
  const form = await readForm(req);
  const file = await formFile(form, "file");
  const model_id = String(form.get("model_id") || local.MODELS.stt.model_id);
  const language_code = form.get("language_code") || null;
  const diarize = truthy(form.get("diarize"));
  const num_speakers = form.get("num_speakers") ? Number(form.get("num_speakers")) : null;
  if (num_speakers !== null && !(Number.isInteger(num_speakers) && num_speakers >= 1 && num_speakers <= 32)) throw httpError(422, "num_speakers must be a whole number from 1 to 32");
  let result;
  if (model_id.startsWith("scribe")) {
    result = await el.stt(file.buffer, file.name, { model_id, language_code, diarize: form.get("diarize"), num_speakers: num_speakers ?? undefined, tag_audio_events: form.get("tag_audio_events") });
  } else if (model_id === TURBO.model_id) {
    const decoded = await decodeToMono(file.buffer, 16000);
    const out = await qwen.transcribe(decoded.samples, { language: language_code, diarize, num_speakers });
    result = { language_code: out.language, language_probability: out.language_probability, text: out.text, words: scribeWords(out.words, out.speakers), duration: decoded.duration };
  } else if (model_id === local.MODELS.stt.model_id) {
    const decoded = await decodeToMono(file.buffer, 16000);
    const out = await local.transcribe(decoded.samples, { language_code });
    let words = out.words;
    if (diarize) {
      const ws = words.filter((w) => w.type === "word");
      const { speakers } = await qwen.diarize(decoded.samples, ws, { num_speakers });
      words = scribeWords(ws, speakers);
    }
    result = { language_code: out.language_code, language_probability: out.language_code ? 1 : null, text: out.text, words, duration: decoded.duration };
  } else throw httpError(400, `Unknown model_id '${model_id}'`);
  const transcription_id = db.addTranscript({ file_name: file.name, language_code: result.language_code, text: result.text, words: result.words || [], duration: result.duration, model_id });
  json(res, 200, { ...result, transcription_id });
});
route("GET", "/api/transcripts", async (req, res) => json(res, 200, { transcripts: db.listTranscripts() }));
route("GET", "/v1/speech-to-text/transcripts/:id", async (req, res, p) => {
  const t = db.getTranscript(p.id);
  if (!t) throw httpError(404, "Transcript not found");
  json(res, 200, t);
});
route("DELETE", "/v1/speech-to-text/transcripts/:id", async (req, res, p) => {
  if (!db.deleteTranscript(p.id)) throw httpError(404, "Transcript not found");
  json(res, 200, { status: "ok" });
});

// ---------- sound effects ----------
route("POST", "/v1/sound-generation", async (req, res, p, q) => {
  const body = await readJson(req);
  const text = String(body.text || "").trim();
  if (!text) throw httpError(422, "text is required");
  if (body.duration_seconds != null && (body.duration_seconds < 0.5 || body.duration_seconds > 30)) throw httpError(422, "duration_seconds must be between 0.5 and 30");
  const fmt = parseOutputFormat(q.get("output_format") || "mp3_44100_128");
  const model_id = body.model_id || local.MODELS.sfx.model_id;
  const record = { source: "SFX", text, model_id, settings: { duration_seconds: body.duration_seconds ?? null, prompt_influence: body.prompt_influence ?? 0.3, loop: Boolean(body.loop) }, character_count: 0 };
  if (model_id.startsWith("eleven_")) {
    const out = await el.sfx({ text, duration_seconds: body.duration_seconds, prompt_influence: body.prompt_influence, loop: body.loop, model_id }, q.get("output_format"));
    const id = db.addHistory({ ...record, audio: out.buffer, ext: fmt.ext, content_type: out.contentType });
    return audio(res, out.buffer, out.contentType, { "history-item-id": id });
  }
  if (model_id !== local.MODELS.sfx.model_id) throw httpError(400, `Unknown model_id '${model_id}'`);
  const out = await local.generateSound(text, body);
  const buf = encode(out.samples, out.rate, fmt);
  const id = db.addHistory({ ...record, audio: buf, ext: fmt.ext, content_type: fmt.contentType, duration: out.samples.length / out.rate });
  audio(res, buf, fmt.contentType, { "history-item-id": id });
});

// ---------- voice changer ----------
const MAX_CONVERT_SECONDS = 10 * 60;
// A clip of the target voice for the converter. Clones, designs and library voices have one; for
// Kokoro and Qwen preset voices it's spoken once and cached next to the previews.
const REF_TEXT = "Hello, and thanks for listening. I'll read a few sentences so you can hear my voice clearly. The morning was calm, the coffee was strong, and the city slowly woke up around me while I walked to work.";
async function voiceReference(v) {
  if (v.qwen?.ref_audio) return fs.readFileSync(v.qwen.ref_audio);
  const file = path.join(PREVIEW_DIR, `${v.voice_id}.ref.wav`);
  if (!fs.existsSync(file)) {
    const out = await synthesizeAll(localEngine(v).parts(REF_TEXT));
    fs.writeFileSync(file, encodeWav(out.samples, out.rate));
  }
  return fs.readFileSync(file);
}
route("POST", "/v1/speech-to-speech/:voice_id", async (req, res, p, q) => {
  const form = await readForm(req);
  const file = await formFile(form, "audio");
  const voice = await findVoice(p.voice_id);
  const fmt = parseOutputFormat(q.get("output_format") || "mp3_44100_128");
  const settings = form.get("voice_settings") ? JSON.parse(form.get("voice_settings")) : {};
  const record = { source: "STS", voice_id: voice.voice_id, voice_name: voice.name, voice_category: voice.category, settings };
  if (voice.provider === "elevenlabs") {
    const model_id = String(form.get("model_id") || "eleven_multilingual_sts_v2");
    const out = await el.sts(voice.voice_id, file.buffer, file.name, { model_id, voice_settings: settings, remove_background_noise: form.get("remove_background_noise") }, q.get("output_format"));
    const id = db.addHistory({ ...record, model_id, text: null, audio: out.buffer, ext: fmt.ext, content_type: out.contentType });
    return audio(res, out.buffer, out.contentType, { "history-item-id": id });
  }
  // Local, mode "convert" (default when OpenVoice is installed): true speech-to-speech. The input's
  // words, timing and emotion are kept and only the voice changes.
  const mode = String(form.get("mode") || (qwen.canConvert() ? "convert" : "revoice"));
  if (mode === "convert") {
    if (!qwen.canConvert()) throw httpError(503, "The local voice changer needs OpenVoice. See README → Voice changer, or use mode=revoice.");
    const decoded = await decodeToMono(file.buffer, 22050);
    if (decoded.duration > MAX_CONVERT_SECONDS) throw httpError(422, `Audio is ${Math.round(decoded.duration / 60)} minutes long; the limit is ${MAX_CONVERT_SECONDS / 60} minutes.`);
    let src = decoded.samples;
    const denoise = truthy(form.get("remove_background_noise")) && qwen.canIsolate();
    if (denoise) { const iso = await qwen.isolate(resample(src, 22050, 44100), 44100); src = resample(iso.samples, iso.rate, 22050); }
    const out = await qwen.convert(src, 22050, await voiceReference(voice));
    const buf = encode(out.samples, out.rate, fmt);
    const id = db.addHistory({ ...record, settings: { ...settings, mode, remove_background_noise: denoise }, model_id: "openvoice_v2", text: file.name, audio: buf, ext: fmt.ext, content_type: fmt.contentType, duration: out.samples.length / out.rate });
    return audio(res, buf, fmt.contentType, { "history-item-id": id });
  }
  if (mode !== "revoice") throw httpError(422, "mode must be convert or revoice");
  // Local, mode "revoice": transcribe the performance, then speak it again. Wording is kept; prosody is not.
  const decoded = await decodeToMono(file.buffer, 16000);
  const heard = await local.transcribe(decoded.samples);
  if (!heard.text) throw httpError(422, "No speech detected in the uploaded audio");
  const out = await synthesizeAll(localEngine(voice, { speed: settings.speed }).parts(heard.text));
  const buf = encode(out.samples, out.rate, fmt);
  const id = db.addHistory({ ...record, model_id: "local_revoice", text: heard.text, audio: buf, ext: fmt.ext, content_type: fmt.contentType, character_count: heard.text.length, duration: out.samples.length / out.rate });
  audio(res, buf, fmt.contentType, { "history-item-id": id, "x-transcript": encodeURIComponent(heard.text) });
});

// ---------- voice isolator (Demucs locally, or ElevenLabs) ----------
const MAX_ISOLATE_SECONDS = 15 * 60;
route("POST", "/v1/audio-isolation", async (req, res) => {
  const form = await readForm(req);
  const file = await formFile(form, "audio");
  const provider = String(form.get("provider") || (qwen.canIsolate() ? "local" : "elevenlabs"));
  if (provider === "local") {
    if (!qwen.canIsolate()) throw httpError(503, "Local voice isolation needs Demucs. See README → Voice isolation, or connect ElevenLabs.");
    const decoded = await decodeToMono(file.buffer, 44100);
    if (decoded.duration > MAX_ISOLATE_SECONDS) throw httpError(422, `Audio is ${Math.round(decoded.duration / 60)} minutes long; the limit is ${MAX_ISOLATE_SECONDS / 60} minutes.`);
    const out = await qwen.isolate(decoded.samples, 44100);
    const buf = encodeMp3(resample(out.samples, out.rate, 44100), 44100, 128);
    const id = db.addHistory({ source: "VOICE_ISOLATOR", text: file.name, model_id: "demucs_htdemucs", audio: buf, ext: "mp3", content_type: "audio/mpeg", duration: out.samples.length / out.rate });
    return audio(res, buf, "audio/mpeg", { "history-item-id": id });
  }
  const out = await el.isolate(file.buffer, file.name);
  const id = db.addHistory({ source: "VOICE_ISOLATOR", text: file.name, model_id: "eleven_audio_isolation", audio: out.buffer, ext: "mp3", content_type: out.contentType });
  audio(res, out.buffer, out.contentType, { "history-item-id": id });
});

// ---------- history ----------
route("GET", "/v1/history", async (req, res, p, q) => json(res, 200, db.listHistory(Object.fromEntries(q))));
route("GET", "/v1/history/:id", async (req, res, p) => {
  const h = db.getHistory(p.id);
  if (!h) throw httpError(404, "History item not found");
  const { audio_file, ...rest } = h;
  json(res, 200, rest);
});
route("GET", "/v1/history/:id/audio", async (req, res, p, q) => {
  const h = db.getHistory(p.id);
  if (!h) throw httpError(404, "History item not found");
  const file = path.join(db.AUDIO_DIR, h.audio_file);
  const name = `${(h.voice_name || h.source).replace(/[^\w-]+/g, "_")}_${h.history_item_id}${path.extname(h.audio_file)}`;
  audio(res, fs.readFileSync(file), h.content_type, q.get("download") ? { "content-disposition": `attachment; filename="${name}"` } : { "cache-control": "private, max-age=3600" });
});
route("DELETE", "/v1/history/:id", async (req, res, p) => {
  if (!db.deleteHistory(p.id)) throw httpError(404, "History item not found");
  json(res, 200, { status: "ok" });
});
route("POST", "/v1/history/download", async (req, res) => {
  const { history_item_ids = [] } = await readJson(req);
  const items = history_item_ids.map((id) => db.getHistory(id)).filter(Boolean);
  if (!items.length) throw httpError(404, "No matching history items");
  if (items.length === 1) {
    const h = items[0];
    return audio(res, fs.readFileSync(path.join(db.AUDIO_DIR, h.audio_file)), h.content_type, { "content-disposition": `attachment; filename="${h.audio_file}"` });
  }
  const zip = makeZip(items.map((h) => ({ name: h.audio_file, data: fs.readFileSync(path.join(db.AUDIO_DIR, h.audio_file)) })));
  audio(res, zip, "application/zip", { "content-disposition": 'attachment; filename="history.zip"' });
});
route("POST", "/api/history/:id/feedback", async (req, res, p) => {
  const body = await readJson(req);
  if (!db.setHistoryFeedback(p.id, { thumbs_up: Boolean(body.thumbs_up), feedback: String(body.feedback || "").slice(0, 2000) })) throw httpError(404, "History item not found");
  json(res, 200, { status: "ok" });
});

// The Resonant Reader browser extension (extension/), zipped for "Load unpacked" in Chrome or Edge.
const EXTENSION_DIR = path.join(PUBLIC_DIR, "..", "extension");
route("GET", "/api/extension.zip", async (req, res) => {
  const files = [];
  const walk = (dir, rel = "") => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${rel}${e.name}/`);
      else files.push({ name: `resonant-reader/${rel}${e.name}`, data: fs.readFileSync(path.join(dir, e.name)) });
    }
  };
  walk(EXTENSION_DIR);
  audio(res, makeZip(files), "application/zip", { "content-disposition": 'attachment; filename="resonant-reader.zip"', "cache-control": "no-store" });
});

// Minimal stored (uncompressed) ZIP writer; audio is already compressed.
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const crc = zlib.crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(f.data.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(f.data.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, f.data);
    centrals.push(ch, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---------- user, usage, settings ----------
function monthStart() { const d = new Date(); return Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000); }
function subscription() {
  const d = new Date();
  return {
    tier: "self-hosted",
    character_count: db.characterUsage(monthStart()),
    character_limit: db.getSetting("character_limit", null),
    next_character_count_reset_unix: Math.floor(new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() / 1000),
    status: "active",
  };
}
route("GET", "/v1/user/subscription", async (req, res) => json(res, 200, subscription()));
route("GET", "/v1/user", async (req, res) => json(res, 200, {
  user_id: "local",
  first_name: db.getSetting("display_name", "") || null,
  subscription: subscription(),
  is_new_user: db.listHistory({ page_size: 1 }).history.length === 0,
}));

function publicSettings() {
  const key = el.apiKey();
  return {
    display_name: db.getSetting("display_name", ""),
    default_voice_id: db.getSetting("default_voice_id", "af_heart"),
    default_output_format: db.getSetting("default_output_format", "mp3_44100_128"),
    character_limit: db.getSetting("character_limit", null),
    system_check_seen: Boolean(db.getSetting("system_check_seen", false)),
    local_cloning: qwen.canClone(),
    qwen: { available: qwen.available(), can_clone: qwen.canClone(), can_design: qwen.canDesign(), can_isolate: qwen.canIsolate(), can_transcribe: qwen.canTranscribe(), can_diarize: qwen.canDiarize(), can_convert: qwen.canConvert(), model: qwen.model().name, size: qwen.size(), sizes: qwen.sizeOptions(), remote: qwen.remoteInfo() },
    elevenlabs: { connected: Boolean(key), key_hint: key ? `…${key.slice(-4)}` : null, from_env: !db.getSetting("elevenlabs_api_key") && Boolean(key) },
  };
}
route("GET", "/api/settings", async (req, res) => json(res, 200, publicSettings()));
route("PATCH", "/api/settings", async (req, res) => {
  const body = await readJson(req);
  if ("display_name" in body) db.setSetting("display_name", String(body.display_name || "").slice(0, 80));
  if ("system_check_seen" in body) db.setSetting("system_check_seen", Boolean(body.system_check_seen));
  if ("qwen_remote_url" in body) await qwen.setRemote(body.qwen_remote_url, body.qwen_remote_token);
  if ("qwen_size" in body) qwen.setSize(String(body.qwen_size));
  if ("default_voice_id" in body) { await findVoice(body.default_voice_id); db.setSetting("default_voice_id", body.default_voice_id); }
  if ("default_output_format" in body) { parseOutputFormat(body.default_output_format); db.setSetting("default_output_format", body.default_output_format); }
  if ("character_limit" in body) {
    const n = body.character_limit === null || body.character_limit === "" ? null : Number(body.character_limit);
    if (n !== null && !(n > 0)) throw httpError(422, "character_limit must be a positive number or empty");
    db.setSetting("character_limit", n);
  }
  if ("elevenlabs_api_key" in body) {
    const key = String(body.elevenlabs_api_key || "").trim();
    if (key) await el.verifyKey(key);
    db.setSetting("elevenlabs_api_key", key || null);
    elVoiceCache = { at: 0, voices: [] };
  }
  json(res, 200, publicSettings());
});
route("POST", "/api/data/clear-history", async (req, res) => {
  let n = 0;
  for (;;) {
    const page = db.listHistory({ page_size: 500 });
    for (const h of page.history) { db.deleteHistory(h.history_item_id); n++; }
    if (!page.has_more) break;
  }
  json(res, 200, { deleted: n });
});

route("GET", "/api/health", async (req, res) => json(res, 200, {
  status: "ok",
  version: VERSION,
  models: { ...local.modelState(), qwen: qwen.state() },
  elevenlabs: el.enabled(),
  stats: db.historyStats(),
}));

// How to connect AI apps (Claude Desktop, Claude Code, Cursor) to Resonant's MCP server on this
// install. Inside the desktop app there's no separate Node.js, so the app's own executable runs
// the MCP server (ELECTRON_RUN_AS_NODE).
route("GET", "/api/mcp-config", async (req, res) => {
  const script = path.join(PUBLIC_DIR, "..", "mcp", "server.mjs");
  const env = {};
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
  const port = server.address()?.port;
  if (HOST !== "127.0.0.1" || !(port >= 3000 && port <= 3005)) env.RESONANT_URL = `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${port}`;
  if (REQUIRED_KEY) env.RESONANT_API_KEY = "<your access key>";
  json(res, 200, { command: process.execPath, args: [script], env, desktop: Boolean(process.versions.electron), platform: process.platform, output_dir: path.join(os.homedir(), "Documents", "Resonant") });
});

// What this computer can run (first-run check and Settings → This computer).
const qwenFacts = () => ({ available: qwen.available(), canDesign: qwen.canDesign(), size: qwen.size(), remote: qwen.remoteInfo() });
route("GET", "/api/system", async (req, res) => {
  const hw = await system.hardware({ python: qwen.pythonPath(), dataDir: db.DATA_DIR });
  const speed = db.getSetting("speed_test", null);
  json(res, 200, { ...hw, speed, features: system.verdicts(hw, qwenFacts(), speed) });
});
// Times the built-in voices on a short paragraph. The model is loaded first, untimed, so the
// result is the speed people get once Resonant is running.
const SPEED_TEXT = "This is a short speed test. Resonant reads it aloud with a built-in voice and times how long that takes on this computer.";
route("POST", "/api/system/speed", async (req, res) => {
  await local.synthesizeAll("Warming up.", { voice_id: "af_heart" });
  const t0 = performance.now();
  const out = await local.synthesizeAll(SPEED_TEXT, { voice_id: "af_heart" });
  const seconds = (performance.now() - t0) / 1000;
  const audio_seconds = out.samples.length / out.rate;
  const speed = { rtf: Math.round((audio_seconds / seconds) * 100) / 100, audio_seconds: Math.round(audio_seconds * 10) / 10, seconds: Math.round(seconds * 10) / 10, at: Date.now() };
  db.setSetting("speed_test", speed);
  json(res, 200, speed);
});

// Re-checks the GPU worker now (Settings → Providers → Check connection).
route("POST", "/api/worker/check", async (req, res) => {
  await qwen.refreshRemote();
  json(res, 200, publicSettings());
});

// ---------- studio (long-form narration) ----------
registerStudio({ route, readJson, readForm, formFile, json, findVoice, localEngine, speakParts, makeZip });
registerPronunciation({ route, readJson, json });
registerDubbing({ route, readJson, readForm, formFile, json, findVoice, speakParts });

// ---------- auth, static, dispatch ----------
const SESSION_COOKIE = "resonant_session";
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const sessionToken = REQUIRED_KEY ? sha("session:" + REQUIRED_KEY).toString("hex") : "";
function authorized(req) {
  if (!REQUIRED_KEY) return true;
  const header = req.headers["xi-api-key"];
  if (header && crypto.timingSafeEqual(sha(header), sha(REQUIRED_KEY))) return true;
  const cookie = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(SESSION_COOKIE + "="));
  return Boolean(cookie) && crypto.timingSafeEqual(sha(cookie.slice(SESSION_COOKIE.length + 1)), sha(sessionToken));
}
route("POST", "/api/session", async (req, res) => {
  const { key } = await readJson(req);
  if (REQUIRED_KEY && !(key && crypto.timingSafeEqual(sha(key), sha(REQUIRED_KEY)))) throw httpError(401, "Invalid access key");
  res.writeHead(200, { "content-type": "application/json", "set-cookie": `${SESSION_COOKIE}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
  res.end(JSON.stringify({ status: "ok" }));
});
route("GET", "/api/session", async (req, res) => json(res, 200, { auth_required: Boolean(REQUIRED_KEY), authorized: authorized(req) }));

// Browser libraries served straight from node_modules (no build step).
const VENDOR = { "/vendor/mediabunny.mjs": path.join(PUBLIC_DIR, "..", "node_modules", "mediabunny", "dist", "bundles", "mediabunny.min.mjs") };
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
function serveStatic(req, res, pathname) {
  if (VENDOR[pathname]) {
    res.writeHead(200, { "content-type": MIME[".mjs"], "cache-control": "public, max-age=86400" });
    return fs.createReadStream(VENDOR[pathname]).pipe(res);
  }
  let file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 403, { detail: "Forbidden" });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, "index.html");
  const ext = path.extname(file);
  res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}

// ---------- request guard ----------
// Browsers let any web page send requests to a server on this computer. Two checks keep the
// sites you visit from using Resonant behind your back:
// - the Host header must name this server, which stops DNS rebinding (a site pointing its own
//   domain at 127.0.0.1 to read the API as if it were same-origin);
// - API calls that change something must come from Resonant's own pages, a browser extension,
//   or a program that isn't a web page (curl, scripts and SDKs send no Origin header).
const NETWORK_MODE = !["127.0.0.1", "localhost", "::1"].includes(HOST);
const EXTRA_HOSTS = new Set((process.env.RESONANT_ALLOWED_HOSTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
function hostAllowed(host) {
  if (!host) return true; // HTTP/1.0 clients send none
  const name = host.toLowerCase().replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (["localhost", "127.0.0.1", "::1"].includes(name) || name.endsWith(".localhost") || EXTRA_HOSTS.has(name)) return true;
  // Listening on the network (HOST=0.0.0.0), the server is reached by its IP address or name;
  // the access key protects it there (a warning is printed at startup when there isn't one).
  return NETWORK_MODE;
}
const EXTENSION_ORIGIN = /^(chrome|moz|safari-web)-extension:\/\/[^/]+$/;
function originAllowed(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (EXTENSION_ORIGIN.test(origin)) return true;
  try {
    const o = new URL(origin);
    return o.host.toLowerCase() === String(req.headers.host || "").toLowerCase() || EXTRA_HOSTS.has(o.hostname.toLowerCase());
  } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const isApi = /^\/(v1|v2|api)\//.test(url.pathname);
  try {
    if (!hostAllowed(req.headers.host)) throw httpError(403, "This server doesn't answer to that host name. To reach it under another name, add the name to RESONANT_ALLOWED_HOSTS.");
    if (isApi && !["GET", "HEAD", "OPTIONS"].includes(req.method) && !originAllowed(req)) throw httpError(403, "Cross-site request blocked: Resonant only accepts changes from its own pages, a browser extension, or programs that aren't web pages.");
    if (!isApi) return serveStatic(req, res, url.pathname);
    const publicPaths = ["/api/session", "/api/health"];
    if (!publicPaths.includes(url.pathname) && !authorized(req)) throw httpError(401, "Missing or invalid xi-api-key");
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      return await r.handler(req, res, params, url.searchParams);
    }
    throw httpError(404, `No route for ${req.method} ${url.pathname}`);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(`[${req.method} ${url.pathname}]`, e);
    if (res.headersSent) return res.destroy(e);
    json(res, status, { detail: { status: status >= 500 ? "internal_error" : "invalid_request", message: e.message } });
  }
});

server.requestTimeout = 0; // long local generations
// Local synthesis can keep the event loop busy for seconds. With Node's 5 s default, an idle
// keep-alive socket can be closed just as a client reuses it, failing that request with
// ECONNRESET. Keep idle sockets well past any client's reuse window.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
// Started by the desktop app (with an IPC channel): when the app goes away, even if it crashes,
// the channel closes; stop the Python worker and exit instead of running on unseen.
if (process.send) {
  process.on("disconnect", () => { try { qwen.stop(); } finally { process.exit(0); } });
  server.on("error", (e) => { process.send?.({ type: "error", code: e.code, message: e.message }); process.exit(1); });
}
server.listen(PORT, HOST, () => {
  console.log(`Resonant running at http://${HOST}:${PORT}`);
  process.send?.({ type: "ready", port: server.address().port });
  if (NETWORK_MODE && !REQUIRED_KEY) console.warn("[security] Listening on the network without an access key: anyone who can reach this port can use Resonant, read your history and change your settings. Set RESONANT_API_KEY.");
  local.warmup();
});
