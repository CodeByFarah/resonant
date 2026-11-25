// Qwen3-TTS (and Demucs voice isolation) via the Python worker (worker/qwen_worker.py).
// Local mode: started on first use on this computer and stopped when idle.
// Remote mode: a worker started on a GPU machine, reached over HTTP(S) with a token
// (Settings → Providers → GPU worker, or RESONANT_WORKER_URL / RESONANT_WORKER_TOKEN).
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { httpError } from "../audio.mjs";
import { getSetting, setSetting } from "../db.mjs";
import { chunkText } from "./local.mjs";
import { PYTHON, HF_HOME, HF_HUB, MODELS_DIR } from "../paths.mjs";

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "worker", "qwen_worker.py");
const IDLE_MS = Number(process.env.RESONANT_QWEN_IDLE_MINUTES ?? 10) * 60_000;

export const SIZES = ["0.6B", "1.7B"];
// Voice Design is only published at 1.7B.
const DESIGN_REPO = "Qwen3-TTS-12Hz-1.7B-VoiceDesign";
const LANGUAGES = ["auto", "english", "chinese", "japanese", "korean", "german", "french", "russian", "portuguese", "spanish", "italian"].map((l) => ({ language_id: l, name: l[0].toUpperCase() + l.slice(1) }));

// ---------- remote worker ----------
// The setting wins over the env vars so a choice made in Settings sticks.
export function remote() {
  const url = getSetting("qwen_remote_url", null) ?? process.env.RESONANT_WORKER_URL ?? null;
  if (!url) return null;
  return { url: url.replace(/\/+$/, ""), token: getSetting("qwen_remote_token", null) ?? process.env.RESONANT_WORKER_TOKEN ?? "" };
}
// Last /health answer from the remote worker. Capabilities are kept from the last good answer,
// so a brief network blip doesn't make voices disappear; `error` says what went wrong.
let remoteHealth = { at: 0, ok: false, data: null, error: null, url: null };
export async function refreshRemote() {
  const r = remote();
  if (!r) { remoteHealth = { at: 0, ok: false, data: null, error: null, url: null }; return remoteHealth; }
  try {
    const res = await request(r.url + "/health", { method: "GET", token: r.token, timeoutMs: 8000 });
    if (res.status === 401) throw new Error("The worker rejected the token.");
    if (res.status !== 200) throw new Error(`The worker answered ${res.status}.`);
    const data = JSON.parse(res.body.toString("utf8"));
    remoteHealth = { at: Date.now(), ok: true, data, error: null, url: r.url };
  } catch (e) {
    remoteHealth = { ...remoteHealth, at: Date.now(), ok: false, error: e.message, url: r.url, data: remoteHealth.url === r.url ? remoteHealth.data : null };
  }
  return remoteHealth;
}
// Re-checks in the background at most every 30 s whenever someone asks what's available.
function remoteCaps() {
  if (Date.now() - remoteHealth.at > 30_000) { remoteHealth.at = Date.now(); refreshRemote(); }
  return remoteHealth.data?.available || {};
}
export function remoteInfo() {
  const r = remote();
  if (!r) return null;
  const d = remoteHealth.data;
  return { url: r.url, has_token: Boolean(r.token), connected: remoteHealth.ok, error: remoteHealth.error, device: d?.device || null, gpu: d?.gpu || null, size: d?.size || null };
}
export async function setRemote(url, token) {
  url = String(url || "").trim().replace(/\/+$/, "");
  if (!url) {
    setSetting("qwen_remote_url", null); setSetting("qwen_remote_token", null);
    await refreshRemote();
    return;
  }
  if (!/^https?:\/\/[^\s/]+/.test(url)) throw httpError(422, "Enter the worker's address, for example http://192.168.1.20:8765");
  const prev = { url: getSetting("qwen_remote_url", null), token: getSetting("qwen_remote_token", null) };
  setSetting("qwen_remote_url", url);
  if (token !== undefined) setSetting("qwen_remote_token", String(token || "") || null);
  const h = await refreshRemote();
  if (!h.ok) {
    setSetting("qwen_remote_url", prev.url); setSetting("qwen_remote_token", prev.token);
    await refreshRemote();
    throw httpError(422, `Couldn't reach the worker at ${url}: ${h.error}`);
  }
  stop(); // the local worker isn't needed any more
}
if (remote()) refreshRemote();

// ---------- what's installed ----------
// A model counts as installed only once a snapshot has its config and weights and no download is in flight.
// (On Windows without symlink rights, a download can die after the weights but before config.json.)
export const repoInstalled = (repo) => installed(repo);
function installed(repo) {
  const dir = path.join(HF_HUB, `models--Qwen--${repo}`);
  try {
    if (fs.readdirSync(path.join(dir, "blobs")).some((f) => f.endsWith(".incomplete"))) return false;
    return fs.readdirSync(path.join(dir, "snapshots")).some((rev) =>
      ["config.json", "model.safetensors"].every((f) => fs.existsSync(path.join(dir, "snapshots", rev, f))));
  } catch { return false; }
}
const hasModel = (kind, s = size()) => installed(`Qwen3-TTS-12Hz-${s}-${kind}`);
function demucsInstalled() {
  const venv = path.dirname(path.dirname(PYTHON));
  if (fs.existsSync(path.join(venv, "Lib", "site-packages", "demucs"))) return true;
  try {
    return fs.readdirSync(path.join(venv, "lib")).some((d) => fs.existsSync(path.join(venv, "lib", d, "site-packages", "demucs")));
  } catch { return false; }
}

// The setting wins over the env var so the choice in Settings sticks across restarts.
export function size() {
  if (remote()) return SIZES.includes(remoteHealth.data?.size) ? remoteHealth.data.size : "0.6B";
  const s = getSetting("qwen_size", null) || process.env.RESONANT_QWEN_SIZE || "0.6B";
  return SIZES.includes(s) ? s : "0.6B";
}
export const sizeOptions = () => (remote() ? null : SIZES.map((s) => ({ size: s, voices: hasModel("CustomVoice", s), cloning: hasModel("Base", s) })));
export function setSize(s) {
  if (remote()) throw httpError(422, "The model size is chosen on the GPU worker (start it with --size 0.6B or --size 1.7B).");
  if (!SIZES.includes(s)) throw httpError(422, `Model size must be one of ${SIZES.join(", ")}`);
  if (!hasModel("CustomVoice", s)) throw httpError(422, `Qwen3-TTS ${s} isn't downloaded. Download Qwen/Qwen3-TTS-12Hz-${s}-CustomVoice first.`);
  if (s === size()) return;
  setSetting("qwen_size", s);
  // The next request starts the worker with the new size. Generations already running finish first.
  if (inflight) restartPending = true;
  else stop();
}

export const model = () => ({
  model_id: `qwen3_tts_${size().toLowerCase().replace(".", "_")}`,
  name: `Qwen3-TTS ${size()}`,
  description: "Expressive speech in 10 languages, with style instructions and voice cloning.",
  can_do_text_to_speech: true,
  can_use_style_instructions: true,
  can_clone_voice: true,
  languages: LANGUAGES,
});

// From the model card's speaker table.
const SPEAKERS = [
  ["vivian", "Vivian", "female", "chinese", "Bright young female voice."],
  ["serena", "Serena", "female", "chinese", "Warm, gentle young female voice."],
  ["uncle_fu", "Uncle Fu", "male", "chinese", "Seasoned male voice with a mellow timbre."],
  ["dylan", "Dylan", "male", "chinese (beijing)", "Youthful Beijing male voice."],
  ["eric", "Eric", "male", "chinese (sichuan)", "Lively Chengdu male voice."],
  ["ryan", "Ryan", "male", "english", "Dynamic male voice with rhythm."],
  ["aiden", "Aiden", "male", "english", "Sunny American male voice."],
  ["ono_anna", "Ono Anna", "female", "japanese", "Playful Japanese female voice."],
  ["sohee", "Sohee", "female", "korean", "Warm Korean female voice."],
];

const localPython = () => fs.existsSync(PYTHON);
export const pythonPath = () => PYTHON;
export function pyPackage(name) {
  const venv = path.dirname(path.dirname(PYTHON));
  if (fs.existsSync(path.join(venv, "Lib", "site-packages", name))) return true;
  try { return fs.readdirSync(path.join(venv, "lib")).some((d) => fs.existsSync(path.join(venv, "lib", d, "site-packages", name))); } catch { return false; }
}
const localTranscribe = () => localPython() && pyPackage("faster_whisper") && fs.existsSync(path.join(MODELS_DIR, "whisper-large-v3-turbo", "model.bin"));
const localDiarize = () => localPython() && pyPackage("speechbrain") && fs.existsSync(path.join(MODELS_DIR, "ecapa-voxceleb", "embedding_model.ckpt"));
export const canTranscribe = () => (remote() ? Boolean(remoteCaps().transcribe) : localTranscribe());
export const canDiarize = () => (remote() ? Boolean(remoteCaps().diarize) : localDiarize());
const localConvert = () => localPython() && pyPackage("openvoice") && fs.existsSync(path.join(MODELS_DIR, "openvoice-v2", "converter", "checkpoint.pth"));
export const canConvert = () => (remote() ? Boolean(remoteCaps().convert) : localConvert());
export const available = () => (remote() ? Boolean(remoteCaps().custom_voice) : localPython() && hasModel("CustomVoice"));
export const canClone = () => (remote() ? Boolean(remoteCaps().base) : localPython() && hasModel("Base"));
export const canDesign = () => (remote() ? Boolean(remoteCaps().voice_design) : localPython() && installed(DESIGN_REPO));
export const canIsolate = () => (remote() ? Boolean(remoteCaps().isolate) : localPython() && demucsInstalled());

let status = "idle";
export const state = () => {
  if (remote()) return remoteHealth.ok ? "ready" : remoteHealth.data ? "error" : "loading";
  return available() || canIsolate() || canTranscribe() || canConvert() ? status : "unavailable";
};

export function presetVoices() {
  if (!available()) return [];
  return SPEAKERS.map(([id, name, gender, native, desc]) => ({
    voice_id: `qwen_${id}`,
    name,
    category: "premade",
    provider: "qwen",
    description: desc,
    labels: { gender, accent: native, language: "multilingual", native_language: native },
    preview_url: `/v1/voices/qwen_${id}/preview`,
    settings: {},
    high_quality_base_model_ids: [model().model_id],
    style_instructions: true,
    qwen: { speaker: id },
  }));
}

// Built-in library voices: designed once by scripts/build-library.mjs, then spoken by cloning their reference clip.
export const LIBRARY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "library");
let library = { mtime: 0, voices: [] };
export function libraryVoices() {
  if (!canClone()) return [];
  const file = path.join(LIBRARY_DIR, "voices.json");
  let mtime;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return []; }
  if (mtime !== library.mtime) {
    library = {
      mtime,
      voices: JSON.parse(fs.readFileSync(file, "utf8")).map((v) => ({
        voice_id: `lib_${v.id}`,
        name: v.name,
        category: "premade",
        provider: "qwen",
        description: v.description,
        labels: v.labels,
        preview_url: `/v1/voices/lib_${v.id}/preview`,
        settings: {},
        style_instructions: false,
        qwen: { ref_audio: path.join(LIBRARY_DIR, "voices", v.file), ref_text: v.ref_text },
      })),
    };
  }
  return library.voices.map((v) => ({ ...v, high_quality_base_model_ids: [model().model_id] }));
}

// ---------- HTTP without fetch's 5-minute response timeout (long CPU jobs exceed it) ----------
function request(url, { method = "POST", body, headers = {}, token, timeoutMs = 0, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, { method, headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-length": body.length } : {}) } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error("timed out")));
    signal?.addEventListener("abort", () => req.destroy(cancelled()), { once: true });
    req.on("error", reject);
    req.end(body);
  });
}

// The listener went away (a stopped stream): status 499 isn't logged as a server error.
const cancelled = () => httpError(499, "Cancelled");

// ---------- local worker process ----------
let proc = null;
let ready = null;
// The local worker listens on a random port on 127.0.0.1. A fresh token per start keeps other
// programs on this computer (and web pages that find the port) from using it.
let localToken = "";
let idleTimer = null;
let inflight = 0;
let restartPending = false;

function start() {
  if (ready) return ready;
  if (!localPython()) throw httpError(503, `Qwen3-TTS needs its Python environment at ${PYTHON}. See README → Qwen3-TTS.`);
  status = "loading";
  localToken = crypto.randomBytes(24).toString("hex");
  ready = new Promise((resolve, reject) => {
    proc = spawn(PYTHON, [WORKER, "0"], {
      env: { ...process.env, HF_HOME, RESONANT_MODELS_DIR: MODELS_DIR, HF_HUB_OFFLINE: "1", QWEN_TTS_SIZE: size(), PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1", RESONANT_WORKER_TOKEN: localToken },
      windowsHide: true,
    });
    let out = "";
    proc.stdout.on("data", (d) => {
      out += d;
      const m = out.match(/READY (\d+)/);
      if (m) { status = "ready"; resolve(`http://127.0.0.1:${m[1]}`); }
    });
    proc.stderr.on("data", (d) => {
      for (const line of String(d).split(/\r?\n/)) if (line.startsWith("[qwen]") || /Error|Traceback/.test(line)) console.log(line);
    });
    const self = proc;
    proc.on("exit", (code, signal) => {
      reject(httpError(503, `Qwen3-TTS worker exited (code ${code})`));
      // Only an exit we didn't ask for is worth reporting (stop() forgets the process first).
      if (proc === self) { console.log(`[qwen] worker exited unexpectedly (code ${code}, signal ${signal})`); proc = null; ready = null; status = "idle"; }
    });
  });
  return ready;
}

function touch() {
  clearTimeout(idleTimer);
  if (IDLE_MS > 0 && proc) {
    idleTimer = setTimeout(() => { console.log("[qwen] stopping idle worker"); stop(); }, IDLE_MS);
    idleTimer.unref();
  }
}
export function stop() {
  proc?.kill();
  // Forget the old worker now so a request arriving before 'exit' fires starts a fresh one.
  proc = null; ready = null; status = "idle"; restartPending = false;
}
process.on("exit", stop);

// `signal` cancels a request whose listener has gone. A job not started yet is dropped. A job the
// local worker is already running can't be interrupted inside the model, so when it's the only one,
// the worker is restarted: that frees the CPU now instead of after minutes of unwanted work, at
// the cost of loading the model again on the next request.
async function call(endpoint, payload, { headers = { "content-type": "application/json" }, signal } = {}, retried = false) {
  if (signal?.aborted) throw cancelled();
  inflight++;
  const r = remote();
  try {
    const base = r ? r.url : await start();
    const worker = proc; // the process serving this request
    touch();
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
    const res = await request(base + endpoint, { body, headers, token: r ? r.token : localToken, signal }).catch((e) => {
      if (signal?.aborted) {
        if (!r && inflight === 1 && proc === worker) { console.log(`[qwen] ${endpoint} cancelled by the listener; restarting the worker to free the CPU`); stop(); }
        throw cancelled();
      }
      if (r) { refreshRemote(); throw httpError(503, `The GPU worker at ${r.url} isn't reachable. Check that it's running, or switch back to this computer in Settings → Providers.`); }
      // The local worker crashed: most often a model swap that briefly needed more memory than was free.
      // A fresh worker starts with nothing loaded, so it usually succeeds; retry once with one.
      if (!retried) return null;
      throw httpError(503, "Qwen3-TTS stopped while generating, most likely because the computer ran low on memory. Close some apps and try again.");
    });
    if (res === null) {
      console.log(`[qwen] worker crashed during ${endpoint}; starting a fresh one and retrying once`);
      if (proc === worker) stop(); // only the crashed process; another request may already have started a new one
      return await call(endpoint, payload, { headers, signal }, true);
    }
    touch();
    if (res.status !== 200) {
      let msg = `Qwen3-TTS error ${res.status}`;
      try { msg = JSON.parse(res.body.toString("utf8")).error || msg; } catch {}
      if (res.status === 401) msg = "The GPU worker rejected the token. Update it in Settings → Providers.";
      throw httpError(res.status >= 500 ? 500 : 400, msg);
    }
    const b = res.body;
    if (String(res.headers["content-type"]).includes("json")) return JSON.parse(b.toString("utf8"));
    // Copy into an aligned buffer: Buffer slices may not start on a 4-byte boundary.
    return { samples: new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)), rate: Number(res.headers["x-sample-rate"]) };
  } finally {
    if (--inflight === 0 && restartPending) stop();
  }
}

// Reference clips go with the request so a worker on another machine can use them too.
const refCache = new Map();
function refB64(file) {
  const mtime = fs.statSync(file).mtimeMs;
  const hit = refCache.get(file);
  if (hit?.mtime === mtime) return hit.b64;
  const b64 = fs.readFileSync(file).toString("base64");
  refCache.set(file, { mtime, b64 });
  if (refCache.size > 200) refCache.delete(refCache.keys().next().value);
  return b64;
}

// ~350 characters is ~25 s of speech: long enough for natural phrasing, short enough that each
// request returns well within a minute or two on CPU.
export async function* synthesize(text, voice, { language, instruct, first, signal } = {}) {
  for (const chunk of chunkText(text, 350, first)) {
    if (signal?.aborted) return;
    if (voice.qwen?.speaker) yield await call("/custom_voice", { text: chunk, speaker: voice.qwen.speaker, language, instruct }, { signal });
    else if (voice.qwen?.ref_audio) yield await call("/clone", { text: chunk, ref_audio_b64: refB64(voice.qwen.ref_audio), ref_text: voice.qwen.ref_text, language }, { signal });
    else throw httpError(400, `Voice '${voice.name}' is not a Qwen3-TTS voice`);
  }
}

// Speaks `text` in a brand-new voice described in plain language (Voice Design 1.7B).
export function design(text, { description, language }) {
  if (!canDesign()) throw httpError(503, `Voice design needs Qwen/${DESIGN_REPO}. Download it to use this feature.`);
  return call("/design", { text, instruct: description, language: language || "auto" });
}

// Body for /transcribe and /diarize: uint32 LE length of the options JSON, the JSON, then float32
// mono 16 kHz samples. (Options can include a long word list, too big for a header.)
function packed(samples, opts) {
  const json = Buffer.from(JSON.stringify(opts));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length);
  return Buffer.concat([len, json, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]);
}
const packedHeaders = { headers: { "content-type": "application/octet-stream", "x-sample-rate": "16000" } };

// Whisper large-v3-turbo on 16 kHz mono samples: words with timestamps, the detected language and,
// with diarize, a speaker per word.
export function transcribe(samples, { language, diarize, num_speakers } = {}) {
  if (!canTranscribe()) throw httpError(503, "Whisper large-v3-turbo isn't installed. See README → Speech to text.");
  if (diarize && !canDiarize()) throw httpError(503, "Speaker detection isn't installed. See README → Speech to text.");
  return call("/transcribe", packed(samples, { language: language || null, diarize: Boolean(diarize), num_speakers: num_speakers || null }), packedHeaders);
}
// Speaker per word for words that came from another transcriber (e.g. Whisper Base).
export function diarize(samples, words, { num_speakers } = {}) {
  if (!canDiarize()) throw httpError(503, "Speaker detection isn't installed. See README → Speech to text.");
  const slim = words.map((w) => ({ start: w.start, end: w.end }));
  return call("/diarize", packed(samples, { words: slim, num_speakers: num_speakers || null }), packedHeaders);
}

// Speech-to-speech: re-voices mono float32 `samples` with the voice in `refWav` (a WAV buffer), keeping
// the words, timing and emotion of the input (OpenVoice V2). Returns { samples, rate }.
export function convert(samples, rate, refWav, { passes = 2 } = {}) {
  if (!canConvert()) throw httpError(503, "The local voice changer needs OpenVoice. See README → Voice changer.");
  return call("/convert", packed(samples, { ref_audio_b64: refWav.toString("base64"), passes }), { headers: { "content-type": "application/octet-stream", "x-sample-rate": String(rate) } });
}

// Removes music and background noise, keeping the voice (Demucs htdemucs). Mono float32 in and out.
export function isolate(samples, rate) {
  if (!canIsolate()) throw httpError(503, "Local voice isolation needs Demucs in the worker's Python environment. See README → Voice isolation.");
  const buf = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  return call("/isolate", buf, { headers: { "content-type": "application/octet-stream", "x-sample-rate": String(rate) } });
}
