// Local translation. Each language pair uses the best model that runs on a CPU:
//   1. Opus-MT (Helsinki-NLP, CC-BY 4.0): one small model per pair (~115 MB at 8-bit), trained
//      for that pair, so "Good morning" comes out "Buenos días". Pairs without a direct model
//      go through English when both halves exist (e.g. German → Italian = de→en, en→it).
//   2. M2M100 418M (MIT, ~630 MB): one model for every pair, used where Opus-MT has no good
//      model (into Japanese and Korean) or when RESONANT_TRANSLATOR=m2m100.
// Models download on first use and unload after 10 idle minutes. Text is translated one sentence
// at a time, with a length cap and a no-repeat rule, which stops M2M100 from looping.
import { env, pipeline } from "@huggingface/transformers";
import path from "node:path";
import os from "node:os";

env.cacheDir = process.env.RESONANT_MODELS_DIR || path.join(os.homedir(), ".resonant", "models");
const IDLE_MS = 10 * 60_000;
const MAX_LOADED = 3;

// Languages Resonant can dub between: the ones Qwen3-TTS speaks.
export const LANGUAGES = [
  ["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"],
  ["ru", "Russian"], ["zh", "Chinese"], ["ja", "Japanese"], ["ko", "Korean"],
];
export const languageName = (code) => LANGUAGES.find(([c]) => c === code)?.[1] || code;

// Opus-MT pairs converted for transformers.js. en→ja is left out on purpose: that model was
// trained mostly on Bible text and reads oddly, so English → Japanese uses M2M100.
const OPUS = new Set([
  "en-es", "en-fr", "en-de", "en-it", "en-ru", "en-zh",
  "es-en", "es-fr", "es-de", "es-it", "es-ru",
  "fr-en", "fr-es", "fr-de", "fr-ru",
  "de-en", "de-es", "de-fr",
  "it-en", "it-es", "it-fr",
  "ru-en", "ru-es", "ru-fr",
  "zh-en", "ja-en", "ko-en",
]);
// Portuguese comes from the multi-language Romance models; the target is chosen with a token.
const SPECIAL = {
  "en-pt": { repo: "Xenova/opus-mt-en-ROMANCE", prefix: ">>pt_BR<< " },
  "pt-en": { repo: "Xenova/opus-mt-ROMANCE-en" },
};
const M2M = { repo: "Xenova/m2m100_418M", name: "M2M100 418M", m2m: true };

function opus(from, to) {
  const k = `${from}-${to}`;
  if (SPECIAL[k]) return { ...SPECIAL[k], name: "Opus-MT" };
  return OPUS.has(k) ? { repo: `Xenova/opus-mt-${k}`, name: "Opus-MT" } : null;
}
// The models that translate from → to, in order (one, or two through English).
export function route(from, to) {
  if (process.env.RESONANT_TRANSLATOR === "m2m100") return [M2M];
  const direct = opus(from, to);
  if (direct) return [direct];
  const a = opus(from, "en"), b = opus("en", to);
  if (from !== "en" && to !== "en" && a && b) return [a, b];
  return [M2M];
}
export function translatorName(from, to) {
  if (from === to) return null;
  const r = route(from, to);
  return r.length > 1 ? `${r[0].name} via English` : r[0].name;
}

// Loaded pipelines by repo, most recently used last; at most MAX_LOADED stay in memory.
const loaded = new Map();
let queue = Promise.resolve();
const serial = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };
function unload(repo) {
  const m = loaded.get(repo);
  if (!m) return;
  loaded.delete(repo);
  clearTimeout(m.timer);
  serial(async () => { (await m.p.catch(() => null))?.model?.dispose?.(); });
}
async function model(spec) {
  let m = loaded.get(spec.repo);
  if (m) loaded.delete(spec.repo);
  else {
    const t = Date.now();
    const p = pipeline("translation", spec.repo, { dtype: "q8" }).then((x) => { console.log(`[translate] loaded ${spec.repo} in ${((Date.now() - t) / 1000).toFixed(1)}s`); return x; }, (e) => { loaded.delete(spec.repo); throw e; });
    m = { p };
  }
  loaded.set(spec.repo, m);
  clearTimeout(m.timer);
  m.timer = setTimeout(() => { unload(spec.repo); console.log(`[translate] unloaded ${spec.repo} after 10 min idle`); }, IDLE_MS);
  m.timer.unref();
  while (loaded.size > MAX_LOADED) unload(loaded.keys().next().value);
  return m.p;
}

// Sentence split that keeps the punctuation (also for Chinese and Japanese full stops).
export function sentences(text) {
  return (text.replace(/\s+/g, " ").trim().match(/[^.!?…。！？]+[.!?…。！？]+["'”’)\]]*\s*|[^.!?…。！？]+$/g) || []).map((s) => s.trim()).filter(Boolean);
}
const joiner = (lang) => (["zh", "ja"].includes(lang) ? "" : " ");

// Opus-MT's tokenizer leaves a space after hyphens ("sexta- feira"), and the Italian model writes
// accents as apostrophes ("cosi'", "perche'"), as older Italian corpora do.
const GRAVE = { a: "à", e: "è", i: "ì", o: "ò", u: "ù" };
export function tidy(text, lang) {
  let s = text.replace(/(\p{L})- (?=\p{Ll})/gu, "$1-");
  if (lang === "it") s = s.replace(/(\p{L}*)([aeiou])'(?=[\s.,;:!?»"”)]|$)/giu, (m, w, v) => (/ch$/i.test(w) && v === "e" ? `${w}é` : w + (v === v.toUpperCase() ? GRAVE[v.toLowerCase()].toUpperCase() : GRAVE[v])));
  return s;
}

async function step(spec, text, from, to) {
  const tr = await model(spec);
  const out = [];
  for (const s of sentences(text)) {
    const opts = { max_new_tokens: Math.min(400, 20 + s.length * 2), no_repeat_ngram_size: spec.m2m ? 3 : 4 };
    if (spec.m2m) Object.assign(opts, { src_lang: from, tgt_lang: to });
    const [r] = await serial(() => tr((spec.prefix || "") + s, opts));
    out.push(spec.m2m ? r.translation_text.trim() : tidy(r.translation_text.trim(), to));
  }
  return out.join(joiner(to));
}

export async function translate(text, { from, to }) {
  if (!text.trim() || from === to) return text;
  const legs = route(from, to);
  if (legs.length === 1) return step(legs[0], text, from, to);
  return step(legs[1], await step(legs[0], text, from, "en"), "en", to);
}
