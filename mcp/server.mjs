#!/usr/bin/env node
// Resonant MCP server: lets AI apps (Claude Desktop, Claude Code, Cursor and any other MCP client)
// use the Resonant running on this computer: list voices, speak, make dialogues, transcribe,
// make sound effects, and design or clone voices. Audio files are saved to a folder and their
// paths returned, so the AI can tell you where they are.
//
// It talks to Resonant's local HTTP API; Resonant (the app or `npm start`) must be running.
// Settings:
//   RESONANT_URL         Resonant's address. Default: the first of http://127.0.0.1:3000-3005 that answers.
//   RESONANT_API_KEY     The access key, if the server requires one.
//   RESONANT_OUTPUT_DIR  Where audio is saved. Default: Documents/Resonant in your home folder.
// The protocol runs over stdin/stdout, so nothing here may print to stdout; logs go to stderr.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const KEY = process.env.RESONANT_API_KEY || "";
const OUTPUT_DIR = path.resolve(process.env.RESONANT_OUTPUT_DIR || path.join(os.homedir(), "Documents", "Resonant"));
const CANDIDATES = process.env.RESONANT_URL
  ? [process.env.RESONANT_URL.replace(/\/+$/, "")]
  : [3000, 3001, 3002, 3003, 3004, 3005].map((p) => `http://127.0.0.1:${p}`);

// ---------- talking to Resonant ----------
let base = null;
async function findResonant() {
  if (base) return base;
  for (const url of CANDIDATES) {
    try {
      const r = await fetch(url + "/api/health", { signal: AbortSignal.timeout(1500) });
      const h = await r.json();
      // Make sure it's Resonant and not some other app on the same port.
      if (h?.status === "ok" && h.models && typeof h.version === "string") return (base = url);
    } catch {}
  }
  throw new Error(process.env.RESONANT_URL
    ? `Resonant isn't answering at ${process.env.RESONANT_URL}. Start it, or fix RESONANT_URL.`
    : "Resonant isn't running. Open the Resonant app (or run `npm start` in its folder), then try again.");
}
async function call(p, init = {}) {
  const url = await findResonant();
  let r;
  try {
    r = await fetch(url + p, { ...init, headers: { ...(KEY ? { "xi-api-key": KEY } : {}), ...init.headers } });
  } catch {
    base = null; // it may have moved to another port; look again next time
    throw new Error("Lost the connection to Resonant. Is it still running?");
  }
  if (r.status === 401) throw new Error("Resonant needs an access key. Set RESONANT_API_KEY in this MCP server's settings.");
  if (!r.ok) {
    const body = await r.text();
    let msg = body;
    try { const j = JSON.parse(body); msg = j.detail?.message || j.detail || j.message || body; } catch {}
    throw new Error(`Resonant: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
  }
  return r;
}
const getJson = async (p) => (await call(p)).json();
const postJson = (p, body) => call(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ---------- files ----------
const slug = (s) => String(s).normalize("NFKD").replace(/[^\w\s-]/g, "").trim().split(/\s+/).slice(0, 6).join("-").toLowerCase().slice(0, 48) || "audio";
function outputPath(name, fallback, ext) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const stem = slug(name ? path.parse(path.basename(name)).name : fallback);
  let file = path.join(OUTPUT_DIR, `${stem}.${ext}`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(OUTPUT_DIR, `${stem}-${i}.${ext}`);
  return file;
}
async function saveAudio(res, file) {
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, buf);
  return buf.length;
}
function readAudio(p) {
  const file = path.resolve(p);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`No file at ${file}`);
  const ext = path.extname(file).toLowerCase();
  if (![".wav", ".mp3"].includes(ext)) throw new Error(`Resonant reads WAV and MP3 files; ${path.basename(file)} is ${ext || "another format"}. Convert it first (for example with ffmpeg).`);
  const size = fs.statSync(file).size;
  if (size > 50 * 1024 * 1024) throw new Error(`${path.basename(file)} is ${Math.round(size / 1048576)} MB; the limit is 50 MB.`);
  return { buffer: fs.readFileSync(file), name: path.basename(file), type: ext === ".mp3" ? "audio/mpeg" : "audio/wav" };
}
const kb = (n) => `${Math.round(n / 1024)} KB`;
const text = (t) => ({ content: [{ type: "text", text: t }] });
// Turns any error into a message the AI can read and relay.
const tool = (fn) => async (args) => {
  try { return await fn(args); }
  catch (e) { return { isError: true, content: [{ type: "text", text: e.message || String(e) }] }; }
};
const formatOf = (f) => (f === "wav" ? { query: "wav_44100", ext: "wav" } : { query: "mp3_44100_128", ext: "mp3" });

// ---------- the server ----------
const server = new McpServer(
  { name: "resonant", title: "Resonant", version: VERSION },
  { instructions: "Resonant is a voice studio running on the user's own computer. Use list_voices to find a voice_id before speak or create_dialogue (or omit voice_id for the user's default voice). Audio is saved to files whose paths you report to the user. Built-in voices are fast; Qwen3 voices, voice design and cloning can take a minute or more per sentence on a computer without a graphics card, so warn the user before long jobs." },
);

server.registerTool("resonant_status", {
  title: "Resonant status",
  description: "Checks that Resonant is running and reports its version, which models are ready, what this computer can run, and where audio files are saved.",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
}, tool(async () => {
  const h = await getJson("/api/health");
  const s = await getJson("/api/system").catch(() => null);
  const lines = [`Resonant ${h.version} at ${base}`, `Audio is saved to: ${OUTPUT_DIR}`, `Models: ${Object.entries(h.models).map(([k, v]) => `${k} ${v}`).join(", ")}`];
  if (s) lines.push("", "What this computer can run:", ...s.features.map((f) => `- ${f.name}: ${f.level}. ${f.detail}`));
  return text(lines.join("\n"));
}));

server.registerTool("list_voices", {
  title: "List voices",
  description: "Lists the voices available in Resonant, with the voice_id to pass to speak or create_dialogue. Filter by a search word, language code (en, es, fr, ja...), gender, accent or provider.",
  inputSchema: {
    search: z.string().optional().describe("Word to look for in the voice's name or description"),
    language: z.string().optional().describe("Language code, such as en, es, fr, de, ja, zh"),
    gender: z.enum(["female", "male"]).optional(),
    accent: z.string().optional().describe("Such as american, british"),
    provider: z.enum(["local", "qwen", "elevenlabs"]).optional().describe("local = fast built-in voices; qwen = expressive and cloned voices; elevenlabs = the user's ElevenLabs voices"),
    mine_only: z.boolean().optional().describe("Only the voices the user saved to My Voices, including their clones"),
    limit: z.number().int().min(1).max(200).optional().describe("Default 60"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, tool(async ({ search, language, gender, accent, provider, mine_only, limit = 60 }) => {
  const q = new URLSearchParams({ page_size: String(limit) });
  if (search) q.set("search", search);
  if (language) q.set("language", language);
  if (gender) q.set("gender", gender);
  if (accent) q.set("accent", accent);
  if (provider) q.set("provider", provider);
  if (mine_only) q.set("voice_type", "personal");
  const { voices = [], total_count } = await getJson(`/v2/voices?${q}`);
  if (!voices.length) return text("No voices match those filters.");
  const s = await getJson("/api/settings").catch(() => ({}));
  const rows = voices.map((v) => {
    const l = v.labels || {};
    const facts = [v.provider, l.gender, l.accent, l.language].filter(Boolean).join(", ");
    return `- ${v.voice_id}: ${v.name} (${facts})${v.style_instructions ? ", takes style instructions" : ""}${v.voice_id === s.default_voice_id ? " [default]" : ""}`;
  });
  return text(`${voices.length}${total_count > voices.length ? ` of ${total_count}` : ""} voices:\n${rows.join("\n")}`);
}));

server.registerTool("speak", {
  title: "Text to speech",
  description: "Turns text into speech with a Resonant voice and saves it as an audio file. Supports tags in the text such as [pause 2s]. Returns the file's path.",
  inputSchema: {
    text: z.string().min(1).max(20000).describe("What to say. Up to 20,000 characters."),
    voice_id: z.string().optional().describe("From list_voices. Omit to use the user's default voice."),
    language: z.string().optional().describe("Language code for voices that speak several languages (Qwen3), such as es or fr"),
    instructions: z.string().max(500).optional().describe("How to say it, for voices that take style instructions: 'whispering', 'excited', 'calm and slow'"),
    speed: z.number().min(0.5).max(2).optional().describe("0.5 to 2; default 1"),
    format: z.enum(["mp3", "wav"]).optional().describe("Default mp3"),
    filename: z.string().optional().describe("File name to save as, without folder"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, tool(async ({ text: say, voice_id, language, instructions, speed, format, filename }) => {
  const voice = voice_id || (await getJson("/api/settings")).default_voice_id;
  const f = formatOf(format);
  const body = { text: say };
  if (language) body.language_code = language;
  if (instructions) body.instructions = instructions;
  if (speed) body.voice_settings = { speed };
  const res = await postJson(`/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=${f.query}`, body);
  const file = outputPath(filename, say, f.ext);
  const size = await saveAudio(res, file);
  return text(`Saved ${file} (${kb(size)}, voice ${voice}). It's also in Resonant's History.`);
}));

server.registerTool("create_dialogue", {
  title: "Dialogue",
  description: "Makes one audio file of a conversation: each line in its own voice, with natural gaps between speakers. Good for podcasts, interviews, scenes and explainers with several people.",
  inputSchema: {
    lines: z.array(z.object({
      voice_id: z.string().describe("From list_voices"),
      text: z.string().min(1).max(5000),
      instructions: z.string().max(500).optional().describe("Style for this line, for voices that take instructions"),
    })).min(1).max(300),
    pause_seconds: z.number().min(0).max(3).optional().describe("Gap between lines; default 0.35"),
    format: z.enum(["mp3", "wav"]).optional(),
    filename: z.string().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, tool(async ({ lines, pause_seconds, format, filename }) => {
  const f = formatOf(format);
  const body = { inputs: lines.map((l) => ({ voice_id: l.voice_id, text: l.text, ...(l.instructions ? { instructions: l.instructions } : {}) })) };
  if (pause_seconds != null) body.settings = { pause_seconds };
  const res = await postJson(`/v1/text-to-dialogue?output_format=${f.query}`, body);
  const file = outputPath(filename, lines[0].text, f.ext);
  const size = await saveAudio(res, file);
  return text(`Saved ${file} (${kb(size)}, ${lines.length} lines). It's also in Resonant's History.`);
}));

server.registerTool("transcribe", {
  title: "Speech to text",
  description: "Transcribes a WAV or MP3 file on this computer. Can label who is speaking. Returns the text; with timestamps, each line starts with its time.",
  inputSchema: {
    file_path: z.string().describe("Full path to a .wav or .mp3 file"),
    language: z.string().optional().describe("Language code if known, such as en; otherwise detected"),
    accurate: z.boolean().optional().describe("Use the larger, more accurate model if it's installed (slower)"),
    speakers: z.boolean().optional().describe("Label who is speaking"),
    num_speakers: z.number().int().min(1).max(32).optional(),
    timestamps: z.boolean().optional().describe("Start each line with its time"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, tool(async ({ file_path, language, accurate, speakers, num_speakers, timestamps }) => {
  const audio = readAudio(file_path);
  const form = new FormData();
  form.set("file", new Blob([audio.buffer], { type: audio.type }), audio.name);
  if (accurate) {
    const m = await getJson("/v1/models");
    const ids = (Array.isArray(m) ? m : m.models || []).map((x) => x.model_id);
    if (ids.includes("whisper_large_v3_turbo")) form.set("model_id", "whisper_large_v3_turbo");
  }
  if (language) form.set("language_code", language);
  if (speakers) form.set("diarize", "true");
  if (num_speakers) form.set("num_speakers", String(num_speakers));
  const t = await (await call("/v1/speech-to-text", { method: "POST", body: form })).json();
  if (!speakers && !timestamps) return text(t.text || "(no speech found)");
  // Group words into lines: a new line when the speaker changes or after a long pause.
  const words = (t.words || []).filter((w) => w.type === "word");
  const out = [];
  let cur = null;
  for (const w of words) {
    if (!cur || (speakers && w.speaker_id !== cur.speaker) || w.start - cur.end > 1.2) {
      cur = { speaker: w.speaker_id, start: w.start, end: w.end, words: [] };
      out.push(cur);
    }
    cur.words.push(w.text);
    cur.end = w.end;
  }
  const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  return text(out.map((l) => `${timestamps ? `[${clock(l.start)}] ` : ""}${speakers ? `${l.speaker}: ` : ""}${l.words.join(" ")}`).join("\n") || "(no speech found)");
}));

server.registerTool("sound_effect", {
  title: "Sound effect",
  description: "Makes a sound effect or short ambience from a description, such as 'rain on a tin roof' or 'a door creaking open', and saves it as an audio file.",
  inputSchema: {
    prompt: z.string().min(1).max(450),
    duration_seconds: z.number().min(0.5).max(30).optional().describe("Default 5"),
    loop: z.boolean().optional().describe("Make it loop smoothly"),
    filename: z.string().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, tool(async ({ prompt, duration_seconds, loop, filename }) => {
  const res = await postJson("/v1/sound-generation?output_format=mp3_44100_128", { text: prompt, duration_seconds: duration_seconds ?? 5, ...(loop ? { loop: true } : {}) });
  const file = outputPath(filename, prompt, "mp3");
  const size = await saveAudio(res, file);
  return text(`Saved ${file} (${kb(size)}).`);
}));

server.registerTool("design_voice", {
  title: "Design a voice",
  description: "Creates a new voice from a written description (age, gender, accent, tone, pace) and saves it to the user's voices, returning its voice_id. Also saves a short preview. Needs Resonant's optional Qwen3 models; can take a minute or more without a graphics card.",
  inputSchema: {
    description: z.string().min(10).max(1000).describe("For example: 'A warm Irish woman in her forties, witty and relaxed, telling a story'"),
    name: z.string().min(1).max(100).describe("Name to save the voice under"),
    preview_text: z.string().max(500).optional().describe("What the preview says"),
    language: z.string().optional().describe("Language of the preview, such as English or Spanish"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, tool(async ({ description, name, preview_text, language }) => {
  const d = await (await postJson("/v1/text-to-voice/design?output_format=mp3_44100_128", { voice_description: description, ...(preview_text ? { text: preview_text } : {}), ...(language ? { language } : {}) })).json();
  const preview = d.previews?.[0];
  if (!preview) throw new Error("Resonant didn't return a preview.");
  const file = outputPath(`${name}-preview`, name, "mp3");
  fs.writeFileSync(file, Buffer.from(preview.audio_base_64, "base64"));
  const v = await (await postJson("/v1/text-to-voice", { voice_name: name, generated_voice_id: preview.generated_voice_id, voice_description: description })).json();
  return text(`Created voice "${v.name}" with voice_id ${v.voice_id}. Preview saved to ${file}. Use the voice_id with speak or create_dialogue.`);
}));

server.registerTool("clone_voice", {
  title: "Clone a voice",
  description: "Creates a voice from recordings of a person speaking (WAV or MP3, ideally 10 to 20 seconds of clear speech) and saves it to the user's voices, returning its voice_id. Only clone a voice you have permission to use: your own, or someone who agreed to it.",
  inputSchema: {
    name: z.string().min(1).max(100),
    sample_paths: z.array(z.string()).min(1).max(5).describe("Full paths to the recordings"),
    description: z.string().max(500).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, tool(async ({ name, sample_paths, description }) => {
  const form = new FormData();
  form.set("name", name);
  if (description) form.set("description", description);
  for (const p of sample_paths) { const a = readAudio(p); form.append("files", new Blob([a.buffer], { type: a.type }), a.name); }
  const v = await (await call("/v1/voices/add", { method: "POST", body: form })).json();
  return text(`Created voice "${name}" with voice_id ${v.voice_id}. Use it with speak or create_dialogue.`);
}));

await server.connect(new StdioServerTransport());
console.error(`[resonant-mcp] ${VERSION} ready; audio goes to ${OUTPUT_DIR}`);
