// Builds Resonant's built-in voice library from library/catalog.mjs.
// For each voice it asks the running server to design a reference clip with Qwen3-TTS 1.7B VoiceDesign,
// checks the take (length, loudness, and for English a Whisper transcript), retries bad takes, and saves
// the best one to library/voices/<id>.wav plus an entry in library/voices.json. Safe to stop and rerun:
// voices already built are skipped.
//
//   node scripts/build-library.mjs                 build everything missing
//   node scripts/build-library.mjs --only a,b      build (or rebuild) just these ids
//   BASE=http://127.0.0.1:3000 RESONANT_API_KEY=… node scripts/build-library.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG } from "../library/catalog.mjs";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const headers = process.env.RESONANT_API_KEY ? { "xi-api-key": process.env.RESONANT_API_KEY } : {};
const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "library");
const OUT = path.join(LIB, "voices");
const INDEX = path.join(LIB, "voices.json");
const ATTEMPTS = 3;
const PASS = 0.8; // share of reference words Whisper must hear back

fs.mkdirSync(OUT, { recursive: true });
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const only = arg("--only")?.split(",");

const readIndex = () => (fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, "utf8")) : []);
function saveEntry(entry) {
  const list = readIndex().filter((v) => v.id !== entry.id);
  // Keep catalog order so the library lists predictably.
  const order = new Map(CATALOG.map((v, i) => [v.id, i]));
  list.push(entry);
  list.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
  fs.writeFileSync(INDEX + ".tmp", JSON.stringify(list, null, 1));
  fs.renameSync(INDEX + ".tmp", INDEX);
}

// 16-bit PCM WAV, as the server returns for output_format=wav_24000.
function wavStats(buf) {
  const pcm = new Int16Array(buf.buffer, buf.byteOffset + 44, (buf.length - 44) >> 1);
  let sum = 0;
  for (const s of pcm) sum += s * s;
  return { duration: pcm.length / 24000, rms: Math.sqrt(sum / Math.max(1, pcm.length)) / 32768 };
}

const words = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean);
function overlap(expected, heard) {
  const pool = words(heard);
  let hit = 0;
  for (const w of words(expected)) {
    const i = pool.indexOf(w);
    if (i >= 0) { hit++; pool.splice(i, 1); }
  }
  return hit / Math.max(1, words(expected).length);
}

async function transcribe(wav) {
  const form = new FormData();
  form.set("file", new Blob([wav], { type: "audio/wav" }), "take.wav");
  form.set("language_code", "en");
  const r = await fetch(`${BASE}/v1/speech-to-text`, { method: "POST", headers, body: form });
  if (!r.ok) throw new Error(`speech-to-text ${r.status}: ${await r.text()}`);
  const out = await r.json();
  await fetch(`${BASE}/v1/speech-to-text/transcripts/${out.transcription_id}`, { method: "DELETE", headers });
  return out.text;
}

async function design(v) {
  const r = await fetch(`${BASE}/v1/text-to-voice/design?output_format=wav_24000`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ voice_description: v.prompt, text: v.text, language: v.qwen_language }),
  });
  if (!r.ok) throw new Error(`design ${r.status}: ${await r.text()}`);
  return Buffer.from((await r.json()).previews[0].audio_base_64, "base64");
}

// Rough speaking rates, to catch takes that ramble on or cut off.
const expectedSeconds = (v) => (["ja", "zh", "ko"].includes(v.language) ? v.text.length / 5 : words(v.text).length / 2.6);

async function build(v) {
  let best = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const t = Date.now();
    const wav = await design(v);
    const { duration, rms } = wavStats(wav);
    const exp = expectedSeconds(v);
    const problems = [];
    if (rms < 0.01) problems.push("too quiet");
    if (duration < exp * 0.5 || duration > exp * 2 || duration > 30) problems.push(`length ${duration.toFixed(1)}s (expected ~${exp.toFixed(0)}s)`);
    let score = problems.length ? 0 : 1;
    if (!problems.length && v.language === "en") {
      score = overlap(v.text, await transcribe(wav));
      if (score < PASS) problems.push(`transcript match ${(score * 100).toFixed(0)}%`);
    }
    console.log(`  ${v.id} take ${attempt}: ${duration.toFixed(1)}s in ${((Date.now() - t) / 1000).toFixed(0)}s${problems.length ? ` - ${problems.join(", ")}` : " - ok"}`);
    if (!best || score > best.score) best = { wav, duration, score, attempt };
    if (!problems.length) break;
  }
  if (best.score === 0) throw new Error("no usable take");
  fs.writeFileSync(path.join(OUT, `${v.id}.wav`), best.wav);
  saveEntry({
    id: v.id, name: v.name, description: v.description, labels: v.labels, file: `${v.id}.wav`, ref_text: v.text,
    qa: { duration: +best.duration.toFixed(2), score: +best.score.toFixed(2), attempts: best.attempt },
  });
}

const settings = await (await fetch(`${BASE}/api/settings`, { headers })).json();
if (!settings.qwen?.can_design) { console.error("The server can't design voices (needs Qwen3-TTS 1.7B VoiceDesign)."); process.exit(1); }

const done = new Set(readIndex().map((v) => v.id));
const todo = CATALOG.filter((v) => (only ? only.includes(v.id) : !done.has(v.id)));
console.log(`${todo.length} voice(s) to build, ${done.size} already in the library`);
const start = Date.now();
let failed = 0;
for (const [i, v] of todo.entries()) {
  console.log(`[${i + 1}/${todo.length}] ${v.name} (${v.id})`);
  try { await build(v); } catch (e) { failed++; console.log(`  FAILED ${v.id}: ${e.message}`); }
  const left = ((Date.now() - start) / (i + 1)) * (todo.length - i - 1);
  console.log(`  ~${Math.round(left / 60000)} min left`);
}
console.log(`done: ${readIndex().length} voices in the library, ${failed} failed`);
process.exit(failed ? 1 : 0);
