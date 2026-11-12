// Records the landing page samples with the running server: built-in Kokoro voices, plus accented
// voices made with Voice Design (Qwen3-TTS VoiceDesign). Each clip is brought up to podcast
// loudness, transcribed for word timings, and written to site/audio/ and site/samples.js.
// The history items, transcripts and design previews it creates are removed afterwards.
//
// Usage, with Resonant running: node scripts/make-site-samples.mjs [only-these-ids...]
// `dialogue-gaps` re-cuts the existing dialogue's pauses (DIALOGUE_GAP) without recording again.
// (BASE=http://host:port to change the server). Voice Design runs on the Qwen3 worker, which
// is slow on a CPU: about a minute per accented clip on an i5 laptop.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const { decodeToMono, encodeMp3 } = await import(pathToFileURL(path.join(ROOT, "server", "audio.mjs")).href);
const BASE = process.env.BASE || "http://127.0.0.1:3000";
const OUT = path.join(ROOT, "site");
const DESIGNS = path.join(ROOT, "data", "designs");
const ONLY = process.argv.slice(2);
fs.mkdirSync(path.join(OUT, "audio"), { recursive: true });

// The hero's voice picker, in order. `voice` uses a built-in voice; `design` describes a new one.
const VOICES = [
  { id: "heart", name: "Heart", accent: "American", voice: "af_heart",
    text: "Okay, confession. I've read this page out loud forty times today, and honestly? I'm still not bored." },
  { id: "fergus", name: "Fergus", accent: "Scottish",
    design: "An older Scottish man from the Highlands with a strong, warm Scottish accent and a deep, slightly gravelly voice. A born storyteller: slow, hushed and full of suspense, as if telling a ghost story by the fire.",
    text: "Gather round, now. The wind was howling over the hills that night, and old Callum swore he heard someone call his name." },
  { id: "mia", name: "Mia", accent: "Australian",
    design: "A young Australian woman with a broad, cheerful Australian accent. Bubbly, energetic and fast, like a travel vlogger who has just landed somewhere exciting.",
    text: "G'day! Right, so we've just landed in Sydney, the sun is out, and I have absolutely no plan. Let's go!" },
  // `keep`: the designed voice is saved for this run so the dialogue can reuse it, then deleted.
  { id: "siobhan", name: "Siobhán", accent: "Irish", keep: true,
    design: "A woman in her forties from Dublin with a lilting Irish accent. Warm, witty and amused, as if chatting with a friend over a cup of tea.",
    text: "Ah, would you look at that. The kettle's on, the rain is coming down sideways, and sure, isn't it a grand day for a story?" },
  { id: "earl", name: "Earl", accent: "Southern US",
    design: "An older man from the American South, Georgia, with a slow, relaxed Southern drawl. Friendly, unhurried and folksy, like a late-night radio host.",
    text: "Well now, pull up a chair. Down here we don't rush a good story, and this one is worth the wait." },
  { id: "george", name: "George", accent: "British", voice: "bm_george",
    text: "In a world where every word costs money... one studio dared to do something different. It runs on your laptop. And it's free." },
];
const PAUSE = { id: "pause", voice: "af_heart", text: "And the winner is... [pause 1.5s] you! Because this voice didn't cost you a penny." };
// `voice` names a designed voice above (it must be re-recorded in the same run); `voice_id` a built-in one.
const DIALOGUE = [
  { voice: "siobhan", name: "Siobhán", text: "Wait. You made this whole podcast on a laptop?" },
  { voice_id: "bm_george", name: "George", text: "Every single word. No studio, no subscription." },
  { voice: "siobhan", name: "Siobhán", text: "Okay, that's either genius or completely ridiculous." },
  { voice_id: "bm_george", name: "George", text: "Why not both?" },
];

const history = [], transcripts = [], designs = [], saved = {};
const want = (id) => !ONLY.length || ONLY.includes(id);
async function post(url, body) {
  const r = await fetch(BASE + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${url}: ${r.status} ${await r.text()}`);
  return r;
}

// Loudness: brings speech to about -14 dBFS RMS (podcast/video level; the raw models come out
// around -21) and keeps peaks under -1 dBFS with a look-ahead limiter, so nothing clips.
const TARGET_RMS = 10 ** (-14 / 20), CEILING = 10 ** (-1 / 20);
function loud(x, rate) {
  const block = Math.round(rate * 0.04), levels = [];
  for (let i = 0; i < x.length; i += block) {
    let s = 0; const end = Math.min(i + block, x.length);
    for (let j = i; j < end; j++) s += x[j] * x[j];
    levels.push(Math.sqrt(s / (end - i)));
  }
  const active = levels.filter((l) => l > 0.01);
  const rms = Math.sqrt(active.reduce((a, l) => a + l * l, 0) / Math.max(active.length, 1)) || 1e-4;
  const gain = Math.min(TARGET_RMS / rms, 10 ** (18 / 20));
  const need = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i]) * gain; need[i] = v > CEILING ? CEILING / v : 1; }
  const look = Math.round(rate * 0.005), release = 1 - Math.exp(-1 / (rate * 0.08));
  const y = new Float32Array(x.length);
  let env = 1;
  for (let i = 0; i < x.length; i++) {
    let m = 1;
    for (let j = i; j < Math.min(i + look, x.length); j++) if (need[j] < m) m = need[j];
    env = m < env ? m : env + (1 - env) * release;
    y[i] = Math.max(-CEILING, Math.min(CEILING, x[i] * gain * env));
  }
  return { samples: y, gainDb: 20 * Math.log10(gain) };
}
async function finish(id, buf) {
  const { samples, rate } = await decodeToMono(buf, 44100);
  const out = loud(samples, rate);
  const mp3 = encodeMp3(out.samples, rate, 128);
  fs.writeFileSync(path.join(OUT, "audio", `${id}.mp3`), mp3);
  return { mp3, gainDb: out.gainDb };
}
// Shortens the silence between speakers to `gap` seconds and moves the word timings to match.
// The quiet stretch around each change of speaker is found from the audio level (below a tenth
// of the speech level); a little of it is kept on each side so words don't sound clipped.
const DIALOGUE_GAP = 0.15;
function tighten(x, rate, lines, gap = DIALOGUE_GAP) {
  const frame = Math.round(rate * 0.01);
  let sum = 0, n = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i] * x[i]; if (v > 1e-4) { sum += v; n++; } }
  const floor = Math.sqrt(sum / Math.max(n, 1)) * 0.1;
  const quietAt = (t) => {
    const i = Math.round(t * rate); let s = 0, c = 0;
    for (let j = i; j < Math.min(i + frame, x.length); j++, c++) s += x[j] * x[j];
    return !c || Math.sqrt(s / c) < floor;
  };
  const cuts = [];
  for (let k = 0; k < lines.length - 1; k++) {
    const end = lines[k].words.at(-1)[2], next = lines[k + 1].words[0][1];
    let q0 = (end + next) / 2, q1 = q0;
    if (!quietAt(q0)) continue;
    while (q0 > 0 && quietAt(q0 - 0.01)) q0 -= 0.01;
    while (q1 < x.length / rate && quietAt(q1)) q1 += 0.01;
    const from = q0 + gap * 0.4, to = q1 - gap * 0.6;
    if (to > from) cuts.push([from, to]);
  }
  const keep = [];
  let pos = 0;
  for (const [a, b] of cuts) { keep.push(x.subarray(Math.round(pos * rate), Math.round(a * rate))); pos = b; }
  keep.push(x.subarray(Math.round(pos * rate)));
  const out = new Float32Array(keep.reduce((m, p) => m + p.length, 0));
  keep.reduce((o, p) => (out.set(p, o), o + p.length), 0);
  const shift = (t) => +(t - cuts.filter(([a]) => a < t).reduce((s, [a, b]) => s + (b - a), 0)).toFixed(2);
  return {
    samples: out,
    lines: lines.map((l) => ({ ...l, words: l.words.map(([w, s, e, tag]) => (tag ? [w, s, e, tag] : [w, shift(s), shift(e)])) })),
  };
}
async function timings(buf) {
  const form = new FormData();
  form.set("file", new Blob([buf], { type: "audio/mpeg" }), "s.mp3");
  form.set("language_code", "en");
  const r = await fetch(`${BASE}/v1/speech-to-text`, { method: "POST", body: form });
  const t = await r.json();
  transcripts.push(t.transcription_id);
  return { words: t.words.filter((w) => w.type === "word").map((w) => [w.text, +w.start.toFixed(2), +w.end.toFixed(2)]), duration: +t.duration.toFixed(2) };
}
// Pairs each word of the script with Whisper's timing. When Whisper hears a different number of
// words (accents, "G'day" as two words), timings are spread proportionally instead, which keeps
// the highlight moving with the voice. Tags such as [pause 1.5s] are marked with a fourth field.
const isTag = (t) => t.startsWith("[") || t.endsWith("]");
function timed(text, words) {
  const toks = text.split(/\s+/).filter(Boolean);
  const n = toks.filter((t) => !isTag(t)).length;
  if (n !== words.length) console.warn(`  heard ${words.length} words for ${n}; spreading timings`);
  let i = 0;
  return toks.map((t) => {
    if (isTag(t)) return [t, null, null, 1];
    const from = Math.floor((i * words.length) / n);
    const to = Math.max(Math.floor(((i + 1) * words.length) / n) - 1, from);
    i++;
    return [t, words[from][1], words[to][2]];
  });
}
async function speak(s) {
  const t0 = Date.now();
  let raw;
  if (s.design) {
    const r = await post("/v1/text-to-voice/design?output_format=mp3_44100_128", { voice_description: s.design, text: s.text, language: "English" });
    const j = await r.json();
    designs.push(j.previews[0].generated_voice_id);
    raw = Buffer.from(j.previews[0].audio_base_64, "base64");
    if (s.keep) {
      const v = await (await post("/v1/text-to-voice", { voice_name: `Landing page: ${s.name}`, generated_voice_id: j.previews[0].generated_voice_id, voice_description: s.design })).json();
      saved[s.id] = v.voice_id;
    }
  } else {
    const r = await post(`/v1/text-to-speech/${s.voice}?output_format=mp3_44100_128`, { text: s.text });
    history.push(r.headers.get("history-item-id"));
    raw = Buffer.from(await r.arrayBuffer());
  }
  const { mp3, gainDb } = await finish(s.id, raw);
  const w = await timings(mp3);
  console.log(`${s.id}: ${((Date.now() - t0) / 1000).toFixed(0)} s to make, ${w.duration} s long, +${gainDb.toFixed(1)} dB`);
  return w;
}

// Keeps clips that aren't being re-recorded this run.
const previous = {};
try {
  const src = fs.readFileSync(path.join(OUT, "samples.js"), "utf8");
  for (const s of JSON.parse(src.slice(src.indexOf("=") + 1).trim().replace(/;$/, ""))) previous[s.id] = s;
} catch {}

const page = [];
try {
  for (const s of [...VOICES, PAUSE]) {
    if (!want(s.id) && previous[s.id]) { page.push(previous[s.id]); continue; }
    if (!want(s.id)) continue;
    const w = await speak(s);
    page.push({ id: s.id, file: `audio/${s.id}.mp3`, duration: w.duration, name: s.name, accent: s.accent, designed: s.design ? true : undefined, words: timed(s.text, w.words) });
  }
  if (ONLY.includes("dialogue-gaps") && previous.dialogue) {
    // Re-cuts the existing dialogue's pauses without recording it again.
    const { samples, rate } = await decodeToMono(fs.readFileSync(path.join(OUT, previous.dialogue.file)), 44100);
    const t = tighten(samples, rate, previous.dialogue.lines);
    fs.writeFileSync(path.join(OUT, previous.dialogue.file), encodeMp3(t.samples, rate, 128));
    page.push({ ...previous.dialogue, duration: +(t.samples.length / rate).toFixed(2), lines: t.lines });
    console.log(`dialogue: pauses shortened, ${previous.dialogue.duration} s -> ${(t.samples.length / rate).toFixed(2)} s`);
  } else if (!want("dialogue")) { if (previous.dialogue) page.push(previous.dialogue); }
  else {
    const t0 = Date.now();
    const inputs = DIALOGUE.map((l) => {
      const voice_id = l.voice_id || saved[l.voice];
      if (!voice_id) throw new Error(`The dialogue uses ${l.voice}; re-record it in the same run: node scripts/make-site-samples.mjs ${l.voice} dialogue`);
      return { voice_id, text: l.text };
    });
    // Each line is recorded on its own, so its start is known exactly and it's timed on its own
    // (cutting a finished dialogue at its silences doesn't work: cloned voices pause mid-line).
    // The lines are joined, then the pauses between speakers are shortened to DIALOGUE_GAP.
    const RATE = 44100, GAP = 0.35;
    const parts = [], lines = [];
    let at = 0;
    for (const [k, inp] of inputs.entries()) {
      const r = await post(`/v1/text-to-speech/${inp.voice_id}?output_format=mp3_44100_128`, { text: inp.text });
      history.push(r.headers.get("history-item-id"));
      const raw = Buffer.from(await r.arrayBuffer());
      const { samples } = await decodeToMono(raw, RATE);
      const w = await timings(raw);
      const shifted = w.words.map(([t, s, e]) => [t, +(s + at).toFixed(2), +(e + at).toFixed(2)]);
      lines.push({ name: DIALOGUE[k].name, words: timed(DIALOGUE[k].text, shifted.length ? shifted : [["", at, at + samples.length / RATE]]) });
      if (k) parts.push(new Float32Array(Math.round(GAP * RATE)));
      parts.push(samples);
      at += samples.length / RATE + GAP;
    }
    const joined = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    parts.reduce((o, p) => (joined.set(p, o), o + p.length), 0);
    const tight = tighten(joined, RATE, lines);
    const out = loud(tight.samples, RATE);
    fs.writeFileSync(path.join(OUT, "audio", "dialogue.mp3"), encodeMp3(out.samples, RATE, 128));
    const gainDb = out.gainDb;
    const duration = +(tight.samples.length / RATE).toFixed(2);
    page.push({ id: "dialogue", file: "audio/dialogue.mp3", duration, lines: tight.lines });
    console.log(`dialogue: ${((Date.now() - t0) / 1000).toFixed(0)} s to make, ${duration} s long, +${gainDb.toFixed(1)} dB`);
  }
  fs.writeFileSync(path.join(OUT, "samples.js"), `// Recorded with Resonant (Kokoro voices and Voice Design); word timings from Whisper. Regenerate with scripts/make-site-samples.mjs.\nwindow.SAMPLES = ${JSON.stringify(page)};\n`);
  for (const f of fs.readdirSync(path.join(OUT, "audio"))) if (!page.some((s) => s.file === `audio/${f}`)) fs.rmSync(path.join(OUT, "audio", f));
  console.log("wrote", page.length, "samples");
} finally {
  for (const id of history.filter(Boolean)) await fetch(`${BASE}/v1/history/${id}`, { method: "DELETE" });
  for (const id of transcripts.filter(Boolean)) await fetch(`${BASE}/v1/speech-to-text/transcripts/${id}`, { method: "DELETE" });
  for (const id of designs) for (const ext of ["wav", "json"]) fs.rmSync(path.join(DESIGNS, `${id}.${ext}`), { force: true });
  for (const id of Object.values(saved)) await fetch(`${BASE}/v1/voices/${id}`, { method: "DELETE" });
  console.log("cleaned up", history.length, "history items,", transcripts.length, "transcripts,", designs.length, "design previews,", Object.keys(saved).length, "saved voices");
}
