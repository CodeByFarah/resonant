// On-device engines: Kokoro (TTS), Whisper (STT), MusicGen (text-to-audio).
import { env, pipeline, AutoTokenizer, MusicgenForConditionalGeneration } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import path from "node:path";
import os from "node:os";
import { concat, silence, httpError } from "../audio.mjs";

// Short path: onnxruntime-node cannot open model files past Windows MAX_PATH.
env.cacheDir = process.env.RESONANT_MODELS_DIR || path.join(os.homedir(), ".resonant", "models");

export const MODELS = {
  tts: { model_id: "kokoro_82m", name: "Kokoro 82M", repo: "onnx-community/Kokoro-82M-v1.0-ONNX", description: "Local, fast, natural English speech in 28 voices.", can_do_text_to_speech: true, languages: [{ language_id: "en", name: "English" }], max_characters_request_free_user: 20000 },
  stt: { model_id: "whisper_base", name: "Whisper Base", repo: "onnx-community/whisper-base_timestamped", description: "Local multilingual transcription with word timestamps.", can_do_speech_to_text: true },
  sfx: { model_id: "musicgen_small", name: "MusicGen Small", repo: "Xenova/musicgen-small", description: "Local text-to-audio for ambiences, textures and music beds.", can_do_sound_effects: true },
};

const state = { tts: "idle", stt: "idle", sfx: "idle" };
export const modelState = () => ({ ...state });

// The ONNX sessions are not safe to run concurrently; serialize all inference.
let queue = Promise.resolve();
const serial = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

function lazy(key, load) {
  let p = null;
  const get = () => {
    if (!p) {
      state[key] = "loading";
      p = load().then((v) => { state[key] = "ready"; return v; }, (e) => { state[key] = "error"; p = null; throw e; });
    }
    return p;
  };
  get.reset = () => { const old = p; p = null; state[key] = "idle"; return old; };
  return get;
}

// Frees a model after it sits unused. New requests load a fresh copy; the old one is
// disposed through the inference queue so jobs already queued on it finish first.
function unloadWhenIdle(key, getter, idleMs, dispose) {
  let timer = null;
  const touch = () => {
    clearTimeout(timer);
    if (!(idleMs > 0)) return;
    timer = setTimeout(() => {
      const old = getter.reset();
      serial(async () => { await dispose(await old); console.log(`[${key}] unloaded after ${(idleMs / 60000).toFixed(1)} min idle`); });
    }, idleMs);
    timer.unref();
  };
  const get = async () => { const v = await getter(); touch(); return v; };
  get.touch = touch;
  return get;
}
const SFX_IDLE_MS = Number(process.env.RESONANT_SFX_IDLE_MINUTES ?? 5) * 60_000;

// Full precision: on x86 CPUs ONNX Runtime runs Kokoro's 8-bit weights slower than real time
// (measured 0.93× on an i5-13420H) and the 32-bit ones at 3.3×, for ~330 MB instead of ~90 MB.
// RESONANT_KOKORO_DTYPE=q8 brings back the small model for machines short on memory.
const KOKORO_DTYPE = process.env.RESONANT_KOKORO_DTYPE || "fp32";
const getKokoro = lazy("tts", () => KokoroTTS.from_pretrained(MODELS.tts.repo, { dtype: KOKORO_DTYPE, device: "cpu" }));
const getWhisper = lazy("stt", () => pipeline("automatic-speech-recognition", MODELS.stt.repo, { dtype: "q8" }));
const getMusicgen = unloadWhenIdle("sfx", lazy("sfx", async () => {
  const tokenizer = await AutoTokenizer.from_pretrained(MODELS.sfx.repo);
  const model = await MusicgenForConditionalGeneration.from_pretrained(MODELS.sfx.repo, {
    dtype: { text_encoder: "q8", decoder_model_merged: "q8", encodec_decode: "fp32" },
  });
  return { tokenizer, model };
}), SFX_IDLE_MS, ({ model }) => model.dispose());

export function warmup() {
  getKokoro().catch((e) => console.error("[tts] load failed:", e.message));
}

const ACCENTS = { a: "american", b: "british" };
export const previewText = "Hello! This is how I sound. I can narrate stories, read the news, or voice your next video.";

export async function listVoices() {
  const tts = await getKokoro();
  return Object.entries(tts.voices).map(([id, v]) => ({
    voice_id: id,
    name: v.name,
    category: "premade",
    provider: "local",
    description: `${v.gender} voice with ${ACCENTS[id[0]] === "american" ? "an American" : "a British"} accent`,
    labels: { gender: v.gender.toLowerCase(), accent: ACCENTS[id[0]] || "other", language: "en", quality: v.overallGrade },
    preview_url: `/v1/voices/${id}/preview`,
    settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1 },
    high_quality_base_model_ids: [MODELS.tts.model_id],
  }));
}

// Kokoro handles ~500 phoneme tokens per pass; split on sentence boundaries. When streaming,
// `first` caps the first chunk lower so the first audio arrives sooner.
export function chunkText(text, max = 240, first = max) {
  const sentences = text.replace(/\s+/g, " ").trim().match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) || [];
  const chunks = [];
  let cur = "";
  const cap = () => (chunks.length ? max : first);
  for (const s of sentences) {
    if ((cur + s).length > cap() && cur) { chunks.push(cur.trim()); cur = ""; }
    if (s.length > max) {
      for (const part of s.match(new RegExp(`.{1,${max}}(\\s|$)`, "g")) || [s]) chunks.push(part.trim());
    } else cur += s;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter(Boolean);
}

// Yields one Float32Array per text chunk so callers can stream.
export async function* synthesize(text, { voice_id, speed = 1, first }) {
  const tts = await getKokoro();
  if (!tts.voices[voice_id]) throw httpError(404, `Voice ${voice_id} not found`);
  const s = Math.min(Math.max(Number(speed) || 1, 0.5), 2);
  const chunks = chunkText(text, 240, first);
  for (let i = 0; i < chunks.length; i++) {
    const out = await serial(() => tts.generate(chunks[i], { voice: voice_id, speed: s }));
    yield { samples: i < chunks.length - 1 ? concat([out.audio, silence(0.15, out.sampling_rate)]) : out.audio, rate: out.sampling_rate };
  }
}

export async function synthesizeAll(text, opts) {
  const parts = [];
  let rate = 24000;
  for await (const p of synthesize(text, opts)) { parts.push(p.samples); rate = p.rate; }
  return { samples: concat(parts), rate };
}

// samples: mono Float32 @ 16 kHz
export async function transcribe(samples, { language_code } = {}) {
  const asr = await getWhisper();
  const opts = { return_timestamps: "word", chunk_length_s: 30, stride_length_s: 5 };
  if (language_code) { opts.language = language_code; opts.task = "transcribe"; }
  const out = await serial(() => asr(samples, opts));
  const words = [];
  let prevEnd = 0;
  for (const c of out.chunks || []) {
    const [start, end] = c.timestamp;
    const s = start ?? prevEnd;
    if (words.length) words.push({ text: " ", start: prevEnd, end: Math.max(s, prevEnd), type: "spacing", speaker_id: "speaker_0", logprob: 0 });
    words.push({ text: c.text.trim(), start: s, end: end ?? s, type: "word", speaker_id: "speaker_0", logprob: 0 });
    prevEnd = end ?? s;
  }
  return { text: out.text.trim(), words, language_code: language_code || null };
}

const MUSICGEN_TOKENS_PER_SEC = 50;
export async function generateSound(prompt, { duration_seconds, prompt_influence = 0.3, loop = false } = {}) {
  const { tokenizer, model } = await getMusicgen();
  const duration = Math.min(Math.max(Number(duration_seconds) || 5, 0.5), 30);
  const fade = loop ? 0.5 : 0;
  const inputs = tokenizer(prompt);
  const audio = await serial(() => model.generate({
    ...inputs,
    // +4 covers the codebook delay pattern, which consumes tokens without producing audio.
    max_new_tokens: Math.ceil((duration + fade) * MUSICGEN_TOKENS_PER_SEC) + 4,
    do_sample: true,
    guidance_scale: 1 + Math.min(Math.max(Number(prompt_influence) || 0, 0), 1) * 5,
  }));
  getMusicgen.touch();
  const rate = model.config.audio_encoder.sampling_rate;
  let samples = new Float32Array(audio.data);
  if (loop) samples = makeLoop(samples, Math.round(fade * rate));
  return { samples: samples.subarray(0, Math.round(duration * rate)), rate };
}

// Crossfades the tail into the head so the clip repeats without a click.
function makeLoop(s, n) {
  if (s.length <= n * 2) return s;
  const body = s.slice(0, s.length - n);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    body[i] = body[i] * t + s[s.length - n + i] * (1 - t);
  }
  return body;
}
